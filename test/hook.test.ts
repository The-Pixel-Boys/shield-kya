import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, lutimesSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/commands/hook.js";
import { readTrail } from "../src/trail.js";
import { evaluateOffline, matchesNeverList } from "../src/offline-evaluate.js";

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
    expect(trail[0]).toMatchObject({ toolId: "SomeUnknownTool", verdict: "REQUIRE_APPROVE", reasonCode: "UNKNOWN_TOOL", sessionId: "sess-1", product: "claude", mode: "offline" });
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

  it("records a diffPreview for write-like tools so the Changes tab populates", async () => {
    const e = env();
    const r = await runHook({
      host: "kimi", strict: false, env: e, cwd: cwd(),
      stdinText: claudePayload("Write", { file_path: "/p/src/a.ts", content: "export const x = 1;\n" }),
    });
    expect(r.exitCode).toBe(0);
    const row = readTrail(cwd(), e)[0];
    expect(row).toMatchObject({ toolId: "Write", targetPath: "/p/src/a.ts" });
    expect(row.diffPreview).toContain("export const x = 1;");
  });

  it("records an edit hunk preview and never a shell preview", async () => {
    const e = env(); const c = cwd();
    await runHook({
      host: "claude", strict: false, env: e, cwd: c,
      stdinText: claudePayload("Edit", { file_path: "/p/b.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
    });
    await runHook({
      host: "claude", strict: false, env: e, cwd: c,
      stdinText: claudePayload("Bash", { command: "echo hi > /p/c.txt" }),
    });
    const trail = readTrail(c, e);
    expect(trail[0]?.diffPreview).toContain("-const a = 1;");
    expect(trail[0]?.diffPreview).toContain("+const a = 2;");
    expect(trail[1]?.diffPreview).toBeUndefined();
  });

  it("spawn-level: dist/cli.js hook reads piped stdin, exits 0, records a trail row", () => {
    const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
    expect(existsSync(cliJs), "dist/cli.js missing - run pnpm build first").toBe(true);
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
    expect(readTrail(c, e)[0]).toMatchObject({ toolId: "Bash", verdict: "REQUIRE_APPROVE", reasonCode: "SHELL_EXEC", product: "claude" });
  });
});

const withId = (tool: string, id: string | undefined, input: unknown = {}) => JSON.stringify({
  hook_event_name: "PreToolUse", session_id: "sess-1", cwd: "/p",
  tool_name: tool, tool_input: input, ...(id ? { tool_use_id: id } : {}),
});

