import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../src/cli.js";
import { resolveConfig } from "../src/config.js";
import { runConnect } from "../src/commands/connect.js";
import { runHook } from "../src/commands/hook.js";
import { runWrapCommand, shellJoin, wrapCommandFromArgs } from "../src/commands/wrap.js";
import {
  celAllowRule,
  DESTRUCTIVE_PATTERN,
  DESTRUCTIVE_PREFIX_PATTERN,
  DESTRUCTIVE_SAFE_PATTERN,
  gatewayDenies,
} from "../src/gate/config-gen.js";
import { UsageError } from "../src/errors.js";
import { neverListInputMatch } from "../src/never-list-input.js";
import { parseArgs } from "../src/parse-args.js";

const H = "/Users/it";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const rule = (command: string, cwd?: string) => neverListInputMatch("Bash", { command }, H, cwd)?.rule;

describe("rm with a relative path above the project root", () => {
  const CWD = "/work/a/b/proj";

  it.each(["rm -rf ../../*", "rm -rf ../..", "rm -rf ..", "rm -rf ../*", "rm -rf ../../", "rm -rf ../../.*", "sudo rm -rf ../../*", "bash -c 'rm -rf ../../*'", "rm -rf ./../../*"])(
    "denies %s",
    (cmd) => {
      expect(rule(cmd, CWD)).toBe("rm-recursive-home-or-system");
    },
  );

  it("denies a traversal that reaches the home folder, as `rm -rf ~` is", () => {
    expect(rule("rm -rf ../../*", "/Users/it/dev/proj")).toBe("rm-recursive-home-or-system");
    expect(rule("rm -rf ~", "/Users/it/dev/proj")).toBe("rm-recursive-home-or-system");
  });

  it.each(["rm -rf ../../..", "find ../.. -delete", "find .. -exec rm {} \\;"])("denies %s (find, deeper)", (cmd) => {
    expect(rule(cmd, CWD)).toBeDefined();
  });

  it("denies chmod -R 777 on a parent", () => {
    expect(rule("chmod -R 777 ..", CWD)).toBe("chmod-chown-recursive-root");
  });

  it.each([
    "rm -rf node_modules", "rm -rf ./*", "rm -rf *", "rm -rf .", "rm -rf ./build", "rm -rf ../sibling", "rm -rf ../../x/y",
    "rm -rf build/../dist", "rm -rf ../*.log", "rm -rf ../../*.tmp",
  ])("allows %s", (cmd) => {
    expect(rule(cmd, CWD)).toBeUndefined();
  });

  it("fails open when the working directory is unknown or not absolute", () => {
    expect(rule("rm -rf ../../*")).toBeUndefined();
    expect(rule("rm -rf ../../*", "relative/dir")).toBeUndefined();
  });

  it("the hook reads payload.cwd", async () => {
    const e = { KYA_HOME: tmp("kya-home-") };
    const payload = (command: string) =>
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: CWD, tool_name: "Bash", tool_input: { command } });
    const denied = await runHook({ host: "claude", strict: false, stdinText: payload("rm -rf ../../*"), env: e, cwd: tmp("kya-proj-") });
    expect(denied.exitCode).toBe(2);
    expect(denied.stderr).toContain("rm-recursive-home-or-system");
    const allowed = await runHook({ host: "claude", strict: false, stdinText: payload("rm -rf ../sibling"), env: e, cwd: tmp("kya-proj-") });
    expect(allowed.exitCode).toBe(0);
  });
});

describe("fork bomb inside a shell wrapper", () => {
  it.each([
    ":(){ :|:& };:",
    "bash -c ':(){ :|:& };:'",
    "sh -c ':(){ :|:& };:'",
    'bash -c ":(){ :|:& };:"',
    "eval ':(){ :|:& };:'",
    "eval ':(){ :|:& };:'; echo done",
    "sudo bash -c ':(){ :|:& };:'",
    "sudo -E sh -c 'f(){ f|f& };f'",
    "bash -c 'bomb(){ bomb|bomb& };bomb'",
    "function g { g|g& }",
    "function g { g | g & }; g",
    "function g() { g|g& }; g",
    "bash -c 'function g { g|g& }; g'",
    "zsh -c 'function g { g|g& }; g'",
    "ksh -c 'function g { g|g& }; g'",
    "env bash -c ':(){ :|:& };:'",
  ])("denies %s", (cmd) => {
    expect(rule(cmd)).toBe("fork-bomb");
  });

  it.each([
    "bash -c 'echo hi | cat &'",
    "sh -c 'f(){ echo a; }; f'",
    "function g { echo hi; }",
    "function g { g; }",
    "bash -c 'function g { g | cat; }'",
    "echo ':(){ x }'",
  ])("allows %s", (cmd) => {
    expect(rule(cmd)).not.toBe("fork-bomb");
  });
});

