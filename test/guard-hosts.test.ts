/**
 * Feature kya-plugin-guard-hosts: KYA Guard for Codex, Cursor, Copilot CLI and Gemini CLI, built from one dist/guard.mjs.
 * Static: each host's hook file has the shape that host reads, and the variant folders hold a byte-identical copy of the bundle.
 * E2E: the hook command written in each host's file is run as the host would run it (bash, plugin root set), in a temp HOME and
 * a temp KYA_HOME, with that host's payload on stdin. A deny must come back in that host's shape; the ask rule must become a
 * deny on every host but Claude Code; a bundle that crashes must let the call through.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "../src/commands/hook.js";
// @ts-expect-error plain .mjs script, no type declarations
import { COPIES, VARIANT_DIRS } from "../scripts/build-guard.mjs";

const PKG = join(import.meta.dirname, "..");
const PLUGINS = join(PKG, "plugins");
const json = (...p: string[]): any => JSON.parse(readFileSync(join(PLUGINS, ...p), "utf8"));
const posix = process.platform !== "win32";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function sandbox(): { home: string; proj: string } {
  const base = mkdtempSync(join(tmpdir(), "kya-guard-hosts-"));
  dirs.push(base);
  const home = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(proj, ".git"), { recursive: true });
  return { home, proj };
}

const DENY = "terraform destroy -auto-approve";
const ASK = "prisma migrate reset";
const ALLOW = "ls -la";

interface Host {
  readonly id: "codex" | "cursor" | "copilot" | "gemini";
  readonly folder: string;
  /** The hook command string and the folder it runs from, as the host would expand them. */
  readonly command: (plugin: string) => { cmd: string; cwd: string; env: Record<string, string> };
  readonly payload: (cwd: string, command: string) => string;
  /** The shape of a deny on stdout. */
  readonly denyBody: (stdout: string) => void;
  /** Exit code of the hook command for a deny. Gemini's hook line ends with `exit 0`: the deny travels in the JSON. */
  readonly denyExit: number;
}

const HOSTS: Host[] = [
  {
    id: "codex",
    folder: "kya-guard",
    command: (plugin) => ({ cmd: json("kya-guard", "hooks", "codex-hooks.json").hooks.PreToolUse[0].hooks[0].command, cwd: plugin, env: { PLUGIN_ROOT: plugin } }),
    payload: (cwd, command) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "c1", cwd, tool_name: "Bash", tool_input: { command } }),
    denyBody: (out) => expect(JSON.parse(out).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" }),
    denyExit: 2,
  },
  {
    id: "cursor",
    folder: "kya-guard-cursor",
    command: (plugin) => ({ cmd: json("kya-guard-cursor", "hooks", "hooks.json").hooks.preToolUse[0].command, cwd: plugin, env: {} }),
    payload: (cwd, command) => JSON.stringify({ hook_event_name: "preToolUse", conversation_id: "k1", cwd, tool_name: "Shell", tool_input: { command }, tool_use_id: "t1" }),
    denyBody: (out) => {
      const b = JSON.parse(out);
      expect(b.permission).toBe("deny");
      expect(b.user_message).toContain("KYA denied");
      expect(b.agent_message).toContain("KYA denied");
    },
    denyExit: 2,
  },
  {
    id: "copilot",
    folder: "kya-guard-copilot",
    command: (plugin) => ({ cmd: json("kya-guard-copilot", "com.github.copilot", "hooks", "hooks.json").hooks.PreToolUse[0].bash, cwd: plugin, env: { PLUGIN_ROOT: plugin } }),
    // Copilot CLI camelCase preToolUse: toolArgs is a JSON string.
    payload: (cwd, command) => JSON.stringify({ sessionId: "p1", timestamp: 1, cwd, toolName: "bash", toolArgs: JSON.stringify({ command }) }),
    denyBody: (out) => {
      const b = JSON.parse(out);
      expect(b.permissionDecision).toBe("deny");
      expect(b.permissionDecisionReason).toContain("KYA denied");
    },
    denyExit: 2,
  },
  {
    id: "gemini",
    folder: "kya-guard-gemini",
    command: (plugin) => ({
      cmd: json("kya-guard-gemini", "hooks", "hooks.json").hooks.BeforeTool[0].hooks[0].command.replaceAll("${extensionPath}", plugin).replaceAll("${/}", "/"),
      cwd: plugin,
      env: {},
    }),
    payload: (cwd, command) => JSON.stringify({ hook_event_name: "BeforeTool", session_id: "g1", cwd, tool_name: "run_shell_command", tool_input: { command } }),
    denyBody: (out) => expect(JSON.parse(out)).toMatchObject({ decision: "deny", reason: expect.stringContaining("KYA denied") }),
    denyExit: 0,
  },
];

