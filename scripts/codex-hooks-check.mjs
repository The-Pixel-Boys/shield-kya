#!/usr/bin/env node
// Opt-in check that real Codex still loads the kya Codex plugin as a Codex plugin: two hooks from
// hooks/codex-hooks.json and no MCP server. Regression guard for PR #426 (a root Agent Plugins
// plugin.json in plugins/kya made Codex ignore .codex-plugin/ and drop both hooks).
//
//   node scripts/codex-hooks-check.mjs <path to the codex binary> [marketplace dir, default: this package]
//
// Get the binary without running install scripts, e.g. in an empty scratch dir:
//   npm pack --ignore-scripts @openai/codex@<v>-darwin-arm64 && tar xzf openai-codex-*.tgz
//   -> package/vendor/aarch64-apple-darwin/bin/codex
// Uses a fresh CODEX_HOME and a copy of the marketplace dir; never touches ~/.codex. No model call.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [codex, src = resolve(import.meta.dirname, "..")] = process.argv.slice(2);
if (!codex) {
  console.error("usage: codex-hooks-check.mjs <codex binary> [marketplace dir]");
  process.exit(2);
}
const home = mkdtempSync(join(tmpdir(), "kya-codex-home-"));
const copy = join(mkdtempSync(join(tmpdir(), "kya-codex-mk-")), "kya");
cpSync(src, copy, { recursive: true, filter: (p) => !/[/\\](node_modules|dist|coverage|\.git)([/\\]|$)/.test(p) });
const env = { ...process.env, CODEX_HOME: home };
const run = (...a) => execFileSync(codex, a, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log(run("--version").trim());
run("plugin", "marketplace", "add", copy);
run("plugin", "add", "kya@shield-kya");
const mcp = run("mcp", "list");

function hooksList(cwd) {
  return new Promise((done, fail) => {
    const child = spawn(codex, ["app-server"], { env, cwd, stdio: ["pipe", "pipe", "inherit"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("app-server timed out")); }, 30000);
    let buf = "";
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 0) {
          send({ method: "initialized" });
          send({ id: 1, method: "hooks/list", params: { cwds: [cwd] } });
        } else if (m.id === 1) {
          clearTimeout(timer);
          child.kill();
          if (m.error) fail(new Error(JSON.stringify(m.error)));
          else done(m.result);
        }
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "kya-codex-hooks-check", version: "0" } } });
  });
}

const result = await hooksList(mkdtempSync(join(tmpdir(), "kya-codex-cwd-")));
const text = JSON.stringify(result);
const kyaHooks = (text.match(/codex-hooks\.json|bootstrap\.mjs|--host codex/g) ?? []).length;
console.log(`hooks/list: ${text.slice(0, 4000)}`);
console.log(`codex mcp list:\n${mcp.trim()}`);
const problems = [];
if (!/bootstrap\.mjs/.test(text)) problems.push("SessionStart bootstrap hook missing");
if (!/hook --host codex/.test(text)) problems.push("PreToolUse `kya hook --host codex` missing");
if (/shield-kya/.test(mcp)) problems.push("codex mcp list shows a shield-kya server (the Codex plugin bundles none)");
console.log(problems.length ? `FAIL\n  ${problems.join("\n  ")}` : `PASS: Codex loads the kya Codex plugin (${kyaHooks} kya hook references, no MCP server)`);
process.exit(problems.length ? 1 : 0);
