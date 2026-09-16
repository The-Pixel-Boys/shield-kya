import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/commands/hook.js";
import { readTrail } from "../src/trail.js";

const env = () => ({ KYA_HOME: mkdtempSync(join(tmpdir(), "kya-home-")) });
const cwd = () => mkdtempSync(join(tmpdir(), "kya-proj-"));

const claudePayload = (tool: string, input: unknown) => JSON.stringify({
  hook_event_name: "PreToolUse", session_id: "sess-1", cwd: "/p",
  tool_name: tool, tool_input: input,
});

describe("kya hook", () => {
  it("allows an unknown tool: exit 0, no stdout, records REQUIRE_APPROVE row", async () => {
    const e = env();
    const r = await runHook({ host: "claude", strict: false, stdinText: claudePayload("SomeUnknownTool", { x: 1 }), env: e, cwd: cwd() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    const trail = readTrail(cwd(), e);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ toolId: "SomeUnknownTool", verdict: "REQUIRE_APPROVE", sessionId: "sess-1", product: "claude", mode: "offline" });
  });

  it("denies a never-list tool: exit 2, permissionDecision JSON on stdout, reason on stderr", async () => {
    const e = env();
    const r = await runHook({ host: "grok", strict: false, stdinText: claudePayload("org.sample.never.event", {}), env: e, cwd: cwd() });
    expect(r.exitCode).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(r.stderr).toContain("NEVER_EVENT");
    expect(readTrail(cwd(), e)[0]).toMatchObject({ verdict: "DENY", neverEvent: true, product: "grok" });
  });

  it("accepts grok camelCase payloads", async () => {
    const e = env();
    const stdinText = JSON.stringify({ hookEventName: "pre_tool_use", sessionId: "g-1", toolName: "Bash", toolInput: { command: "ls" } });
    const r = await runHook({ host: "grok", strict: false, stdinText, env: e, cwd: cwd() });
    expect(r.exitCode).toBe(0);
    expect(readTrail(cwd(), e)[0]).toMatchObject({ sessionId: "g-1", toolId: "Bash" });
  });

  it("passes through non-PreToolUse events and garbage without recording", async () => {
    const e = env(); const c = cwd();
    expect((await runHook({ host: "kimi", strict: false, stdinText: JSON.stringify({ hook_event_name: "Stop" }), env: e, cwd: c })).exitCode).toBe(0);
    expect((await runHook({ host: "kimi", strict: false, stdinText: "not json at all", env: e, cwd: c })).exitCode).toBe(0);
    expect((await runHook({ host: "kimi", strict: false, stdinText: "", env: e, cwd: c })).exitCode).toBe(0);
    expect(readTrail(c, e)).toEqual([]);
  });

  it("--strict denies REQUIRE_APPROVE verdicts", async () => {
    const e = env();
    const r = await runHook({ host: "claude", strict: true, stdinText: claudePayload("SomeUnknownTool", {}), env: e, cwd: cwd() });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("never throws on evaluator failure (fail-open)", async () => {
    const e = env();
    const r = await runHook({ host: "claude", strict: false, stdinText: claudePayload("Bash", {}), env: e, cwd: cwd(), evaluate: () => { throw new Error("boom"); } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("spawn-level: dist/cli.js hook reads piped stdin, exits 0, records a trail row", () => {
    const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
    expect(existsSync(cliJs), "dist/cli.js missing — run pnpm build first").toBe(true);
    const e = env(); const c = cwd();
    const r = spawnSync(process.execPath, [cliJs, "hook", "--host", "claude"], {
      input: claudePayload("Bash", { command: "ls" }),
      env: { ...process.env, ...e, KYA_SKIP_NODE_CHECK: "1" },
      cwd: c,
      encoding: "utf8",
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(readTrail(c, e)[0]).toMatchObject({ toolId: "Bash", verdict: "REQUIRE_APPROVE", product: "claude" });
  });
});