describe("gateway destructive-name pattern", () => {
  const DENY = [
    "drop_table", "drop-table", "dropTable", "DropTable", "DROP_TABLE", "truncate-table", "truncateTable", "TruncateTable",
    "purge-cache", "purgeCache", "PurgeCache", "purge_cache", "transfer_funds", "transfer-funds", "transferFunds", "TransferFunds",
    "do_drop_x", "db.drop.table", "dropIfExists", "drop_all", "drop", "Drop", "DROP", "myDropTable", "drop_database", "run-DROP-now",
    "drag_and_drop_table", "transfer_learn_then_transfer_funds",
    // the prefix word of the exception must not be a destructive verb
    "drop_drag_and_drop", "purge_transfer_learning", "dropDragAndDrop", "DropDragAndDrop", "truncate-drag-and-drop", "transfer_transfer_learn",
    "DROP_DRAG_AND_DROP",
    // Pinned decision: a camelCase edge or a digit is a word edge, so these now refuse (they passed before).
    "dropDown_select", "selectDropDown", "drop2",
  ];
  const ALLOW = [
    "drag_and_drop", "appium_drag_and_drop", "drag-and-drop", "dragAndDrop", "DragAndDrop", "appiumDragAndDrop", "DRAG_AND_DROP",
    "transfer_learn", "transfer_learning", "transferLearning", "transfer-learn", "TRANSFER_LEARNING",
    "dropdown_select", "droplet_info", "drops", "transferable_list", "purgeable_get", "dropbox_read", "Dropdown", "dropout_rate",
    "get_dropdown", "list_tables", "read_file",
  ];

  it.each(DENY)("refuses %s", (name) => {
    expect(gatewayDenies("totally-unknown", name), name).toBe(true);
  });

  it.each(ALLOW)("allows %s", (name) => {
    expect(gatewayDenies("totally-unknown", name), name).toBe(false);
  });

  it("the family regex alone matches the same verbs in every case form", () => {
    const re = new RegExp(DESTRUCTIVE_PATTERN);
    for (const n of ["drop-table", "dropTable", "DropTable", "truncate-table", "purge-cache"]) expect(re.test(n), n).toBe(true);
    // the exception is exact: a prefix word at most, nothing after
    const safe = new RegExp(DESTRUCTIVE_SAFE_PATTERN);
    expect(safe.test("drag_and_drop_table")).toBe(false);
    expect(safe.test("a_b_drag_and_drop")).toBe(false);
    expect(safe.test("appium_transfer_learn")).toBe(false);
  });

  it("the exception never lifts a server's ADMIN rules", () => {
    // postgresql ADMIN rule is a bare substring: (?:drop|truncate|purge)
    expect(gatewayDenies("postgresql", "drag_and_drop")).toBe(true);
    expect(gatewayDenies("postgresql", "transfer_learn")).toBe(false);
  });

  it("the CEL rule carries both patterns and keeps the ADMIN deny outside the exception", () => {
    const rule = celAllowRule({ id: "postgresql", transport: "stdio", cmd: ["x"] });
    expect(rule).toContain(`!mcp.tool.name.matches('${DESTRUCTIVE_PATTERN}')`);
    expect(rule).toContain(`mcp.tool.name.matches('${DESTRUCTIVE_SAFE_PATTERN}') && !mcp.tool.name.matches('${DESTRUCTIVE_PREFIX_PATTERN}')`);
    expect(rule).toMatch(/\) && !mcp\.tool\.name\.matches\('\(\?:drop\|truncate\|purge\)'\)$/);
    const unknown = celAllowRule({ id: "totally-unknown", transport: "stdio", cmd: ["x"] });
    expect(unknown.endsWith("))")).toBe(true);
    expect(unknown).not.toContain("&& !mcp.tool.name.matches('(?:drop");
  });
});

