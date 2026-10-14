/**
 * Gemini CLI extension (root `gemini-extension.json` + `hooks/hooks.json`) and the kya hook's
 * BeforeTool support. Unit tests drive runHook with payloads shaped like Gemini's BeforeToolInput
 * (packages/core/src/hooks/types.ts); the e2e runs hooks.json the way Gemini does (variables
 * hydrated, `bash -c <command>`, handler env merged) and applies Gemini's output rule: stdout (or
 * stderr) JSON is parsed whatever the exit code, exit 0/1 never block, any other code with text
 * blocks (hookRunner.ts convertPlainTextToHookOutput). The e2e needs `tsc` first.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "../src/commands/hook.js";
import { readTrail } from "../src/trail.js";
// @ts-expect-error plain .mjs script, no type declarations
import { findVersionDrift } from "../scripts/check-version-pins.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { syncTree } from "../scripts/lib/version-pins.mjs";

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, any>;
const version = json("package.json").version as string;
const posix = process.platform !== "win32";
const haveDist = existsSync(join(root, "dist/cli.js"));
const tmp = () => mkdtempSync(join(tmpdir(), "kya gemini-"));
const env = () => ({ KYA_HOME: tmp() });

const before = (tool: string, input: unknown, mcp?: { server_name: string; tool_name: string }) =>
  JSON.stringify({
    session_id: "gem-1",
    transcript_path: "/t.json",
    cwd: "/p",
    hook_event_name: "BeforeTool",
    timestamp: "2026-10-13T00:00:00Z",
    tool_name: tool,
    tool_input: input,
    ...(mcp ? { mcp_context: { ...mcp, command: "node", args: ["server.js"] } } : {}),
  });
const pgDrop = () => before("mcp_postgres_drop_table", { table: "users" }, { server_name: "postgres", tool_name: "drop_table" });

/** Gemini's verdict for one hook result (hookRunner.ts + HookOutput.isBlockingDecision). */
function geminiBlocks(exitCode: number, stdout: string, stderr: string): boolean {
  const text = stdout.trim() || stderr.trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed.decision === "deny" || parsed.decision === "block";
  } catch { /* plain text */ }
  return exitCode !== 0 && exitCode !== 1;
}