function runHostHook(h: Host, plugin: string, fx: { home: string; proj: string }, command: string) {
  const c = h.command(plugin);
  const r = spawnSync("bash", ["-c", c.cmd], {
    cwd: c.cwd,
    input: h.payload(fx.proj, command),
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home, ...c.env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("kya-plugin-guard-hosts: layout (static)", () => {
  it("every variant folder holds a byte-identical copy of the bundle, and the mirror include list names each copy", () => {
    const bundle = readFileSync(join(PLUGINS, "kya-guard", "dist", "guard.mjs"));
    expect(VARIANT_DIRS).toEqual(["kya-guard-cursor", "kya-guard-copilot", "kya-guard-gemini"]);
    for (const copy of COPIES as string[]) expect(readFileSync(copy).equals(bundle), copy).toBe(true);
    const includes = readFileSync(join(PKG, "..", "..", "scripts", "ci", "kya-mirror-includes.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
    expect(includes.sort()).toEqual(["kya-guard", ...VARIANT_DIRS].map((d) => `plugins/${d}/dist/guard.mjs`).sort());
  });

  it("Codex: the manifest points at a hook file with one PreToolUse command, no SessionStart, timeout 5", () => {
    const m = json("kya-guard", ".codex-plugin", "plugin.json");
    expect(m).toMatchObject({ name: "kya-guard", version: "1.0.0", hooks: "./hooks/codex-hooks.json" });
    const h = json("kya-guard", "hooks", "codex-hooks.json");
    expect(Object.keys(h.hooks)).toEqual(["PreToolUse"]);
    expect(h.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/dist/guard.mjs" --host codex', timeout: 5 }] }]);
  });

  it("Cursor: version 1, only preToolUse, a relative command, a manifest with a name", () => {
    expect(json("kya-guard-cursor", "hooks", "hooks.json")).toEqual({ version: 1, hooks: { preToolUse: [{ command: "node ./dist/guard.mjs --host cursor", timeout: 5 }] } });
    expect(json("kya-guard-cursor", ".cursor-plugin", "plugin.json")).toMatchObject({ name: "kya-guard", displayName: "KYA Guard", version: "1.0.0" });
  });

  it("Copilot CLI: Agent Plugins manifest, version 1 hook file, a bash line that turns every exit code but 2 into 0", () => {
    expect(json("kya-guard-copilot", "plugin.json")).toMatchObject({ name: "kya-guard", version: "1.0.0" });
    const h = json("kya-guard-copilot", "com.github.copilot", "hooks", "hooks.json");
    expect(h.version).toBe(1);
    expect(Object.keys(h.hooks)).toEqual(["PreToolUse"]);
    const e = h.hooks.PreToolUse[0];
    expect(e).toMatchObject({ type: "command", matcher: "*", timeoutSec: 5 });
    expect(e.bash).toContain("command -v node >/dev/null 2>&1 || exit 0");
    expect(e.bash).toContain("[ $? -eq 2 ] && exit 2; exit 0");
    expect(e.bash).toContain("--host copilot");
  });

  it("Gemini CLI: an extension manifest and one BeforeTool command that ends with exit 0, timeout in milliseconds", () => {
    expect(json("kya-guard-gemini", "gemini-extension.json")).toMatchObject({ name: "kya-guard", version: "1.0.0" });
    const h = json("kya-guard-gemini", "hooks", "hooks.json");
    expect(Object.keys(h.hooks)).toEqual(["BeforeTool"]);
    const c = h.hooks.BeforeTool[0].hooks[0];
    expect(c).toMatchObject({ type: "command", timeout: 5000 });
    expect(c.command).toMatch(/--host gemini; exit 0$/);
  });

  it("no hook file of any variant declares a SessionStart, a network tool or npx", () => {
    for (const f of [
      ["kya-guard", "hooks", "codex-hooks.json"], ["kya-guard-cursor", "hooks", "hooks.json"],
      ["kya-guard-copilot", "com.github.copilot", "hooks", "hooks.json"], ["kya-guard-gemini", "hooks", "hooks.json"],
    ]) expect(readFileSync(join(PLUGINS, ...f), "utf8")).not.toMatch(/SessionStart|bootstrap|npx|npm |curl|wget/);
  });

  it("the Copilot marketplace and the Codex marketplace list kya-guard beside kya", () => {
    const copilot = JSON.parse(readFileSync(join(PKG, ".plugin", "marketplace.json"), "utf8"));
    expect(copilot.plugins.find((p: any) => p.name === "kya-guard").source).toBe("./plugins/kya-guard-copilot");
    const codex = JSON.parse(readFileSync(join(PKG, ".agents", "plugins", "marketplace.json"), "utf8"));
    expect(codex.plugins.find((p: any) => p.name === "kya-guard").source.path).toBe("./plugins/kya-guard");
  });
});

describe.skipIf(!posix)("kya-plugin-guard-hosts: the hook command of each host, run for real (e2e)", { timeout: 60_000 }, () => {
  for (const h of HOSTS) {
    describe(h.id, () => {
      const plugin = join(PLUGINS, h.folder);

      it("a deny comes back in the host's shape, with the exit code the host reads", () => {
        const fx = sandbox();
        const r = runHostHook(h, plugin, fx, DENY);
        expect(r.code, r.err).toBe(h.denyExit);
        h.denyBody(r.out);
        expect(r.err).toContain("NEVER_SHELL (terraform-destroy)");
      });

      it("an allowed call exits 0 with no output", () => {
        const fx = sandbox();
        const r = runHostHook(h, plugin, fx, ALLOW);
        expect(r.code, r.err).toBe(0);
        expect(r.out).toBe("");
      });

      it("the ask rule is a deny (this host has no ask the guard relies on)", () => {
        const fx = sandbox();
        const r = runHostHook(h, plugin, fx, ASK);
        expect(r.code, r.err).toBe(h.denyExit);
        h.denyBody(r.out);
        expect(r.out).toContain("GUARD_ASK (prisma-migrate-reset)");
        expect(r.out).not.toContain('"ask"');
      });

      it("writes one trail row per call in the temp HOME, with this host as the product, and the row says blocked", () => {
        const fx = sandbox();
        runHostHook(h, plugin, fx, DENY);
        runHostHook(h, plugin, fx, ASK);
        runHostHook(h, plugin, fx, ALLOW);
        const rows = readFileSync(join(fx.home, ".kya", "trail.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(rows.map((x) => x.outcome)).toEqual(["blocked", "blocked", "ran"]);
        const product = h.id === "copilot" ? "other" : h.id; // the full kya plugin also names Copilot rows "other"
        expect(new Set(rows.map((x) => x.product))).toEqual(new Set([product]));
        expect(existsSync(join(fx.proj, ".claude"))).toBe(false);
      });

      it("a payload that is not JSON is let through", () => {
        const fx = sandbox();
        const c = h.command(plugin);
        const r = spawnSync("bash", ["-c", c.cmd], { cwd: c.cwd, input: "not json", encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home, ...c.env } });
        expect(r.status).toBe(0);
      });
    });
  }

  it("Claude Code keeps its ask: the same ask rule exits 0 with permissionDecision ask on --host claude", () => {
    const fx = sandbox();
    const r = spawnSync(process.execPath, [join(PLUGINS, "kya-guard", "dist", "guard.mjs"), "--host", "claude"], {
      cwd: fx.proj, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home },
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.proj, tool_name: "Bash", tool_input: { command: ASK } }),
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("Gemini: an MCP tool is named from mcp_context, so the never-list matches it", () => {
    const fx = sandbox();
    const r = spawnSync(process.execPath, [join(PLUGINS, "kya-guard-gemini", "dist", "guard.mjs"), "--host", "gemini"], {
      cwd: fx.proj, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home },
      input: JSON.stringify({ hook_event_name: "BeforeTool", tool_name: "mcp_postgres_drop_table", mcp_context: { server_name: "postgres", tool_name: "drop_table" }, tool_input: {} }),
    });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ decision: "deny", reason: "KYA denied mcp__postgres__drop_table: NEVER_EVENT" });
  });

  it("Copilot: toolArgs arrives as a JSON string and is parsed, so a structured rule (a read of ~/.aws/credentials) matches", () => {
    const fx = sandbox();
    const run = (toolArgs: unknown) =>
      spawnSync(process.execPath, [join(PLUGINS, "kya-guard-copilot", "dist", "guard.mjs"), "--host", "copilot"], {
        cwd: fx.proj, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home },
        input: JSON.stringify({ sessionId: "p2", cwd: fx.proj, toolName: typeof toolArgs === "string" && toolArgs.includes("content") ? "Write" : "Read", toolArgs }),
      });
    const bad = run(JSON.stringify({ file_path: "~/.aws/credentials" }));
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout).permissionDecisionReason).toContain("secret-read-file");
    expect(run(JSON.stringify({ file_path: "README.md" })).status).toBe(0);
    expect(run("{ this is not json").status).toBe(0); // a string that does not parse fails open
    // The parsed arguments also feed the trail row (target path and size of a write), which the raw string cannot.
    expect(run(JSON.stringify({ file_path: "notes.txt", content: "hello" })).status).toBe(0);
    const rows = readFileSync(join(fx.home, ".kya", "trail.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.find((r) => r.targetPath === "notes.txt")?.summary).toBe("write notes.txt (5 chars)");
  });

  it("an unknown --host gets the Claude-shaped deny and no ask", () => {
    const fx = sandbox();
    const r = spawnSync(process.execPath, [join(PLUGINS, "kya-guard", "dist", "guard.mjs"), "--host", "somehost"], {
      cwd: fx.proj, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home },
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: fx.proj, tool_name: "Bash", tool_input: { command: ASK } }),
    });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("Copilot: a bundle that crashes with exit 1 is turned into exit 0 by the hook line (Copilot would deny on 1)", () => {
    const fx = sandbox();
    const root = join(fx.home, "plugin");
    cpSync(join(PLUGINS, "kya-guard-copilot"), root, { recursive: true });
    writeFileSync(join(root, "dist", "guard.mjs"), "process.exit(1);\n");
    const r = runHostHook(HOSTS[2]!, root, fx, DENY);
    expect(r.code).toBe(0);
  });

  it("Copilot: without node on PATH the hook line exits 0 (nothing is blocked, nothing runs)", () => {
    const fx = sandbox();
    const c = HOSTS[2]!.command(join(PLUGINS, "kya-guard-copilot"));
    const r = spawnSync("/bin/bash", ["-c", c.cmd], { cwd: c.cwd, input: "{}", encoding: "utf8", env: { PATH: "/nonexistent", HOME: fx.home, KYA_HOME: fx.home, ...c.env } });
    expect(r.status).toBe(0);
  });
});

describe("kya-plugin-guard-hosts: same verdicts as `kya hook` for every host's payload", () => {
  it.each(["codex", "cursor", "copilot", "gemini"])("%s: deny and allow match runHook (exit code and reason text)", async (host) => {
    const h = HOSTS.find((x) => x.id === host)!;
    for (const command of [DENY, ALLOW]) {
      const fx = sandbox();
      const env = { HOME: fx.home, KYA_HOME: fx.home, PATH: process.env.PATH ?? "" };
      const payload = h.payload(fx.proj, command);
      const full = await runHook({ host, strict: false, stdinText: payload, env, cwd: fx.proj });
      const c = h.command(join(PLUGINS, h.folder));
      const lite = spawnSync("bash", ["-c", c.cmd], { cwd: c.cwd, input: payload, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home, ...c.env } });
      expect(full.exitCode === 2).toBe(command === DENY);
      if (command === DENY) expect(lite.stderr.trim()).toBe(full.stderr.trim());
      else expect(lite.status).toBe(0);
    }
  });
});
