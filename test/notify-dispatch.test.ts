/**
 * Wiring gates: the detached notify/OTLP dispatch spawns only when a sink is
 * configured AND the verdict is notify-worthy, and never throws otherwise.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  maybeSpawnNotifyFlush,
  notifyDispatchEnabled,
} from "../src/notify/dispatch.js";
import type { TrailEvent } from "../src/trail.js";

const home = () => mkdtempSync(join(tmpdir(), "kya-notify-dispatch-"));
const cwdOf = () => mkdtempSync(join(tmpdir(), "kya-notify-proj-"));

const denyEvent: TrailEvent = {
  ts: new Date().toISOString(),
  sessionId: "s1",
  host: "ide",
  toolId: "Bash",
  verdict: "DENY",
  reasonCode: "NEVER_EVENT",
  mode: "offline",
};

function fakeSpawn(): { impl: typeof spawn; calls: string[][] } {
  const calls: string[][] = [];
  const impl = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { on: () => undefined, unref: () => undefined };
  }) as unknown as typeof spawn;
  return { impl, calls };
}

describe("notifyDispatchEnabled", () => {
  it("is false with no config anywhere", () => {
    const env = { KYA_HOME: home() };
    expect(notifyDispatchEnabled(env, cwdOf())).toBe(false);
  });

  it("is true with KYA_NOTIFY_WEBHOOK or KYA_OTLP_EXPORT_ENDPOINT", () => {
    expect(notifyDispatchEnabled({ KYA_HOME: home(), KYA_NOTIFY_WEBHOOK: "https://x.test/h" }, cwdOf())).toBe(true);
    expect(notifyDispatchEnabled({ KYA_HOME: home(), KYA_OTLP_EXPORT_ENDPOINT: "http://127.0.0.1:4318" }, cwdOf())).toBe(true);
  });

  it("is true from config.json keys (global and project)", () => {
    const globalHome = home();
    mkdirSync(join(globalHome, ".kya"), { recursive: true });
    writeFileSync(
      join(globalHome, ".kya", "config.json"),
      JSON.stringify({ notify: { webhooks: [{ url: "https://x.test/h" }] } }),
    );
    expect(notifyDispatchEnabled({ KYA_HOME: globalHome }, cwdOf())).toBe(true);

    const project = cwdOf();
    mkdirSync(join(project, ".kya"), { recursive: true });
    writeFileSync(
      join(project, ".kya", "config.json"),
      JSON.stringify({ otlpExport: { endpoint: "http://127.0.0.1:4318" } }),
    );
    expect(notifyDispatchEnabled({ KYA_HOME: home() }, project)).toBe(true);
  });
});

describe("maybeSpawnNotifyFlush", () => {
  it("does not spawn for ALLOW verdicts even when configured", () => {
    const { impl, calls } = fakeSpawn();
    const spawned = maybeSpawnNotifyFlush({
      env: { KYA_HOME: home(), KYA_NOTIFY_WEBHOOK: "https://x.test/h" },
      cwd: cwdOf(),
      event: { ...denyEvent, verdict: "ALLOW", reasonCode: "ALLOW" },
      entry: "/fake/cli.js",
      spawnImpl: impl,
    });
    expect(spawned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("spawns detached notify-flush with KYA_NOTIFY_EVENT for DENY when configured", () => {
    const { impl, calls } = fakeSpawn();
    const spawned = maybeSpawnNotifyFlush({
      env: { KYA_HOME: home(), KYA_NOTIFY_WEBHOOK: "https://x.test/h" },
      cwd: cwdOf(),
      event: denyEvent,
      entry: "/fake/cli.js",
      spawnImpl: impl,
    });
    expect(spawned).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(1)).toEqual(["/fake/cli.js", "notify-flush"]);
  });

  it("does not spawn for DENY when nothing is configured", () => {
    const { impl, calls } = fakeSpawn();
    const spawned = maybeSpawnNotifyFlush({
      env: { KYA_HOME: home() },
      cwd: cwdOf(),
      event: denyEvent,
      entry: "/fake/cli.js",
      spawnImpl: impl,
    });
    expect(spawned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never throws on garbage input", () => {
    expect(
      maybeSpawnNotifyFlush({
        env: {},
        cwd: "/nonexistent",
        event: {} as TrailEvent,
        entry: "/fake/cli.js",
      }),
    ).toBe(false);
  });
});