describe("kya hook: Gemini BeforeTool", () => {
  it("records a BeforeTool shell call as gemini, SHELL_EXEC advisory, silent stdout", async () => {
    const e = env();
    const r = await runHook({ host: "gemini", strict: false, stdinText: before("run_shell_command", { command: "ls" }), env: e, cwd: tmp() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(readTrail(tmp(), e)[0]).toMatchObject({ toolId: "run_shell_command", product: "gemini", verdict: "REQUIRE_APPROVE", reasonCode: "SHELL_EXEC", sessionId: "gem-1" });
  });

  it("Gemini built-in tool names get the host vocabulary tiers", async () => {
    const e = env();
    for (const t of ["read_file", "read_many_files", "list_directory", "write_file", "replace"]) {
      await runHook({ host: "gemini", strict: false, stdinText: before(t, {}), env: e, cwd: tmp() });
    }
    expect(readTrail(tmp(), e).map((x) => x.reasonCode)).toEqual(["LOW_RISK_READ", "LOW_RISK_READ", "LOW_RISK_READ", "HIGH_STAKES_WRITE", "HIGH_STAKES_WRITE"]);
  });

  it("rebuilds mcp__server__tool from mcp_context and blocks the never-list with a Gemini decision", async () => {
    const e = env();
    const r = await runHook({ host: "gemini", strict: false, stdinText: pgDrop(), env: e, cwd: tmp() });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ decision: "deny", reason: "KYA denied mcp__postgres__drop_table: NEVER_EVENT" });
    expect(geminiBlocks(r.exitCode, r.stdout, r.stderr)).toBe(true);
    expect(geminiBlocks(0, r.stdout, r.stderr)).toBe(true); // also under the `; exit 0` wrapper
    expect(readTrail(tmp(), e)[0]).toMatchObject({ toolId: "mcp__postgres__drop_table", verdict: "DENY", neverEvent: true, product: "gemini" });
  });

  it("without mcp_context the single-underscore name is not guessed at (recorded as is)", async () => {
    const e = env();
    const r = await runHook({ host: "gemini", strict: false, stdinText: before("mcp_postgres_drop_table", {}), env: e, cwd: tmp() });
    expect(r.exitCode).toBe(0);
    expect(readTrail(tmp(), e)[0].toolId).toBe("mcp_postgres_drop_table");
  });

  it("the never-list fallback (broken project config) still blocks a Gemini MCP call with a Gemini decision", async () => {
    const proj = tmp();
    mkdirSync(join(proj, ".kya"));
    writeFileSync(join(proj, ".kya/config.json"), '{"agentId": 42, "host": {"x": 1}}');
    const r = await runHook({ host: "gemini", strict: false, stdinText: pgDrop(), env: env(), cwd: proj });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).decision).toBe("deny");
  });

  it("Claude and Codex deny output is unchanged (hookSpecificOutput, no decision field)", async () => {
    const r = await runHook({ host: "codex", strict: false, stdinText: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__postgres__drop_table", tool_input: {} }), env: env(), cwd: tmp() });
    expect(r.stdout).toBe(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "KYA denied mcp__postgres__drop_table: NEVER_EVENT" } })}\n`);
  });

  it.each(["claude", "codex", "other"])("--host %s PreToolUse: tool_name wins over a stray mcp_context, both ways", async (host) => {
    const pre = (tool: string, ctx: { server_name: string; tool_name: string }) =>
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, mcp_context: ctx });
    const nl = await runHook({ host, strict: false, stdinText: pre("mcp__postgres__drop_table", { server_name: "fs", tool_name: "read" }), env: env(), cwd: tmp() });
    expect(nl.exitCode).toBe(2);
    expect(JSON.parse(nl.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const benign = await runHook({ host, strict: false, stdinText: pre("Read", { server_name: "postgres", tool_name: "drop_table" }), env: env(), cwd: tmp() });
    expect(benign.exitCode).toBe(0);
  });

  it("a BeforeTool payload gets the Gemini deny body whatever --host says", async () => {
    const r = await runHook({ host: "other", strict: false, stdinText: pgDrop(), env: env(), cwd: tmp() });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ decision: "deny", reason: "KYA denied mcp__postgres__drop_table: NEVER_EVENT" });
  });

  it("--host gemini without an event name still gets the Gemini deny body", async () => {
    const r = await runHook({ host: "gemini", strict: false, stdinText: JSON.stringify({ tool_name: "mcp__postgres__drop_table", tool_input: {} }), env: env(), cwd: tmp() });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ decision: "deny", reason: "KYA denied mcp__postgres__drop_table: NEVER_EVENT" });
  });

  it("malformed mcp_context and other Gemini events fail open", async () => {
    const e = env();
    for (const stdinText of [
      JSON.stringify({ hook_event_name: "BeforeTool", tool_name: "x", mcp_context: "nope" }),
      JSON.stringify({ hook_event_name: "BeforeTool", tool_name: "x", mcp_context: { server_name: 1, tool_name: [] } }),
      JSON.stringify({ hook_event_name: "BeforeTool", mcp_context: { server_name: "", tool_name: "" } }),
      JSON.stringify({ hook_event_name: "AfterTool", tool_name: "mcp_postgres_drop_table", mcp_context: { server_name: "postgres", tool_name: "drop_table" } }),
      JSON.stringify({ hook_event_name: "BeforeModel" }),
    ]) {
      const r = await runHook({ host: "gemini", strict: false, stdinText, env: e, cwd: tmp() });
      expect(r.exitCode, stdinText).toBe(0);
    }
  });
});

describe("Gemini extension manifest and hooks", () => {
  const hooks = json("hooks/hooks.json").hooks;
  it("manifest: name, version, canonical description, no bundled MCP server", () => {
    const m = json("gemini-extension.json");
    expect(m.name).toBe("shield-kya");
    expect(m.version).toBe(version);
    expect(m.description).toBe(json("channel-copy.json").variants.plugin);
    expect(m).not.toHaveProperty("mcpServers");
  });

  it("handlers: ms timeouts, match-all, forced exit 0 on BeforeTool, data dir via env, no npx", () => {
    const start = hooks.SessionStart[0];
    expect(start).not.toHaveProperty("matcher"); // lifecycle matchers are exact strings in Gemini
    expect(start.hooks[0].command).toBe(`node "\${extensionPath}\${/}plugins\${/}kya\${/}scripts\${/}bootstrap.mjs" @shield-agent/kya@${version}`);
    expect(start.hooks[0].env).toEqual({ CLAUDE_PLUGIN_DATA: "${extensionPath}${/}.kya-runtime" });
    expect(start.hooks[0].timeout).toBeGreaterThanOrEqual(120000);
    const pre = hooks.BeforeTool[0];
    expect(pre.matcher).toBe("*");
    expect(pre.hooks[0].command).toMatch(/ hook --host gemini; exit 0$/);
    expect(pre.hooks[0].timeout).toBe(5000);
    expect(JSON.stringify(hooks)).not.toMatch(/npx|--strict|--fail-closed|--plane-config/);
  });

  it("Cursor (same repo root) reads its own empty hooks file, not the Gemini one", () => {
    const c = json(".cursor-plugin/plugin.json");
    expect(c.hooks).toBe("./.cursor-plugin/hooks.json");
    expect(json(".cursor-plugin/hooks.json")).toEqual({ hooks: {} });
  });

  it("seeded drift in the manifest and the hook pin fails the pin check; sync repairs it", () => {
    const copy = join(mkdtempSync(join(tmpdir(), "kya-gem-pins-")), "sdks/kya");
    cpSync(root, copy, { recursive: true, filter: (src) => !/[\\/](node_modules|dist|coverage|\.git|\.kya-runtime)$/.test(src) });
    expect(findVersionDrift(copy)).toEqual([]);
    for (const rel of ["gemini-extension.json", "hooks/hooks.json"]) writeFileSync(join(copy, rel), readFileSync(join(copy, rel), "utf8").replaceAll(version, "0.0.1"));
    const drift = findVersionDrift(copy).join("\n");
    expect(drift).toContain("gemini-extension.json: version 0.0.1");
    expect(drift).toContain(`hooks/hooks.json: pins @shield-agent/kya${"@"}0.0.1`);
    syncTree(copy, version);
    expect(findVersionDrift(copy)).toEqual([]);
  });
});

describe.skipIf(!posix)("e2e: hooks.json handlers as Gemini runs them", () => {
  /** An extension dir (the package root) whose runtime is the working tree, plus a hydration of hooks.json. */
  function extension(withKya = true) {
    const ext = tmp();
    cpSync(join(root, "plugins"), join(ext, "plugins"), { recursive: true });
    if (withKya) {
      mkdirSync(join(ext, ".kya-runtime/node_modules/@shield-agent"), { recursive: true });
      symlinkSync(root, join(ext, ".kya-runtime/node_modules/@shield-agent/kya"));
    }
    const hydrate = (s: string) => s.replaceAll("${extensionPath}", ext).replaceAll("${/}", sep);
    const handler = (event: string) => {
      const h = json("hooks/hooks.json").hooks[event][0].hooks[0];
      return { command: hydrate(h.command), env: Object.fromEntries(Object.entries((h.env ?? {}) as Record<string, string>).map(([k, v]) => [k, hydrate(v)])) };
    };
    const run = (event: string, stdin: string, extra: Record<string, string> = {}) => {
      const h = handler(event);
      return spawnSync("/bin/bash", ["-c", h.command], { input: stdin, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: tmp(), ...extra, ...h.env } });
    };
    return { ext, run };
  }

  it.skipIf(!haveDist)("shell call recorded and allowed; never-list MCP call blocked by Gemini's rule", () => {
    const { run } = extension();
    const home = tmp();
    const ok = run("BeforeTool", before("run_shell_command", { command: "ls" }), { KYA_HOME: home });
    expect(ok.status).toBe(0);
    expect(geminiBlocks(ok.status ?? -1, ok.stdout, ok.stderr)).toBe(false);
    const no = run("BeforeTool", pgDrop(), { KYA_HOME: home });
    expect(no.status).toBe(0); // forced by `; exit 0`
    expect(geminiBlocks(no.status ?? -1, no.stdout, no.stderr)).toBe(true);
    const rows = readTrail(tmp(), { KYA_HOME: home });
    expect(rows.map((r) => [r.toolId, r.verdict, r.product])).toEqual([["run_shell_command", "REQUIRE_APPROVE", "gemini"], ["mcp__postgres__drop_table", "DENY", "gemini"]]);
  });

  it("kya missing: exit 0, so Gemini only warns (fails open)", () => {
    const { run } = extension(false);
    const r = run("BeforeTool", pgDrop(), { KYA_HOME: tmp() });
    expect(r.status).toBe(0);
    expect(geminiBlocks(r.status ?? -1, r.stdout, r.stderr)).toBe(false);
  });

  it("node missing: without `; exit 0` Gemini would block every tool (127); with it, it does not", () => {
    // Simulated by renaming the interpreter: some hosts re-add PATH entries for child shells.
    const command = json("hooks/hooks.json").hooks.BeforeTool[0].hooks[0].command.replace(/^node /, "kya-no-such-node ").replaceAll("${extensionPath}", "/x").replaceAll("${/}", "/");
    const sh = (c: string) => spawnSync("/bin/bash", ["-c", c], { input: pgDrop(), encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    const raw = sh(command.replace(/; exit 0$/, ""));
    expect(raw.status, raw.stderr).toBe(127);
    expect(geminiBlocks(raw.status ?? -1, raw.stdout, raw.stderr)).toBe(true); // the failure mode the wrapper exists for
    const r = sh(command);
    expect(r.status).toBe(0);
    expect(geminiBlocks(r.status ?? -1, r.stdout, r.stderr)).toBe(false);
  });

  it.skipIf(!haveDist)("SessionStart: bootstrap gets the data dir from the handler env and accepts the real build", () => {
    const { run } = extension();
    const r = run("SessionStart", "{}");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("SessionStart in a clean HOME with no npm: NOT recording message, exit 0", () => {
    const { run } = extension(false);
    const bin = tmp();
    symlinkSync(process.execPath, join(bin, "node"));
    const r = run("SessionStart", "{}", { PATH: bin });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/Shield KYA is NOT recording: npm was not found/);
  });
});
