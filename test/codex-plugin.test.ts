/**
 * Codex plugin (`.agents/plugins/marketplace.json` + `plugins/kya/.codex-plugin`): structure, pins,
 * and an e2e that runs hooks/codex-hooks.json the way Codex does (codex-rs/hooks: `${KEY}` replaced
 * textually with PLUGIN_ROOT / PLUGIN_DATA, then `$SHELL -lc <command>`, payload on stdin, the
 * CLAUDE_PLUGIN_* aliases exported). Payloads follow Codex's generated
 * pre-tool-use.command.input.schema.json. The e2e needs `tsc` first, like test/claude-plugin.test.ts.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { findVersionDrift } from "../scripts/check-version-pins.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { syncTree } from "../scripts/lib/version-pins.mjs";

const root = join(import.meta.dirname, "..");
const pluginRoot = join(root, "plugins/kya");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, any>;
const version = json("package.json").version as string;
const posix = process.platform !== "win32";
const haveDist = existsSync(join(root, "dist/cli.js"));
const hooksFile = "plugins/kya/hooks/codex-hooks.json";
const handler = (event: string) => json(hooksFile).hooks[event][0].hooks[0];
// A space in the path: Codex data dirs live under the user's home, which may contain one.
const tmp = () => mkdtempSync(join(tmpdir(), "kya codex-"));

/** Run a codex-hooks.json handler as Codex does. */
function runHandler(event: string, data: string, env: Record<string, string>, stdin = "") {
  const vars: Record<string, string> = { PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: data, CLAUDE_PLUGIN_DATA: data };
  const command = Object.entries(vars).reduce((c, [k, v]) => c.replaceAll(`\${${k}}`, v), handler(event).command as string);
  return spawnSync("/bin/sh", ["-lc", command], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: tmp(), ...vars, ...env },
  });
}

let seq = 0;
const payload = (tool: string, toolInput: unknown, id = `call_${++seq}`) =>
  JSON.stringify({
    session_id: "thr_codex_test",
    turn_id: "turn_1",
    transcript_path: null,
    cwd: root,
    hook_event_name: "PreToolUse",
    model: "gpt-5-codex",
    permission_mode: "default",
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: id,
  });

