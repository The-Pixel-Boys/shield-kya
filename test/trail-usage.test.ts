import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runHook } from "../src/commands/hook.js";
import { appendTrail, globalTrailPath, readTrail } from "../src/trail.js";

const env = () => ({ KYA_HOME: mkdtempSync(join(tmpdir(), "kya-usage-home-")) });
const cwd = () => mkdtempSync(join(tmpdir(), "kya-usage-proj-"));

describe("trail usage schema", () => {
  it("round-trips latencyMs/tokensIn/tokensOut through append and read", () => {
    const e = env();
    const c = cwd();
    appendTrail(c, {
      ts: new Date().toISOString(),
      sessionId: "s1",
      toolId: "Bash",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "offline",
      latencyMs: 12,
      tokensIn: 321,
      tokensOut: 45,
    }, e);
    const [row] = readTrail(c, e);
    expect(row).toMatchObject({ latencyMs: 12, tokensIn: 321, tokensOut: 45 });
    rmSync(e.KYA_HOME!, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
  });

  it("old trail lines without usage fields parse unchanged", () => {
    const e = env();
    const c = cwd();
    const oldLine = JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "old-1",
      host: "ide",
      toolId: "Read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
    });
    mkdirSync(dirname(globalTrailPath(e)), { recursive: true });
    appendFileSync(globalTrailPath(e), `${oldLine}\n`, "utf8");
    const [row] = readTrail(c, e);
    expect(row).toMatchObject({ sessionId: "old-1", toolId: "Read", verdict: "ALLOW" });
    expect(row!.latencyMs).toBeUndefined();
    expect(row!.tokensIn).toBeUndefined();
    expect(row!.tokensOut).toBeUndefined();
    rmSync(e.KYA_HOME!, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
  });

  it("drops malformed usage fields but keeps the line", () => {
    const e = env();
    const c = cwd();
    const bad = JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "bad-1",
      toolId: "Read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
      latencyMs: "fast",
      tokensIn: -5,
      tokensOut: Number.NaN,
    });
    mkdirSync(dirname(globalTrailPath(e)), { recursive: true });
    appendFileSync(globalTrailPath(e), `${bad}\n`, "utf8");
    const rows = readTrail(c, e);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latencyMs).toBeUndefined();
    expect(rows[0]!.tokensIn).toBeUndefined();
    expect(rows[0]!.tokensOut).toBeUndefined();
    rmSync(e.KYA_HOME!, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
  });
});

describe("hook usage capture", () => {
  it("records tokensIn/tokensOut from payload.usage (snake_case)", async () => {
    const e = env();
    const c = cwd();
    const stdinText = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "sess-u1",
      cwd: "/p",
      tool_name: "SomeUnknownTool",
      tool_input: {},
      usage: { input_tokens: 1500, output_tokens: 320 },
    });
    const r = await runHook({ host: "claude", strict: false, stdinText, env: e, cwd: c });
    expect(r.exitCode).toBe(0);
    const [row] = readTrail(c, e);
    expect(row).toMatchObject({ tokensIn: 1500, tokensOut: 320 });
  });

  it("records usage from tool_response.usage (camelCase counts)", async () => {
    const e = env();
    const c = cwd();
    const stdinText = JSON.stringify({
      hookEventName: "pre_tool_use",
      sessionId: "sess-u2",
      toolName: "SomeUnknownTool",
      toolInput: {},
      tool_response: { usage: { inputTokens: 42, outputTokens: 7 } },
    });
    const r = await runHook({ host: "grok", strict: false, stdinText, env: e, cwd: c });
    expect(r.exitCode).toBe(0);
    const [row] = readTrail(c, e);
    expect(row).toMatchObject({ tokensIn: 42, tokensOut: 7 });
  });

  it("omits usage fields when the host reports none (no fabrication)", async () => {
    const e = env();
    const c = cwd();
    const stdinText = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "sess-u3",
      tool_name: "SomeUnknownTool",
      tool_input: {},
    });
    const r = await runHook({ host: "claude", strict: false, stdinText, env: e, cwd: c });
    expect(r.exitCode).toBe(0);
    const [row] = readTrail(c, e);
    expect(row).toBeDefined();
    expect(row!.tokensIn).toBeUndefined();
    expect(row!.tokensOut).toBeUndefined();
  });

  it("ignores malformed usage shapes without breaking the gate", async () => {
    const e = env();
    const c = cwd();
    const stdinText = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "sess-u4",
      tool_name: "SomeUnknownTool",
      tool_input: {},
      usage: { input_tokens: "lots", output_tokens: -1 },
    });
    const r = await runHook({ host: "claude", strict: false, stdinText, env: e, cwd: c });
    expect(r.exitCode).toBe(0);
    const [row] = readTrail(c, e);
    expect(row).toBeDefined();
    expect(row!.tokensIn).toBeUndefined();
    expect(row!.tokensOut).toBeUndefined();
  });
});