describe("kya hook --fail-closed", () => {
  const boom = () => { throw new Error("boom"); };

  it("fails open by default and denies (exit 2, deny JSON) with failClosed on a forced internal error", async () => {
    const open = await runHook({ host: "claude", strict: false, stdinText: claudePayload("Bash", {}), env: env(), cwd: cwd(), evaluate: boom });
    expect(open.exitCode).toBe(0);
    const closed = await runHook({ host: "claude", strict: false, failClosed: true, stdinText: claudePayload("Bash", {}), env: env(), cwd: cwd(), evaluate: boom });
    expect(closed.exitCode).toBe(2);
    expect(JSON.parse(closed.stdout).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(closed.stderr).toContain("fail-closed");
  });

  it("denies on evaluate timeout and on an unreadable payload only when failClosed", async () => {
    const hang = () => new Promise<never>(() => {});
    const t = await runHook({ host: "claude", strict: false, failClosed: true, evalTimeoutMs: 20, stdinText: claudePayload("Bash", {}), env: env(), cwd: cwd(), evaluate: hang });
    expect(t.exitCode).toBe(2);
    expect((await runHook({ host: "claude", strict: false, failClosed: true, stdinText: "not json", env: env(), cwd: cwd() })).exitCode).toBe(2);
    expect((await runHook({ host: "claude", strict: false, stdinText: "not json", env: env(), cwd: cwd() })).exitCode).toBe(0);
  });

  it("never-list DENY still exits 2 in both modes; healthy ALLOW still exits 0 in fail-closed", async () => {
    for (const failClosed of [false, true]) {
      const r = await runHook({ host: "claude", strict: false, failClosed, stdinText: claudePayload("org.sample.never.event", {}), env: env(), cwd: cwd() });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("NEVER_EVENT");
    }
    const ok = await runHook({ host: "claude", strict: false, failClosed: true, stdinText: claudePayload("SomeUnknownTool", {}), env: env(), cwd: cwd() });
    expect(ok.exitCode).toBe(0);
  });
});

describe("kya hook tool_use_id dedupe", () => {
  it("same tool_use_id twice: one trail row, same verdict both times, deny still wins", async () => {
    const e = env(); const c = cwd();
    const a = await runHook({ host: "claude", strict: false, stdinText: withId("SomeUnknownTool", "toolu_1"), env: e, cwd: c });
    const b = await runHook({ host: "claude", strict: false, stdinText: withId("SomeUnknownTool", "toolu_1"), env: e, cwd: c });
    expect([a.exitCode, b.exitCode]).toEqual([0, 0]);
    expect([a.firstSeen, b.firstSeen]).toEqual([true, false]);
    expect(readTrail(c, e)).toHaveLength(1);
    const d1 = await runHook({ host: "claude", strict: false, stdinText: withId("org.sample.never.event", "toolu_2"), env: e, cwd: c });
    const d2 = await runHook({ host: "claude", strict: false, stdinText: withId("org.sample.never.event", "toolu_2"), env: e, cwd: c });
    expect([d1.exitCode, d2.exitCode]).toEqual([2, 2]);
    expect(d2.stdout).toBe(d1.stdout);
    expect(readTrail(c, e)).toHaveLength(2);
  });

  it("different ids record twice; missing id records every time (as before)", async () => {
    const e = env(); const c = cwd();
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_a"), env: e, cwd: c });
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_b"), env: e, cwd: c });
    expect(readTrail(c, e)).toHaveLength(2);
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", undefined), env: e, cwd: c });
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", undefined), env: e, cwd: c });
    expect(readTrail(c, e)).toHaveLength(4);
  });

  it("unwritable marker dir: hook still works and records", async () => {
    const e = env(); const c = cwd();
    mkdirSync(join(e.KYA_HOME, ".kya"), { recursive: true });
    writeFileSync(join(e.KYA_HOME, ".kya", "hook-seen"), "a file, not a dir");
    const r = await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_x"), env: e, cwd: c });
    expect(r.exitCode).toBe(0);
    expect(readTrail(c, e)).toHaveLength(1);
  });

  it("prunes markers older than 24 h, never the fresh one", async () => {
    const e = env(); const c = cwd();
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_old"), env: e, cwd: c });
    const dir = join(e.KYA_HOME, ".kya", "hook-seen");
    const [old] = readdirSync(dir).filter((f) => f !== ".pruned");
    const past = new Date(Date.now() - 48 * 3600_000);
    utimesSync(join(dir, old!), past, past);
    utimesSync(join(dir, ".pruned"), past, past);
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_new"), env: e, cwd: c });
    const left = readdirSync(dir).filter((f) => f !== ".pruned");
    expect(left).toHaveLength(1);
    expect(left).not.toContain(old);
  });
});

describe("kya hook hardening (review of #368)", () => {
  const NEVER = claudePayload("mcp__postgres__drop_table", {});

  it("never-list DENY blocks in both modes even when the host config is invalid", async () => {
    for (const failClosed of [false, true]) {
      const e = { ...env(), KYA_HOST: "claude" };
      const r = await runHook({ host: "claude", strict: false, failClosed, stdinText: NEVER, env: e, cwd: cwd() });
      expect(r.exitCode, `failClosed=${failClosed}`).toBe(2);
    }
    // everything else still fails open by default under the same bad config
    const ok = await runHook({ host: "claude", strict: false, stdinText: claudePayload("Read", {}), env: { ...env(), KYA_HOST: "claude" }, cwd: cwd() });
    expect(ok.exitCode).toBe(0);
  });

  it("--fail-closed denies malformed payloads; default and other events are unchanged", async () => {
    const bad = ["{}", JSON.stringify({ hook_event_name: "PreToolUse", tool: "Bash" })];
    for (const stdinText of bad) {
      expect((await runHook({ host: "claude", strict: false, failClosed: true, stdinText, env: env(), cwd: cwd() })).exitCode).toBe(2);
      expect((await runHook({ host: "claude", strict: false, stdinText, env: env(), cwd: cwd() })).exitCode).toBe(0);
    }
    const stop = JSON.stringify({ hook_event_name: "Stop" });
    expect((await runHook({ host: "claude", strict: false, failClosed: true, stdinText: stop, env: env(), cwd: cwd() })).exitCode).toBe(0);
  });

  it("a fail-closed deny leaves an auditable FAIL_CLOSED trail row", async () => {
    const e = env(); const c = cwd();
    const r = await runHook({ host: "claude", strict: false, failClosed: true, stdinText: claudePayload("Bash", {}), env: e, cwd: c, evaluate: () => { throw new Error("boom"); } });
    expect(r.exitCode).toBe(2);
    expect(readTrail(c, e)).toHaveLength(1);
    expect(readTrail(c, e)[0]).toMatchObject({ toolId: "Bash", verdict: "DENY", reasonCode: "FAIL_CLOSED" });
  });

  it("dedupe key includes session_id: same tool_use_id in two sessions records twice", async () => {
    const e = env(); const c = cwd();
    const pl = (sid: string) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: sid, tool_name: "Bash", tool_input: {}, tool_use_id: "1" });
    await runHook({ host: "kimi", strict: false, stdinText: pl("s1"), env: e, cwd: c });
    await runHook({ host: "kimi", strict: false, stdinText: pl("s2"), env: e, cwd: c });
    await runHook({ host: "kimi", strict: false, stdinText: pl("s2"), env: e, cwd: c });
    expect(readTrail(c, e)).toHaveLength(2);
  });

  it("never follows a symlinked hook-seen dir and never deletes non-marker files", async () => {
    const e = env(); const c = cwd();
    const victim = mkdtempSync(join(tmpdir(), "kya-victim-"));
    const past = new Date(Date.now() - 72 * 3600_000);
    const important = join(victim, "important.txt");
    const hexOld = join(victim, "a".repeat(64));
    for (const f of [important, hexOld, join(victim, ".pruned")]) { writeFileSync(f, "x"); utimesSync(f, past, past); }
    mkdirSync(join(e.KYA_HOME, ".kya"), { recursive: true });
    symlinkSync(victim, join(e.KYA_HOME, ".kya", "hook-seen"));
    const r = await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_s"), env: e, cwd: c });
    expect(r.exitCode).toBe(0);
    expect(readTrail(c, e)).toHaveLength(1);
    expect(readdirSync(victim).sort()).toEqual([".pruned", "a".repeat(64), "important.txt"].sort());
    // real dir: old non-marker names survive, old 64-hex markers go
    const e2 = env();
    const dir = join(e2.KYA_HOME, ".kya", "hook-seen");
    mkdirSync(dir, { recursive: true });
    for (const f of ["notes.txt", "b".repeat(64)]) { writeFileSync(join(dir, f), "x"); utimesSync(join(dir, f), past, past); }
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_t"), env: e2, cwd: c });
    const left = readdirSync(dir);
    expect(left).toContain("notes.txt");
    expect(left).not.toContain("b".repeat(64));
  });
});

