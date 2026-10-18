/**
 * GitHub Copilot CLI plugin (`plugins/kya-copilot`, Agent Plugins v1, reached through
 * `.plugin/marketplace.json`): manifest, `mcp.json`, `com.github.copilot/hooks/hooks.json`, the
 * isolation from the Claude Code / Codex plugin in `plugins/kya`, and an e2e that runs the hooks the
 * way Copilot CLI 1.0.98 did in real sessions (SessionStart: exec + args with `${PLUGIN_ROOT}` /
 * `${CLAUDE_PLUGIN_*}` / `${COPILOT_PLUGIN_*}` expanded and `${PLUGIN_DATA}` left literal;
 * PreToolUse: a bash command with PLUGIN_ROOT, CLAUDE_/COPILOT_PLUGIN_DATA in the env and a
 * snake_case payload). Copilot denies a tool call when a preToolUse command hook exits non-zero, so
 * the fail-open cases matter here. The e2e needs `tsc` first.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pluginRoot = join(root, "plugins/kya-copilot");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, any>;
const version = json("package.json").version as string;
const haveDist = existsSync(join(root, "dist/cli.js"));
const hooksFile = "plugins/kya-copilot/com.github.copilot/hooks/hooks.json";
const handler = (event: string) => json(hooksFile).hooks[event][0];
const tmp = () => mkdtempSync(join(tmpdir(), "kya copilot-"));

// Agent Plugins v1.0.0 (agentplugins/agent-plugins-spec schemas/1.0.0/plugin.schema.json): closed schema.
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const ALLOWED = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];

/** Run a hooks.json handler as Copilot CLI 1.0.98 did (observed in real sessions, not from docs). */
function runHandler(event: string, data: string, env: Record<string, string> = {}, stdin = "") {
  const vars: Record<string, string> = {
    PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_ROOT: pluginRoot, COPILOT_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: data, COPILOT_PLUGIN_DATA: data,
  };
  const h = handler(event);
  const opts = { input: stdin, encoding: "utf8" as const, timeout: 10000, env: { PATH: process.env.PATH ?? "", HOME: tmp(), ...vars, ...env } };
  if (h.bash) return spawnSync("/bin/bash", ["-c", h.bash as string], opts);
  const args = (h.args as string[]).map((a) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`\${${k}}`, v), a));
  return spawnSync(process.execPath, args, opts);
}

/** A PATH that has the node running these tests and nothing else from the host. */
function nodeOnlyPath(): string {
  const bin = tmp();
  symlinkSync(process.execPath, join(bin, "node"));
  return bin;
}

// Payload shape captured from Copilot CLI 1.0.98 (PascalCase PreToolUse, Claude tool names).
const payload = (tool: string, toolInput: unknown = { command: "echo kya-probe", description: "probe" }) =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "copilot-test", timestamp: new Date().toISOString(), cwd: root, tool_name: tool, tool_input: toolInput });

/** A data dir whose installed kya is the given cli.js body, or the working tree when omitted. */
function dataWith(cliBody?: string): string {
  const data = tmp();
  mkdirSync(join(data, "node_modules/@shield-agent"), { recursive: true });
  if (cliBody === undefined) {
    symlinkSync(root, join(data, "node_modules/@shield-agent/kya"));
  } else {
    mkdirSync(join(data, "node_modules/@shield-agent/kya/dist"), { recursive: true });
    writeFileSync(join(data, "node_modules/@shield-agent/kya/dist/cli.js"), cliBody);
  }
  return data;
}