describe("Codex marketplace and plugin manifest", () => {
  it("marketplace lists kya by ./ path with the fields Codex requires", () => {
    const m = json(".agents/plugins/marketplace.json");
    expect(m.name).toBe("shield-kya"); // same name as the Claude marketplace: kya@shield-kya everywhere
    expect(m.plugins).toHaveLength(1);
    const [p] = m.plugins;
    expect(p).toMatchObject({ name: "kya", source: { source: "local", path: "./plugins/kya" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } });
    expect(typeof p.category).toBe("string");
    expect(p).not.toHaveProperty("version");
  });

  it("the Codex manifest points at the Codex hooks file and bundles no MCP server", () => {
    const c = json("plugins/kya/.codex-plugin/plugin.json");
    expect(c.name).toBe(json("plugins/kya/.claude-plugin/plugin.json").name);
    expect(c.version).toBe(version);
    expect(c.description).toBe(json("channel-copy.json").variants.plugin);
    expect(c.hooks).toBe("./hooks/codex-hooks.json");
    expect(existsSync(join(pluginRoot, c.hooks))).toBe(true);
    // {} (not absent): an absent field makes Codex load the Claude .mcp.json, whose ${CLAUDE_PLUGIN_DATA} it does not expand.
    expect(c.mcpServers).toEqual({});
  });

  it("shell-string handlers, quoted placeholders, advisory, no npx, pin follows package.json", () => {
    const pre = handler("PreToolUse");
    const start = handler("SessionStart");
    for (const h of [pre, start]) {
      expect(h.type).toBe("command");
      expect(typeof h.command).toBe("string");
      expect(h).not.toHaveProperty("args"); // Codex has no args field
      expect(h.command).not.toMatch(/npx|--strict|--fail-closed|--plane-config/);
    }
    expect(pre.command).toBe('node "${PLUGIN_DATA}/node_modules/@shield-agent/kya/dist/cli.js" hook --host codex');
    expect(pre.timeout).toBe(5);
    expect(json(hooksFile).hooks.PreToolUse[0].matcher).toBe("*");
    expect(start.command).toBe(`node "\${PLUGIN_ROOT}/scripts/bootstrap.mjs" @shield-agent/kya@${version}`);
    expect(start.timeout).toBeGreaterThanOrEqual(120);
  });

  it("makes no enforcement, approval or fail-closed claim", () => {
    for (const f of [".agents/plugins/marketplace.json", "plugins/kya/.codex-plugin/plugin.json", hooksFile]) {
      expect(read(f), f).not.toMatch(/fail-closed|enforce|approv|signed certify/i);
    }
  });

  it("Codex docs make no enforcement, fail-closed, PEP or GA claim", () => {
    const section = (text: string, start: string, end: RegExp) => {
      const i = text.indexOf(start);
      expect(i, start).toBeGreaterThanOrEqual(0);
      const rest = text.slice(i + start.length);
      const j = rest.search(end);
      return j < 0 ? rest : rest.slice(0, j);
    };
    const docs = {
      "docs/hosts/codex.md (intro + plugin section)": section(read("docs/hosts/codex.md"), "# Codex (OpenAI)", /\n## MCP server/),
      "README.md (Codex plugin section)": section(read("README.md"), "## Codex plugin", /\n## /),
      "plugins/kya/README.md": read("plugins/kya/README.md"),
    };
    const claim = /\benforc(es|ed by kya|ing)\b|\bfails?[- ]closed\b|\bsole PEP\b|\bgenerally available\b|\bgeneral availability\b|\bGA\b|\bproduction[- ]ready\b|\bguarantee[sd]?\b|\bblocks (every|all)\b/i;
    for (const [name, text] of Object.entries(docs)) {
      expect(text.length, name).toBeGreaterThan(200);
      expect(text, name).not.toMatch(claim);
      expect(text, name).toMatch(/fails? open|fail-open/i);
    }
  });

  it("SessionStart runs on startup and resume only, with its status message (both are part of Codex's trust hash)", () => {
    const start = json(hooksFile).hooks.SessionStart[0];
    expect(start.matcher).toBe("startup|resume");
    expect(start.hooks[0].statusMessage).toBe("Shield KYA: checking the local kya install");
  });

  it("seeded drift in the Codex manifest and hook pin fails the pin check; sync repairs it", () => {
    const copy = join(mkdtempSync(join(tmpdir(), "kya-codex-pins-")), "sdks/kya");
    cpSync(root, copy, { recursive: true, filter: (src) => !/[\\/](node_modules|dist|coverage|\.git)$/.test(src) });
    expect(findVersionDrift(copy)).toEqual([]);
    const bump = (rel: string) => writeFileSync(join(copy, rel), readFileSync(join(copy, rel), "utf8").replaceAll(version, "0.0.1"));
    bump("plugins/kya/.codex-plugin/plugin.json");
    bump(hooksFile);
    const drift = findVersionDrift(copy).join("\n");
    expect(drift).toContain("plugins/kya/.codex-plugin/plugin.json: version 0.0.1");
    // Built by concatenation so check-version-pins does not read this line as a live pin.
    expect(drift).toContain(`${hooksFile}: pins @shield-agent/kya${"@"}0.0.1`);
    const changed = syncTree(copy, version).map((f: string) => f.split("\\").join("/"));
    expect(changed).toEqual(expect.arrayContaining(["plugins/kya/.codex-plugin/plugin.json", hooksFile]));
    expect(findVersionDrift(copy)).toEqual([]);
  });
});

describe.skipIf(!posix)("e2e: codex-hooks.json handlers against the built kya (Codex runner shape)", () => {
  const rows = (home: string) => {
    const f = join(home, ".kya/trail.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  function dataWithKya(): string {
    const data = tmp();
    mkdirSync(join(data, "node_modules/@shield-agent"), { recursive: true });
    symlinkSync(root, join(data, "node_modules/@shield-agent/kya"));
    return data;
  }

  it.skipIf(!haveDist)("Bash and apply_patch are recorded as codex and allowed; never-list blocks with a stderr reason; repeats dedupe", () => {
    const data = dataWithKya();
    const home = tmp();
    const env = { KYA_HOME: home };

    const bash = runHandler("PreToolUse", data, env, payload("Bash", { command: "ls -la" }, "call_bash"));
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe(""); // Codex: plain stdout ignored, but stay silent
    const patch = runHandler("PreToolUse", data, env, payload("apply_patch", { command: "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n" }, "call_patch"));
    expect(patch.status).toBe(0);

    const deny = runHandler("PreToolUse", data, env, payload("mcp__postgres__drop_table", { table: "users" }, "call_deny"));
    expect(deny.status).toBe(2);
    // Codex only blocks on exit 2 when stderr carries a reason (codex-rs/hooks/src/events/pre_tool_use.rs).
    expect(deny.stderr.trim()).toMatch(/KYA denied mcp__postgres__drop_table/);
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    const r = rows(home);
    expect(r.map((x) => x.toolId)).toEqual(["Bash", "apply_patch", "mcp__postgres__drop_table"]);
    expect(new Set(r.map((x) => x.product))).toEqual(new Set(["codex"]));
    expect(r[2].verdict).toBe("DENY");

    // Concurrent duplicate hook copy (same tool_use_id): verdict repeats, row does not.
    expect(runHandler("PreToolUse", data, env, payload("mcp__postgres__drop_table", { table: "users" }, "call_deny")).status).toBe(2);
    expect(runHandler("PreToolUse", data, env, payload("Bash", { command: "ls -la" }, "call_bash")).status).toBe(0);
    expect(rows(home)).toHaveLength(3);
  });

  it.skipIf(!haveDist)("the never-list still blocks with a stderr reason when the project config is broken (fallback path)", () => {
    const data = dataWithKya();
    const home = tmp();
    const proj = tmp();
    mkdirSync(join(proj, ".kya"));
    writeFileSync(join(proj, ".kya/config.json"), '{"agentId": 42, "host": {"x": 1}}');
    const pre = (tool: string) =>
      spawnSync("/bin/sh", ["-lc", `node "${data}/node_modules/@shield-agent/kya/dist/cli.js" hook --host codex`], {
        input: payload(tool, {}),
        encoding: "utf8",
        cwd: proj,
        env: { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home },
      });
    const deny = pre("mcp__postgres__drop_table");
    expect(deny.status).toBe(2);
    expect(deny.stderr.trim()).toMatch(/KYA denied mcp__postgres__drop_table/);
    expect(pre("Bash").status).toBe(0);
  });

  it.skipIf(!haveDist)("unexpected payloads fail open: garbage, non-object, no tool_name, other events", () => {
    const data = dataWithKya();
    const env = { KYA_HOME: tmp() };
    for (const input of ["", "not json", "[1,2]", "null", JSON.stringify({ hook_event_name: "PreToolUse" }), JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "mcp__postgres__drop_table" })]) {
      const r = runHandler("PreToolUse", data, env, input);
      expect(r.status, input).toBe(0);
    }
  });

  it.skipIf(!haveDist)("SessionStart: bootstrap reads the CLAUDE_PLUGIN_DATA alias Codex sets and accepts the real build", () => {
    const r = runHandler("SessionStart", dataWithKya(), {});
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("SessionStart in a clean HOME with no npm says NOT recording and exits 0 (Codex continues)", () => {
    const binDir = tmp();
    symlinkSync(process.execPath, join(binDir, "node"));
    const r = runHandler("SessionStart", tmp(), { PATH: binDir });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/Shield KYA is NOT recording: npm was not found/);
  });

  it("kya not installed or node missing: exit is neither 0 nor 2, which Codex treats as a failed, non-blocking hook", () => {
    const missingKya = runHandler("PreToolUse", tmp(), { KYA_HOME: tmp() }, payload("mcp__postgres__drop_table", {}));
    expect([0, 2]).not.toContain(missingKya.status);
    const noNode = runHandler("PreToolUse", tmp(), { PATH: tmp() }, payload("Bash", { command: "ls" }));
    expect([0, 2]).not.toContain(noNode.status);
  });
});
