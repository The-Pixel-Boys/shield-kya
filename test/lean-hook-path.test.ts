// The hook path must not load the optional embedding runtime or the OpenTelemetry SDK.
// Both factories throw, so a load would also be visible as a failure.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loads = vi.hoisted(() => ({ fastembed: 0, otelSdk: 0 }));

vi.mock("fastembed", () => {
  loads.fastembed++;
  throw new Error("fastembed not installed");
});
vi.mock("@opentelemetry/sdk-metrics", () => {
  loads.otelSdk++;
  throw new Error("OpenTelemetry SDK must not load on the hook path");
});

import { runHook } from "../src/commands/hook.js";

const bashPayload = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "lean-1",
  cwd: "/p",
  tool_name: "Bash",
  tool_input: { command: "ls" },
});
const neverPayload = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "lean-2",
  cwd: "/p",
  tool_name: "org.sample.never.event",
  tool_input: {},
});

describe("hook path without the optional runtimes", () => {
  it("allows a normal Bash call and never loads fastembed or OpenTelemetry", async () => {
    const r = await runHook({
      host: "claude",
      strict: false,
      stdinText: bashPayload,
      env: { KYA_HOME: mkdtempSync(join(tmpdir(), "kya-home-")) },
      cwd: mkdtempSync(join(tmpdir(), "kya-proj-")),
    });
    expect(r.exitCode).toBe(0);
    expect(loads).toEqual({ fastembed: 0, otelSdk: 0 });
  });

  it("still denies a never-list tool with the same verdict", async () => {
    const r = await runHook({
      host: "claude",
      strict: false,
      stdinText: neverPayload,
      env: { KYA_HOME: mkdtempSync(join(tmpdir(), "kya-home-")) },
      cwd: mkdtempSync(join(tmpdir(), "kya-proj-")),
    });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(loads.fastembed).toBe(0);
  });
});
