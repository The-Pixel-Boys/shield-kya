#!/usr/bin/env node
// Replays llms-install.md the way Cline would, minus Cline itself: global install, the two absolute
// paths, the exact JSON block from the doc, then a real MCP stdio session against that config
// (initialize, tools/list = the 3 kya tools, one kya.policy_evaluate) and the trail row it writes.
//
//   node scripts/cline-install-check.mjs [x.y.z]   # installs @shield-agent/kya@<x.y.z|latest> from npm
//                                                  # into a fresh temp prefix; touches nothing else
//
// Not covered (needs a person with Cline): that Cline itself reads the file, shows the server as
// connected and calls the tool. The checklist printed at the end is that part.
// test/cline-install.test.ts runs checkServer() against the local build. Node builtins only.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dirname, "..");
export const TOOLS = ["kya.policy_evaluate", "kya.request_approval", "kya.session_ingest"];

/** The `shield-kya` server entry of the one ```json block in llms-install.md, with the two paths filled in. */
export function serverFromInstallDoc(text, nodePath, cliPath) {
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)];
  if (blocks.length !== 1) throw new Error(`llms-install.md must have exactly one json block, found ${blocks.length}`);
  const server = JSON.parse(blocks[0][1]).mcpServers["shield-kya"];
  const fill = (s) => s.replace("NODE_PATH", nodePath).replace("KYA_CLI_PATH", cliPath);
  return { ...server, command: fill(server.command), args: server.args.map(fill) };
}

/** Spawn the server exactly as configured; resolves { tools, evaluate, rows } or rejects. */
export function checkServer(server, kyaHome, cwd) {
  return new Promise((resolve, reject) => {
    // ponytail: inherit PATH/HOME etc. like Cline does, but KYA_HOME pins the trail to a temp dir.
    const child = spawn(server.command, server.args, {
      cwd,
      env: { ...process.env, ...server.env, KYA_HOME: kyaHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP session timed out")); }, 20000);
    const byId = new Map();
    let buf = "";
    let err = "";
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try { const m = JSON.parse(line); if (typeof m.id === "number") byId.set(m.id, m); } catch { /* not JSON-RPC */ }
      }
      if (byId.has(0) && !byId.has(-1)) {
        byId.set(-1, true);
        send({ method: "notifications/initialized" });
        send({ id: 1, method: "tools/list" });
        send({ id: 2, method: "tools/call", params: { name: "kya.policy_evaluate", arguments: { toolId: "org.sample.data.write", args: { k: "v" } } } });
      }
      if (byId.has(1) && byId.has(2)) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        const trail = join(kyaHome, ".kya", "trail.jsonl");
        const rows = existsSync(trail) ? readFileSync(trail, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
        resolve({ init: byId.get(0), tools: (byId.get(1).result?.tools ?? []).map((t) => t.name).sort(), evaluate: byId.get(2), rows });
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code} before the checks finished: ${err.slice(0, 500)}`)); });
    send({ id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cline-install-check", version: "0" } } });
  });
}

async function main(version = "latest") {
  const prefix = mkdtempSync(join(tmpdir(), "kya-cline-check-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  console.log(`step 1: npm install -g @shield-agent/kya@${version} (prefix ${prefix})`);
  execFileSync(npm, ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", `@shield-agent/kya@${version}`], { stdio: "inherit", shell: process.platform === "win32" });
  const npmRoot = execFileSync(npm, ["root", "-g", "--prefix", prefix], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  const cliPath = join(npmRoot, "@shield-agent", "kya", "dist", "cli.js");
  if (!existsSync(cliPath)) throw new Error(`step 2: ${cliPath} does not exist`);
  console.log(`step 2: NODE_PATH=${process.execPath} KYA_CLI_PATH=${cliPath}`);
  const server = serverFromInstallDoc(readFileSync(join(ROOT, "llms-install.md"), "utf8"), process.execPath, cliPath);
  const r = await checkServer(server, mkdtempSync(join(tmpdir(), "kya-cline-home-")), mkdtempSync(join(tmpdir(), "kya-cline-cwd-")));
  const problems = [];
  if (JSON.stringify(r.tools) !== JSON.stringify(TOOLS)) problems.push(`tools/list gave ${r.tools.join(", ")}`);
  if (r.evaluate.error || r.evaluate.result?.isError) problems.push(`kya.policy_evaluate failed: ${JSON.stringify(r.evaluate).slice(0, 300)}`);
  if (!r.rows.some((row) => row.toolId === "org.sample.data.write")) problems.push("no trail row for org.sample.data.write");
  console.log(`steps 3-4 + verify (config from llms-install.md, real MCP stdio): server ${r.init.result?.serverInfo?.name} ${r.init.result?.serverInfo?.version}, tools ${r.tools.join(", ")}, trail rows ${r.rows.length}`);
  if (problems.length) {
    console.error(`FAIL\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`PASS: the llms-install.md config starts the server and records a trail row.
Still to check by hand in Cline (not automated):
  [ ] Cline, given only README.md and llms-install.md, edits cline_mcp_settings.json to the block above
  [ ] the MCP Servers panel shows shield-kya connected with 3 tools
  [ ] Cline calls kya.policy_evaluate and a row appears in kya receipt --open`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((e) => {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  });
}