describe("kya hook --fail-closed spawn e2e (built dist/cli.js)", () => {
  const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
  const spawnHook = (args: string[], stdin: string, extraEnv: Record<string, string> = {}) => {
    const e = env(); const c = cwd();
    const r = spawnSync(process.execPath, [cliJs, "hook", "--host", "claude", ...args], {
      input: stdin, cwd: c, encoding: "utf8",
      env: { ...process.env, ...e, KYA_SKIP_NODE_CHECK: "1", ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout, trail: readTrail(c, e), e, c };
  };
  const NEVER = claudePayload("mcp__postgres__drop_table", {});
  const READ = withId("Read", "toolu_e2e", { file_path: "/p/a.ts" });

  it("healthy ALLOW exits 0 and never-list DENY exits 2 in both modes", () => {
    for (const args of [[], ["--fail-closed"]]) {
      expect(spawnHook(args, READ).status).toBe(0);
      const d = spawnHook(args, NEVER);
      expect(d.status).toBe(2);
      expect(JSON.parse(d.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("forced internal error (KYA_HOST=bogus): default 0, --fail-closed 2 plus audit row", () => {
    expect(spawnHook([], READ, { KYA_HOST: "bogus" }).status).toBe(0);
    const r = spawnHook(["--fail-closed"], READ, { KYA_HOST: "bogus" });
    expect(r.status).toBe(2);
    expect(r.trail[0]).toMatchObject({ reasonCode: "FAIL_CLOSED", verdict: "DENY" });
  });

  it("never-list DENY survives a bad KYA_HOST in both modes", () => {
    for (const args of [[], ["--fail-closed"]]) expect(spawnHook(args, NEVER, { KYA_HOST: "claude" }).status).toBe(2);
  });

  it("flag spellings that parseArgs mangles still mean fail-closed", () => {
    for (const args of [["--fail-closed", "x"], ["--fail-closed=yes"], ["--fail-closed=true"], ["--fail-closed=1"]]) {
      expect(spawnHook(args, "not json").status, args.join(" ")).toBe(2);
    }
    expect(spawnHook([], "not json").status).toBe(0);
    expect(spawnHook(["--fail-closed=false"], "not json").status).toBe(0);
  });

  it("same tool_use_id twice via the CLI records one row and answers the same", () => {
    const e = env(); const c = cwd();
    const run = () => spawnSync(process.execPath, [cliJs, "hook", "--host", "claude", "--fail-closed"], {
      input: READ, cwd: c, encoding: "utf8", env: { ...process.env, ...e, KYA_SKIP_NODE_CHECK: "1" },
    });
    expect([run().status, run().status]).toEqual([0, 0]);
    expect(readTrail(c, e)).toHaveLength(1);
  });
});

describe("kya hook never-list is independent of config and args (re-review of #368)", () => {
  const NEVER_TOOL = "mcp__postgres__drop_table";
  const deep = (n: number) => `{"hook_event_name":"PreToolUse","tool_name":"TOOL","tool_input":${"[".repeat(n)}${"]".repeat(n)}}`;
  const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
  const spawnIn = (c: string, args: string[], stdin: string) => {
    const e = env();
    const r = spawnSync(process.execPath, [cliJs, "hook", "--host", "claude", ...args], {
      input: stdin, cwd: c, encoding: "utf8", env: { ...process.env, ...e, KYA_SKIP_NODE_CHECK: "1" },
    });
    return { status: r.status, stdout: r.stdout, e };
  };

  // Explicit expectations (not just agreement): a drift mutant in the shared rule must fail here.
  const NEVER_TABLE: ReadonlyArray<readonly [string, boolean]> = [
    ["org.sample.never.event", true], ["ORG.SAMPLE.NEVER.EVENT", true], ["  org.sample.never.event  ", true],
    ["mcp__postgres__drop_table", true], ["mcp__postgresql__drop_table", true], ["MCP__POSTGRES__DROP_TABLE", true],
    [" mcp__postgres__drop_table\n", true], ["postgres__drop_table", true], ["postgres.drop_table", true],
    ["postgres/drop_table", true], ["mcp__postgres__truncate_table", true], ["mcp__postgres__purge_old", true],
    ["mcp__postgres__transfer_funds", true], ["mcp__postgres__x_drop_y", true], ["mcp__supabase__drop_table", true],
    ["mcp__fs__purge_cache", true], ["mcp__jira__drop_x", true], ["mcp__n8n__transfer_x", true],
    ["mcp__slack__purge_channel", true], ["mcp__github__transfer_repo", true],
    ["mcp__postgres__delete_rows", false], ["mcp__postgres__read_query", false], ["mcp__postgres__select", false],
    ["mcp__github__delete_branch", false], ["mcp__db__drop_table", false], ["mcp__pg__drop_table", false],
    ["plugin_foo_postgres__drop_table", false], ["mcp__postgres__dr\u200bop_table", false],
    ["mcp__p\u043estgres__drop_table", false], ["\uFF4Dcp__postgres__drop_table", false],
    ["mcp__postgres__drop table", false], ["mcp__postgres__drop_table;", false],
    ["Read", false], ["Bash", false], ["Write", false], ["SomeUnknownTool", false], ["", false], ["   ", false],
    ["org.sample.safe.read", false], ["org.sample.data.write", false], ["org.sample.sandbox.exec", false],
    ["org.sample.sandbox.net_open", false], ["kya.agent.register", false], ["mcp__github__list_issues", false],
  ];

  it("never-list table (>= 40 names): shared rule and the normal evaluator agree with the expectation", () => {
    expect(NEVER_TABLE.length).toBeGreaterThanOrEqual(40);
    for (const [t, expected] of NEVER_TABLE) {
      const v = evaluateOffline({ toolId: t, args: {}, argsHash: "h" } as never);
      expect(matchesNeverList(t), `matchesNeverList(${JSON.stringify(t)})`).toBe(expected);
      expect(v.verdict === "DENY" && v.reasonCode === "NEVER_EVENT", `evaluateOffline(${JSON.stringify(t)})`).toBe(expected);
    }
  });

  it("dual hook with a failing evaluate: never-list rows and notifies are deduped, the verdict never changes", async () => {
    const e = env(); const c = cwd();
    const boom = () => { throw new Error("boom"); };
    const pl = withId(NEVER_TOOL, "toolu_nl");
    const a = await runHook({ host: "claude", strict: false, stdinText: pl, env: e, cwd: c, evaluate: boom });
    const b = await runHook({ host: "claude", strict: false, stdinText: pl, env: e, cwd: c, evaluate: boom });
    expect([a.exitCode, b.exitCode]).toEqual([2, 2]);
    expect(readTrail(c, e)).toHaveLength(1);
    expect(readTrail(c, e)[0]).toMatchObject({ reasonCode: "NEVER_EVENT", neverEvent: true });
    // fail-closed + error + never-list tool is logged as NEVER_EVENT, not FAIL_CLOSED
    const e2 = env(); const c2 = cwd();
    const r = await runHook({ host: "claude", strict: false, failClosed: true, stdinText: claudePayload(NEVER_TOOL, {}), env: e2, cwd: c2, evaluate: boom });
    expect(r.exitCode).toBe(2);
    expect(readTrail(c2, e2)[0]).toMatchObject({ reasonCode: "NEVER_EVENT", neverEvent: true });
  });

  it("fail-closed lets tool-less lifecycle events through (SubagentStart, PermissionRequest, Elicitation)", async () => {
    for (const ev of ["SubagentStart", "PermissionRequest", "Elicitation", "ElicitationResult"]) {
      const r = await runHook({ host: "claude", strict: false, failClosed: true, stdinText: JSON.stringify({ hook_event_name: ev }), env: env(), cwd: cwd() });
      expect(r.exitCode, ev).toBe(0);
    }
  });

  it("repo-shipped .kya/config.json with agentId:123 cannot disable the never-list (spawn e2e)", () => {
    const c = cwd();
    mkdirSync(join(c, ".kya"));
    writeFileSync(join(c, ".kya", "config.json"), JSON.stringify({ agentId: 123 }));
    const d = spawnIn(c, [], claudePayload(NEVER_TOOL, {}));
    expect(d.status).toBe(2);
    expect(JSON.parse(d.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(readTrail(c, d.e)[0]).toMatchObject({ toolId: NEVER_TOOL, verdict: "DENY", neverEvent: true });
    expect(spawnIn(c, [], claudePayload("Read", {})).status).toBe(0); // everything else still fails open
    expect(spawnIn(c, ["--fail-closed"], claudePayload("Read", {})).status).toBe(2);
  });

  it("deeply nested tool_input cannot disable the never-list (spawn e2e)", () => {
    const c = cwd();
    expect(spawnIn(c, [], deep(20000).replace("TOOL", NEVER_TOOL)).status).toBe(2);
    expect(spawnIn(c, [], deep(20000).replace("TOOL", "org.sample.never.event")).status).toBe(2);
    expect(spawnIn(c, [], deep(20000).replace("TOOL", "Read")).status).toBe(0);
    expect(spawnIn(c, ["--fail-closed"], deep(20000).replace("TOOL", "Read")).status).toBe(2);
  });

  it("a side-effect failure after the verdict never loses a DENY", async () => {
    let armed = false;
    const e = env();
    const hostile = new Proxy(e, { get(t, k) { if (armed) throw new Error("env exploded"); return (t as Record<string | symbol, unknown>)[k]; } });
    const r = await runHook({
      host: "claude", strict: false, stdinText: claudePayload("Bash", {}), env: hostile, cwd: cwd(),
      evaluate: async () => { armed = true; return { verdict: "DENY", reasonCode: "NEVER_EVENT", toolId: "Bash" } as never; },
    });
    expect(r.exitCode).toBe(2);
  });

  it("fail-closed deny is not swallowed by the dedupe claim (dual hook: ALLOW row, then FAIL_CLOSED row)", async () => {
    const e = env(); const c = cwd();
    const pl = withId("Bash", "toolu_dual");
    expect((await runHook({ host: "claude", strict: false, stdinText: pl, env: e, cwd: c })).exitCode).toBe(0);
    const r = await runHook({ host: "claude", strict: false, failClosed: true, stdinText: pl, env: e, cwd: c, evaluate: () => { throw new Error("boom"); } });
    expect(r.exitCode).toBe(2);
    expect(readTrail(c, e).map((x) => x.reasonCode)).toEqual(["SHELL_EXEC", "FAIL_CLOSED"]);
  });

  it("dedupe key cannot collide through the separator", async () => {
    const e = env(); const c = cwd();
    const pl = (sid: string, id: string) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: sid, tool_name: "Bash", tool_input: {}, tool_use_id: id });
    await runHook({ host: "kimi", strict: false, stdinText: pl("a:b", "c"), env: e, cwd: c });
    await runHook({ host: "kimi", strict: false, stdinText: pl("a", "b:c"), env: e, cwd: c });
    expect(readTrail(c, e)).toHaveLength(2);
  });

  it("fail-closed evaluates unrecognized or renamed event names that carry a tool_name", async () => {
    const mk = (event: string, tool: string) => JSON.stringify({ hook_event_name: event, tool_name: tool, tool_input: {} });
    const fc = (event: string, tool: string) => runHook({ host: "claude", strict: false, failClosed: true, stdinText: mk(event, tool), env: env(), cwd: cwd() });
    expect((await fc("pre-tool-use", NEVER_TOOL)).exitCode).toBe(2);
    expect((await fc("SomeFutureEvent", NEVER_TOOL)).exitCode).toBe(2);
    expect((await fc("SomeFutureEvent", "Read")).exitCode).toBe(0);
    expect((await fc("PostToolUse", NEVER_TOOL)).exitCode).toBe(0);
    expect((await fc("Stop", "Bash")).exitCode).toBe(0);
    // default mode keeps ignoring other events
    expect((await runHook({ host: "claude", strict: false, stdinText: mk("SomeFutureEvent", NEVER_TOOL), env: env(), cwd: cwd() })).exitCode).toBe(0);
  });

  it("prune never writes through a .pruned symlink nor unlinks old marker-named symlinks", async () => {
    const e = env(); const c = cwd();
    const victim = mkdtempSync(join(tmpdir(), "kya-victim-"));
    const past = new Date(Date.now() - 72 * 3600_000);
    const target = join(victim, "target.txt");
    writeFileSync(target, "keep"); utimesSync(target, past, past);
    const dir = join(e.KYA_HOME, ".kya", "hook-seen");
    mkdirSync(dir, { recursive: true });
    symlinkSync(target, join(dir, ".pruned"));
    lutimesSync(join(dir, ".pruned"), past, past);
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_p"), env: e, cwd: c });
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("prune leaves old marker-named symlinks alone (only regular files are unlinked)", async () => {
    const e = env(); const c = cwd();
    const victim = mkdtempSync(join(tmpdir(), "kya-victim-"));
    const past = new Date(Date.now() - 72 * 3600_000);
    const target = join(victim, "target.txt");
    writeFileSync(target, "keep");
    const dir = join(e.KYA_HOME, ".kya", "hook-seen");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".pruned"), ""); utimesSync(join(dir, ".pruned"), past, past);
    const link = join(dir, "c".repeat(64));
    symlinkSync(target, link);
    lutimesSync(link, past, past);
    await runHook({ host: "claude", strict: false, stdinText: withId("Bash", "toolu_q"), env: e, cwd: c });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