describe("Copilot CLI camelCase preToolUse payload (toolArgs as a JSON string)", () => {
  const payload = (toolArgs: unknown) =>
    JSON.stringify({ timestamp: 1700000000000, cwd: "/work/a/b/proj", toolName: "bash", toolArgs });
  const run = (stdinText: string) =>
    runHook({ host: "copilot", strict: false, stdinText, env: { KYA_HOME: tmp("kya-home-") }, cwd: tmp("kya-proj-") });

  it("applies the input rules", async () => {
    const r = await run(payload(JSON.stringify({ command: "rm -rf ~" })));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("NEVER_EVENT");
  });

  it("applies the input rules to a relative traversal with the payload cwd", async () => {
    expect((await run(payload(JSON.stringify({ command: "rm -rf ../../*" })))).exitCode).toBe(2);
  });

  it("applies the secret-read rule", async () => {
    expect((await run(payload(JSON.stringify({ command: "cat ~/.ssh/id_rsa" })))).exitCode).toBe(2);
  });

  it("matches the PascalCase form", async () => {
    const pascal = JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/p", tool_name: "bash", tool_input: { command: "rm -rf ~" } });
    expect((await run(pascal)).exitCode).toBe(2);
  });

  it("fails open on a benign command, bad JSON, or a non-string/oversized value", async () => {
    expect((await run(payload(JSON.stringify({ command: "ls" })))).exitCode).toBe(0);
    expect((await run(payload("{not json"))).exitCode).toBe(0);
    expect((await run(payload(123))).exitCode).toBe(0);
    // no size cap: padding must not turn a denied command into an allow
    const pad = "a".repeat(2 << 20);
    expect((await run(payload(JSON.stringify({ command: `ls ${pad}` })))).exitCode).toBe(0);
    expect((await run(payload(JSON.stringify({ command: `rm -rf ~; echo ${pad}` })))).exitCode).toBe(2);
    expect((await run(payload(JSON.stringify({ command: `echo ${pad}; rm -rf ~` })))).exitCode).toBe(2);
  });
});

describe("kya wrap -- <cmd>", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliIo = { log: (m) => out.push(m), error: (m) => err.push(m), exit: () => undefined };
    return { out, err, cli };
  };
  const env = () => ({ KYA_HOME: tmp("kya-home-"), KYA_RECEIPT_AUTO: "0" });
  const node = process.execPath;

  it("parseArgs keeps the tokens after `--` as rest, flags before it intact", () => {
    const p = parseArgs(["wrap", "--offline", "--", "echo", "-n", "hi"]);
    expect(p.rest).toEqual(["echo", "-n", "hi"]);
    expect(p.flags["offline"]).toBe(true);
    expect(parseArgs(["wrap", "--tool-id", "x"]).rest).toBeUndefined();
    expect(wrapCommandFromArgs(parseArgs(["wrap", "--tool-id", "x"]))).toBeUndefined();
    expect(() => wrapCommandFromArgs(parseArgs(["wrap", "--"]))).toThrow(UsageError);
  });

  it("shellJoin quotes so the text re-parses to the same words", () => {
    expect(shellJoin(["echo", "hi"])).toBe("echo hi");
    expect(shellJoin(["echo", "a b", "it's", ""])).toBe("echo 'a b' 'it'\\''s' ''");
  });

  it("`kya wrap --offline -- echo hi` runs and exits 0", async () => {
    const { err, cli } = io();
    const code = await runCli(["wrap", "--offline", "--", "echo", "hi"], cli, env(), tmp("kya-proj-"));
    expect(code).toBe(0);
    const text = err.join("\n");
    expect(text).toMatch(/verdict: /);
    expect(text).toMatch(/sideEffect: executed/);
    expect(text.match(/View activity/g)?.length).toBe(1);
  });

  it("`kya wrap -- echo hi` with no key and no --offline gates locally, runs and exits 0", async () => {
    const { err, cli } = io();
    const code = await runCli(["wrap", "--", "echo", "hi"], cli, env(), tmp("kya-proj-"));
    expect(code).toBe(0);
    expect(err.join("\n")).toMatch(/mode: offline-sample/);
  });

  it("no key and a never-list command: still denied, not run", async () => {
    const { cli } = io();
    expect(await runCli(["wrap", "--", "sh", "-c", "cat .env"], cli, env(), tmp("kya-proj-"))).toBe(1);
  });

  it("the built CLI runs `wrap -- echo hi` (exit 0) and denies a never-list command (exit 1)", () => {
    const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [cliJs, ...args], {
        encoding: "utf8",
        cwd: tmp("kya-proj-"),
        env: { PATH: process.env.PATH ?? "", KYA_HOME: tmp("kya-home-"), KYA_RECEIPT_AUTO: "0", KYA_TELEMETRY: "0", KYA_UPDATE_CHECK: "0" },
      });
    const ok = run(["wrap", "--", "echo", "hi"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("hi\n");
    const denied = run(["wrap", "--", "sh", "-c", "cat .env"]);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(/DENY/);
  });

  it("returns the command's own exit code", async () => {
    const { cli } = io();
    expect(await runCli(["wrap", "--offline", "--", node, "-e", "process.exit(7)"], cli, env(), tmp("kya-proj-"))).toBe(7);
  });

  it("runs the command for real (marker file) and passes stdout through the child, not the verdict lines", async () => {
    const dir = tmp("kya-wrap-run-");
    const marker = join(dir, "ran");
    const { out, cli } = io();
    const code = await runCli(
      ["wrap", "--offline", "--", node, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
      cli,
      env(),
      dir,
    );
    expect(code).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(out.join("\n")).not.toMatch(/verdict/);
  });

  it("exits 127 when the command is not found", async () => {
    const { err, cli } = io();
    expect(await runCli(["wrap", "--offline", "--", "kya-no-such-binary-xyz"], cli, env(), tmp("kya-proj-"))).toBe(127);
    expect(err.join("\n")).toMatch(/cannot run kya-no-such-binary-xyz/);
  });

  it("a never-list command is denied (exit 1) and never run", async () => {
    const dir = tmp("kya-wrap-deny-");
    const marker = join(dir, "ran");
    const { err, cli } = io();
    // `.env` read trips secret-read-shell; if the guard failed this would only touch a marker and cat a missing file.
    const code = await runCli(
      ["wrap", "--offline", "--", "sh", "-c", `touch ${marker}; cat .env`],
      cli,
      env(),
      dir,
    );
    expect(code).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(err.join("\n")).toMatch(/DENY/);
    expect(err.join("\n")).toMatch(/sideEffect: blocked/);
  });

  it("runs the local input rules on the online path too (no network needed for a local deny)", async () => {
    const dir = tmp("kya-wrap-online-");
    const marker = join(dir, "ran");
    let ran = false;
    const config = resolveConfig({ cwd: dir, env: env(), flags: {}, allowMissingApiKey: true, requireApiKey: false });
    const r = await runWrapCommand(
      { ...config, offline: false },
      ["sh", "-c", `touch ${marker}; cat .env`],
      {},
      { run: () => { ran = true; return 0; } },
    );
    expect(r.exitCode).toBe(1);
    expect(ran).toBe(false);
    expect(r.wrap.eval.response.ruleId).toBe("secret-read-shell");
    expect(r.wrap.eval.offline).toBe(false);
  });

  it("without `--` the tool-id form still never executes, and prints View activity once", async () => {
    const { out, cli } = io();
    const code = await runCli(["wrap", "--offline", "--tool-id", "org.sample.data.write", "--irreversible"], cli, env(), tmp("kya-proj-"));
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/sideEffect: blocked/);
    expect(out.join("\n").match(/View activity/g)?.length).toBe(1);
  });
});

