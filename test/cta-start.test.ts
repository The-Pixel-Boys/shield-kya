// F4: `kya start` prints the share line only when the trail has 10 or more events, on a terminal, once a day.
// In process (the CTA needs a terminal, which a spawned child in a test does not have): runCli with io.isTty,
// a temp KYA_HOME and a temp project. Every report server that `kya start` leaves is stopped in afterEach.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { CTA_LINES, START_SHARE_MIN_EVENTS } from "../src/cta.js";

const dirs: string[] = [];
const projects: { cwd: string; env: NodeJS.ProcessEnv }[] = [];

afterEach(async () => {
  for (const p of projects.splice(0)) await runCli(["stop"], io(false).io, p.env, p.cwd);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function io(isTty: boolean): { io: CliIo; logs: string[] } {
  const logs: string[] = [];
  return { io: { log: (m) => logs.push(m), error: () => {}, exit: () => {}, isTty }, logs };
}

/** A project with `events` trail rows in the temp KYA_HOME (the per-test home from test/setup.ts). */
function project(events: number): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = mkdtempSync(join(tmpdir(), "kya-cta-start-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".git"));
  const home = process.env.KYA_HOME!;
  mkdirSync(join(home, ".kya"), { recursive: true });
  writeFileSync(join(home, ".kya", "trail.jsonl"), "");
  for (let i = 0; i < events; i++) {
    appendFileSync(
      join(home, ".kya", "trail.jsonl"),
      `${JSON.stringify({ ts: new Date(Date.now() - i * 1000).toISOString(), sessionId: "s1", toolId: "Read", verdict: "ALLOW", reasonCode: "LOW_RISK_READ", mode: "hold" })}\n`,
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KYA_HOME: home,
    KYA_NO_BROWSER: "1",
    KYA_SKIP_NODE_CHECK: "1",
    KYA_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    KYA_SEMANTIC: "off",
    KYA_ALERTS: "off",
    KYA_OFFLINE: "1",
  };
  for (const k of ["CI", "KYA_YES", "GITHUB_ACTIONS", "KYA_QUIET", "KYA_CTA"]) delete env[k];
  const p = { cwd, env };
  projects.push(p);
  return p;
}

const START = ["start", "--yes", "--no-gate"];

describe("kya start share line", () => {
  it("prints after start once the trail has 10 events", async () => {
    expect(START_SHARE_MIN_EVENTS).toBe(10);
    const p = project(10);
    const t = io(true);
    expect(await runCli(START, t.io, p.env, p.cwd)).toBe(0);
    expect(t.logs.join("\n")).toContain(CTA_LINES["start-share"]);
  });

  it("does not print with 9 events", async () => {
    const p = project(9);
    const t = io(true);
    expect(await runCli(START, t.io, p.env, p.cwd)).toBe(0);
    expect(t.logs.join("\n")).not.toContain("kya receipt --share for a link");
  });

  it("does not print when stdout is not a terminal, in CI, with KYA_QUIET or with KYA_CTA=off", async () => {
    for (const [extra, tty] of [[{}, false], [{ CI: "true" }, true], [{ KYA_QUIET: "1" }, true], [{ KYA_CTA: "off" }, true]] as const) {
      const p = project(12);
      const t = io(tty);
      await runCli(START, t.io, { ...p.env, ...extra }, p.cwd);
      expect(t.logs.join("\n"), JSON.stringify(extra)).not.toContain("kya receipt --share for a link");
    }
  });

  it("does not print under --json", async () => {
    const p = project(12);
    const t = io(true);
    await runCli([...START, "--json"], t.io, p.env, p.cwd);
    expect(t.logs.join("\n")).not.toContain("kya receipt --share for a link");
  });

  it("prints once a day: the second start on the same day is silent", async () => {
    const p = project(12);
    const first = io(true);
    await runCli(START, first.io, p.env, p.cwd);
    expect(first.logs.join("\n")).toContain(CTA_LINES["start-share"]);
    const second = io(true);
    await runCli(START, second.io, p.env, p.cwd);
    expect(second.logs.join("\n")).not.toContain("kya receipt --share for a link");
  });
});