const rows = (kyaHome: string) => {
  const f = join(kyaHome, ".kya/trail.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe("Copilot CLI plugin manifest (Agent Plugins v1)", () => {
  it("root plugin.json is a closed Agent Plugins v1 manifest that follows the Claude manifest", () => {
    const m = json("plugins/kya-copilot/plugin.json");
    const claude = json("plugins/kya/.claude-plugin/plugin.json");
    expect(m.$schema).toBe(PLUGIN_SCHEMA);
    expect(Object.keys(m).filter((k) => !ALLOWED.includes(k))).toEqual([]);
    expect(m.name).toBe(claude.name);
    expect(m.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
    expect(m.version).toBe(version);
    expect(m.description).toBe(json("channel-copy.json").variants.plugin);
    expect(Object.keys(m.author).sort()).toEqual(["email", "name", "url"]);
    for (const k of ["homepage", "repository", "license"]) expect(typeof m[k]).toBe("string");
  });

  it("mcp.json: Agent Plugins stdio server, bare node, offline and keyless like .mcp.json", () => {
    const m = json("plugins/kya-copilot/mcp.json");
    expect(Object.keys(m).sort()).toEqual(["$schema", "mcpServers"]);
    expect(m.$schema).toBe(MCP_SCHEMA);
    const s = m.mcpServers["shield-kya"];
    expect(Object.keys(s).sort()).toEqual(["args", "command", "env", "type"]);
    expect(s).toMatchObject({ type: "stdio", command: "node" });
    expect(s.args).toEqual(["${PLUGIN_DATA}/node_modules/@shield-agent/kya/dist/cli.js", "serve-mcp", "--stdio"]);
    expect(s.env).toEqual(json("plugins/kya/.mcp.json").mcpServers["shield-kya"].env);
    expect(s.env).toMatchObject({ KYA_OFFLINE: "1", KYA_BASE_URL: "http://127.0.0.1:1", KYA_API_KEY: "" });
  });

  it("hooks: version 1, PascalCase events, pin follows package.json, PreToolUse survives a missing node", () => {
    const h = json(hooksFile);
    expect(h.version).toBe(1);
    expect(Object.keys(h.hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    for (const e of ["SessionStart", "PreToolUse"]) expect(h.hooks[e]).toHaveLength(1);
    // SessionStart failures never block in Copilot, so exec form is fine there. Copilot 1.0.98 left
    // ${PLUGIN_DATA} literal in hook args (it expands it only for MCP servers).
    expect(handler("SessionStart")).toMatchObject({ type: "command", exec: "node", args: ["${PLUGIN_ROOT}/scripts/bootstrap.mjs", `@shield-agent/kya@${version}`] });
    expect(handler("SessionStart").timeoutSec).toBeGreaterThanOrEqual(120);
    // PreToolUse: a non-zero exit denies the call, so `node` itself must be optional.
    expect(handler("PreToolUse")).toEqual({
      type: "command",
      matcher: "*",
      bash: 'command -v node >/dev/null 2>&1 || exit 0; node "$PLUGIN_ROOT/scripts/copilot-hook.mjs"; [ $? -eq 2 ] && exit 2; exit 0',
      timeoutSec: 5,
    });
    expect(read(hooksFile)).not.toContain("${PLUGIN_DATA}");
    expect(read(hooksFile) + read("plugins/kya-copilot/mcp.json")).not.toMatch(/npx|--strict|--fail-closed|--plane-config/);
  });

  it("every file Copilot reads ships in the public mirror (nothing under a .github dir)", () => {
    for (const f of [".plugin/marketplace.json", "plugins/kya-copilot/plugin.json", "plugins/kya-copilot/mcp.json", hooksFile, "plugins/kya-copilot/scripts/copilot-hook.mjs", "plugins/kya-copilot/scripts/bootstrap.mjs"]) {
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(f).not.toMatch(/(^|\/)\.github\//);
    }
  });

  it("makes no enforcement, approval or fail-closed claim", () => {
    for (const f of [".plugin/marketplace.json", "plugins/kya-copilot/plugin.json", "plugins/kya-copilot/mcp.json", hooksFile]) {
      expect(read(f), f).not.toMatch(/fail-closed|enforce|approv|signed certify/i);
    }
  });
});

describe("Copilot plugin stays out of Claude Code and Codex (PR #426 review H1)", () => {
  // A root Agent Plugins plugin.json made Codex 0.162/0.163 load plugins/kya as an Agent Plugin:
  // hooks/list returned [] and an MCP server appeared (scripts/codex-hooks-check.mjs reproduces it).
  const AGENT_PLUGIN_FILES = ["plugin.json", "mcp.json", ".plugin/plugin.json", ".github/plugin/plugin.json", "com.github.copilot"];
  const sourceDir = (rel: string) => join(root, rel);
  it("the dir the Codex and Claude marketplaces point at has no Agent Plugins / Copilot file", () => {
    const codex = json(".agents/plugins/marketplace.json").plugins[0].source.path as string;
    const claude = json(".claude-plugin/marketplace.json").plugins[0].source as string;
    expect(codex).toBe("./plugins/kya");
    expect(claude).toBe("./plugins/kya");
    for (const f of AGENT_PLUGIN_FILES) expect(existsSync(join(sourceDir(codex), f)), f).toBe(false);
  });

  it("Copilot's marketplace (.plugin/, read before .claude-plugin/) names kya and points at plugins/kya-copilot only", () => {
    const m = json(".plugin/marketplace.json");
    const claude = json(".claude-plugin/marketplace.json");
    expect(m.name).toBe(claude.name); // same id for users: kya@shield-kya
    expect(m.owner).toEqual(claude.owner);
    expect(m.plugins).toEqual([{ name: "kya", source: "./plugins/kya-copilot", description: claude.plugins[0].description }]);
    expect(readdirSync(pluginRoot).sort()).toEqual(["com.github.copilot", "mcp.json", "plugin.json", "scripts"]);
    expect(readdirSync(join(pluginRoot, "scripts")).sort()).toEqual(["bootstrap.mjs", "copilot-hook.mjs"]);
  });

  it("bootstrap.mjs is a byte copy of the Claude plugin's (the public mirror cannot carry symlinks)", () => {
    expect(read("plugins/kya-copilot/scripts/bootstrap.mjs")).toBe(read("plugins/kya/scripts/bootstrap.mjs"));
  });
});

describe("copilot-hook.mjs (PreToolUse, fails open)", () => {
  it("kya not installed yet (first session, failed bootstrap): exit 0, nothing on stdout", () => {
    const r = runHandler("PreToolUse", tmp(), {}, payload("Bash"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("no node on Copilot's PATH: the bash command exits 0 instead of failing (which Copilot treats as deny)", () => {
    const out = join(tmp(), "ran");
    const r = runHandler("PreToolUse", dataWith(`require("node:fs").writeFileSync(${JSON.stringify(out)}, "1");`), { PATH: tmp() }, payload("Bash"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(out)).toBe(false); // kya never started: nothing to run it with
  });

  it("PLUGIN_ROOT unset: node cannot find the wrapper (exit 1), the bash command still exits 0", () => {
    const vars = { PATH: process.env.PATH ?? "", HOME: tmp(), COPILOT_PLUGIN_DATA: dataWith() };
    const r = spawnSync("/bin/bash", ["-c", handler("PreToolUse").bash], { input: payload("Bash"), encoding: "utf8", env: vars });
    expect(r.status).toBe(0);
  });

  it("a broken node on PATH (exits 1, or dies on a signal) maps to exit 0, not a Copilot deny", () => {
    for (const body of ["exit 1", "kill -9 $$"]) {
      const bin = tmp();
      writeFileSync(join(bin, "node"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const r = runHandler("PreToolUse", dataWith(), { PATH: `${bin}:/usr/bin:/bin` }, payload("Bash"));
      expect(r.status, body).toBe(0);
    }
  });

  it("node on PATH but not the test runner's PATH: the bash command finds it", () => {
    const out = join(tmp(), "ran");
    const r = runHandler("PreToolUse", dataWith(`require("node:fs").writeFileSync(${JSON.stringify(out)}, "1");`), { PATH: nodeOnlyPath() }, payload("Bash"));
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("no data dir in the env at all: exit 0", () => {
    const r = spawnSync(process.execPath, [join(pluginRoot, "scripts/copilot-hook.mjs")], { input: payload("Bash"), encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(r.status).toBe(0);
  });

  it("kya crashes (exit 1) or is killed: exit 0", () => {
    expect(runHandler("PreToolUse", dataWith("throw new Error('boom');"), {}, payload("Bash")).status).toBe(0);
    expect(runHandler("PreToolUse", dataWith("process.kill(process.pid, 'SIGKILL');"), {}, payload("Bash")).status).toBe(0);
  });

  it("kya hangs: the shim gives up before Copilot's 5 s timeoutSec and exits 0", () => {
    const t = Date.now();
    const r = runHandler("PreToolUse", dataWith("setInterval(() => {}, 1000);"), {}, payload("Bash"));
    expect(r.status).toBe(0);
    // Inner limit 4 s. Even past Copilot's 5 s timeoutSec the call proceeds (timeouts fail open),
    // so this bound only guards the inner timeout, with headroom for a loaded CI host.
    expect(Date.now() - t).toBeLessThan(4900);
  }, 15000);

  it("forwards only exit 2 WITH a deny decision, adding the top-level fields Copilot reads", () => {
    const body = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "never-list: x" } };
    const deny = runHandler("PreToolUse", dataWith(`process.stdout.write(${JSON.stringify(JSON.stringify(body))} + "\\n"); process.exit(2);`), {}, payload("Bash"));
    expect(deny.status).toBe(2);
    expect(JSON.parse(deny.stdout)).toEqual({ permissionDecision: "deny", permissionDecisionReason: "never-list: x", hookSpecificOutput: body.hookSpecificOutput });
    // kya also exits 2 on a usage error (no JSON) or with other JSON: not a deny, so the call proceeds.
    for (const cli of ["console.error('Unknown command'); process.exit(2);", "process.stdout.write('{\"x\":1}'); process.exit(2);", "process.stdout.write('{\"hookSpecificOutput\":{\"permissionDecision\":\"allow\"}}'); process.exit(2);"]) {
      const r = runHandler("PreToolUse", dataWith(cli), {}, payload("Bash"));
      expect(r.status, cli).toBe(0);
      expect(r.stdout, cli).toBe("");
    }
    expect(runHandler("PreToolUse", dataWith("process.exit(3);"), {}, payload("Bash")).status).toBe(0);
  });

  it("hands kya the exact stdin payload and --host copilot", () => {
    const out = join(tmp(), "argv.json");
    const body = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));`;
    const p = payload("Bash");
    expect(runHandler("PreToolUse", dataWith(body), {}, p).status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ argv: ["hook", "--host", "copilot"], stdin: p });
  });

  it.skipIf(!haveDist)("real kya: an allowed Bash call exits 0 and records one row; a never-list call is denied with JSON", () => {
    const data = dataWith();
    const kyaHome = tmp();
    const allow = runHandler("PreToolUse", data, { KYA_HOME: kyaHome }, payload("Bash"));
    expect(allow.status).toBe(0);
    expect(rows(kyaHome)).toHaveLength(1);
    expect(rows(kyaHome)[0]).toMatchObject({ toolId: "Bash", sessionId: "copilot-test", mode: "offline", neverEvent: false });

    const deny = runHandler("PreToolUse", data, { KYA_HOME: kyaHome }, payload("mcp__postgres__drop_table", { table: "users" }));
    expect(deny.status).toBe(2);
    expect(JSON.parse(deny.stdout)).toMatchObject({ permissionDecision: "deny", hookSpecificOutput: { permissionDecision: "deny" } });
    expect(JSON.parse(deny.stdout).permissionDecisionReason).toMatch(/\S/);
    expect(rows(kyaHome).at(-1)).toMatchObject({ toolId: "mcp__postgres__drop_table", verdict: "DENY", neverEvent: true });
  });

  it.skipIf(!haveDist)("documented gap: Copilot's `<server>-<tool>` MCP names are recorded but not never-listed yet", () => {
    // Real Copilot 1.0.98 payload: tool_name "shield-kya-kya-policy_evaluate" (nodes/N9d evidence).
    // When kya learns this form, flip this test and the docs (README, docs/hosts/copilot.md).
    const kyaHome = tmp();
    const r = runHandler("PreToolUse", dataWith(), { KYA_HOME: kyaHome }, payload("postgres-drop_table", { table: "users" }));
    expect(r.status).toBe(0);
    expect(rows(kyaHome).at(-1)).toMatchObject({ toolId: "postgres-drop_table", neverEvent: false });
  });

  it.skipIf(!haveDist)("SessionStart runs bootstrap.mjs with the plugin data dir Copilot exports (load check accepts the build)", () => {
    const r = runHandler("SessionStart", dataWith(), { PATH: tmp() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