describe("kya connect --project --hooks", () => {
  const cfg = (cwd: string) => resolveConfig({ cwd, offline: true, allowMissingApiKey: true, flags: { offline: true } });

  it("writes the claude hook to <project>/.claude/settings.json, not the home config", async () => {
    const home = tmp("kya-home-");
    const cwd = tmp("kya-proj-");
    const r = await runConnect(cfg(cwd), { host: "claude", scope: "project", hooks: true }, { KYA_HOME: home });
    expect(r.hooksPath).toBe(join(cwd, ".claude", "settings.json"));
    expect(r.hooksStatus).toBe("created");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    const settings = JSON.parse(readFileSync(r.hooksPath!, "utf8")) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain("hook --host claude");
    // idempotent
    const again = await runConnect(cfg(cwd), { host: "claude", scope: "project", hooks: true }, { KYA_HOME: home });
    expect(again.hooksStatus).toBe("skipped");
  });

  it("the global scope is unchanged", async () => {
    const home = tmp("kya-home-");
    const cwd = tmp("kya-proj-");
    const r = await runConnect(cfg(cwd), { host: "claude", hooks: true }, { KYA_HOME: home });
    expect(r.hooksPath).toBe(join(home, ".claude", "settings.json"));
    expect(existsSync(join(cwd, ".claude", "settings.json"))).toBe(false);
  });

  it("refuses the hosted fail-closed hook at project scope before writing anything", async () => {
    const home = tmp("kya-home-");
    const cwd = tmp("kya-proj-");
    await expect(
      runConnect(cfg(cwd), { host: "claude", scope: "project", hooks: true, hosted: { configPath: join(home, "hosted.json") } }, { KYA_HOME: home }),
    ).rejects.toThrow(/user-level only/);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });

  it("refuses a host that only has user-level hooks before writing anything", async () => {
    const home = tmp("kya-home-");
    const cwd = tmp("kya-proj-");
    await expect(runConnect(cfg(cwd), { host: "kimi", scope: "project", hooks: true }, { KYA_HOME: home })).rejects.toThrow(/claude only/);
    expect(existsSync(join(cwd, ".kimi-code"))).toBe(false);
    expect(existsSync(join(home, ".kimi-code"))).toBe(false);
  });
});
