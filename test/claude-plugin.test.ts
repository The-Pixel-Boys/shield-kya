/**
 * Claude Code / Copilot CLI plugin marketplace (`.claude-plugin/` + `plugins/kya`).
 * Structure and pin checks, bootstrap.mjs behavior (with a fake npm on PATH), and an e2e that
 * runs the hooks.json command shape against the built kya (needs `tsc` first, like
 * test/hook.test.ts).
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// These tests spawn CLIs or git, or wait on timers: 0.8 to 1.6 s each on an idle Mac, so the 5 s default is too tight on a loaded CI host. Hang guard only; budget assertions stay.
vi.setConfig({ testTimeout: 30_000 });

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, any>;
const version = json("package.json").version as string;
const cliJs = join(root, "dist/cli.js");
const posix = process.platform !== "win32";

const hook = (event: string) => json("plugins/kya/hooks/hooks.json").hooks[event][0].hooks[0];
const tmp = () => mkdtempSync(join(tmpdir(), "kya-plugin-"));

/** Run a hooks.json handler in exec form, the way Claude Code does (placeholders substituted, env exported). */
function runHandler(event: string, data: string, env: Record<string, string>, stdin = "") {
  const pluginRoot = join(root, "plugins/kya");
  const sub = (s: string) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot).replaceAll("${CLAUDE_PLUGIN_DATA}", data);
  return spawnSync(process.execPath, hook(event).args.map(sub), {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: data, ...env },
  });
}

const payload = (tool: string, id: string) =>
  JSON.stringify({ session_id: "s-plugin", hook_event_name: "PreToolUse", tool_name: tool, tool_input: { x: 1 }, tool_use_id: id });

describe("marketplace structure and pins", () => {
  it("lists kya and kya-guard, by relative path, with no entry version", () => {
    const m = json(".claude-plugin/marketplace.json");
    expect(m.name).toBe("shield-kya");
    expect(m.owner.name).toContain("MFR Limited");
    expect(m.plugins.map((p: any) => p.name)).toEqual(["kya", "kya-guard"]);
    expect(m.plugins.map((p: any) => p.source)).toEqual(["./plugins/kya", "./plugins/kya-guard"]);
    for (const p of m.plugins) expect(p).not.toHaveProperty("version");
    expect(json("plugins/kya/.claude-plugin/plugin.json").name).toBe("kya");
    expect(existsSync(join(root, "plugins/kya-hosted"))).toBe(false);
  });

  it("makes no hosted-enforcement, approval or total-offline claim anywhere in the plugin text or docs", () => {
    const files = [
      ".claude-plugin/marketplace.json", "plugins/kya/.claude-plugin/plugin.json", "plugins/kya/README.md", "docs/hosts/claude-plugin.md",
    ];
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toMatch(/fail-closed|hosted enforcement|enforces|approv|signed certify/i);
      expect(text, f).not.toMatch(/any routable host|no network at hook time/i);
    }
    expect(read("docs/hosts/claude-plugin.md")).toMatch(/notify webhook/);
  });

  it("manifest version and every pin follow package.json", () => {
    expect(json("plugins/kya/.claude-plugin/plugin.json").version).toBe(version);
    // The Claude hooks carry no package spec: bootstrap.mjs takes the pin from the manifest above.
    expect(read("plugins/kya/hooks/hooks.json") + read("plugins/kya/.mcp.json")).not.toMatch(/@shield-agent\/kya@/);
  });

  it("every command is node with a literal ${CLAUDE_PLUGIN_ROOT}/scripts file first (plugin directory rules)", () => {
    const cmds = [
      ...Object.values(json("plugins/kya/hooks/hooks.json").hooks).flatMap((g: any) => g.flatMap((m: any) => m.hooks)),
      ...Object.values(json("plugins/kya/.mcp.json").mcpServers),
    ] as any[];
    expect(cmds).toHaveLength(3);
    for (const c of cmds) {
      expect(c.command).toBe("node");
      expect(c.args[0]).toMatch(/^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[a-z-]+\.mjs$/);
      expect(existsSync(join(root, "plugins/kya", c.args[0].replace("${CLAUDE_PLUGIN_ROOT}/", "")))).toBe(true);
      expect(c.args.join(" ")).not.toMatch(/\$\{CLAUDE_PLUGIN_DATA\}|\$\(|`|\*|\s-e\s|--eval|--import|--require/);
    }
    expect(read("plugins/kya/scripts/kya.mjs").replace(/^\/\/.*$/gm, "")).not.toMatch(/npx|npm|spawn|exec/);
  });

  it("no npx anywhere, exec form, OSS is advisory (fails open)", () => {
    expect(read("plugins/kya/hooks/hooks.json") + read("plugins/kya/.mcp.json")).not.toMatch(/npx/);
    for (const event of ["SessionStart", "PreToolUse"]) {
      expect(hook(event).command).toBe("node");
      expect(Array.isArray(hook(event).args)).toBe(true);
    }
    const pre = hook("PreToolUse");
    expect(pre).not.toHaveProperty("onFailure");
    expect(pre.args.join(" ")).not.toMatch(/--strict|--fail-closed/);
    expect(pre.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/scripts/kya.mjs", "hook", "--host", "claude"]);
    expect(hook("SessionStart").onFailure).toBe("block");
  });

  it("MCP server cannot reach a routable host, and no config names a credential variable", () => {
    const s = json("plugins/kya/.mcp.json").mcpServers["shield-kya"];
    expect(s.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/scripts/kya.mjs", "serve-mcp", "--stdio"]);
    // Older Claude Code may not export CLAUDE_PLUGIN_DATA to MCP servers, so the config passes it by substitution.
    expect(s.env).toEqual({ KYA_OFFLINE: "1", KYA_HOST: "ide", KYA_BASE_URL: "http://127.0.0.1:1", CLAUDE_PLUGIN_DATA: "${CLAUDE_PLUGIN_DATA}" });
    expect(read("plugins/kya/.mcp.json") + read("plugins/kya/hooks/hooks.json")).not.toMatch(/API_KEY|TOKEN|SECRET/);
  });
});

describe("bootstrap.mjs", () => {
  const pinArg = `@shield-agent/kya@${version}`;
  const script = join(root, "plugins/kya/scripts/bootstrap.mjs");
  const run = (data: string, env: Record<string, string> = {}) => runHandler("SessionStart", data, env);
  const pkgDir = (data: string) => join(data, "node_modules/@shield-agent/kya");
  const seed = (data: string, v: string, cliBody?: string) => {
    mkdirSync(join(pkgDir(data), "dist"), { recursive: true });
    writeFileSync(join(pkgDir(data), "package.json"), JSON.stringify({ version: v }));
    if (cliBody !== undefined) writeFileSync(join(pkgDir(data), "dist/cli.js"), cliBody);
  };
  const leftovers = (data: string) => readdirSync(data).filter((f) => /^\.(install|old|rc)-/.test(f));
  const noNpm = () => ({ PATH: tmp() }); // process.execPath is absolute, so node still starts

  /** A fake `npm` on PATH: logs argv, cwd, env and the planted-npmrc state, then lays down an install. POSIX only. */
  function fakeNpm(opts: { cliBody?: string; fail?: boolean; sleep?: number; lockStage?: boolean } = {}) {
    const { cliBody = "process.exit(0);", fail = false, sleep = 0, lockStage = false } = opts;
    const bin = tmp();
    const log = join(bin, "npm.log");
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh
{ echo "ARGS:$*"; echo "CWD:$(pwd)"; env; } >> "${log}"
d=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && d="$2"; shift; done
echo "NPMRC_PRESENT:$([ -e "$(dirname "$d")/.npmrc" ] && echo yes || echo no)" >> "${log}"
${sleep ? `sleep ${sleep}` : ""}
${fail ? 'echo "npm error code ECONNREFUSED" >&2; exit 1' : ""}
mkdir -p "$d/node_modules/@shield-agent/kya/dist"
echo '{"version":"${version}"}' > "$d/node_modules/@shield-agent/kya/package.json"
echo '${cliBody}' > "$d/node_modules/@shield-agent/kya/dist/cli.js"
${lockStage ? 'chmod 555 "$d"' : ""}
`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    return { PATH: `${bin}:${process.env.PATH}`, log, calls: () => (existsSync(log) ? (readFileSync(log, "utf8").match(/^ARGS:/gm) ?? []).length : 0) };
  }

  it("takes the pin from the plugin manifest when hooks.json passes none", () => {
    const data = tmp();
    seed(data, version, "process.exit(0);");
    expect(hook("SessionStart").args).toHaveLength(1);
    expect(run(data, noNpm()).stdout).toBe(""); // complete at the manifest version: silent, no npm
    const old = tmp();
    seed(old, "0.0.1", "process.exit(0);"); // stale: npm is needed, and it is absent here
    expect(JSON.parse(run(old, noNpm()).stdout).systemMessage).toContain("npm was not found");
  });

  it.skipIf(!posix)("installs exactly the manifest version when no pin argument is given", () => {
    const data = tmp();
    const npm = fakeNpm();
    expect(run(data, { PATH: npm.PATH }).stdout).toBe("");
    expect(/^ARGS:(.*)$/m.exec(readFileSync(npm.log, "utf8"))![1]).toContain(pinArg);
  });

  it("is silent and does not touch npm when the pinned kya is complete", () => {
    const data = tmp();
    seed(data, version, "process.exit(0);");
    const r = run(data, noNpm());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  /** Run SessionStart with process.versions.node faked to `v` (preloaded), the rest as Claude Code does. */
  const runAs = (v: string, data: string, env: Record<string, string>) => {
    const pluginRoot = join(root, "plugins/kya");
    const sub = (s: string) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot).replaceAll("${CLAUDE_PLUGIN_DATA}", data);
    const fake = `data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"${v}"}})`;
    return spawnSync(process.execPath, ["--import", fake, ...hook("SessionStart").args.map(sub)], {
      encoding: "utf8",
      env: { PATH: env.PATH ?? "", CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: data },
    });
  };

  it("Node floor: 22/23/24 silent, 20/21 one 'unsupported but works' note, 18 'not supported', always exit 0", () => {
    const data = tmp();
    seed(data, version, "process.exit(0);");
    for (const v of ["22.0.0", "22.23.3", "23.11.1", "24.21.0"]) {
      const r = runAs(v, data, noNpm());
      expect(r.status, v).toBe(0);
      expect(r.stdout, v).toBe("");
    }
    for (const v of ["21.7.3", "20.20.2"]) {
      const r = runAs(v, data, noNpm());
      expect(r.status, v).toBe(0);
      expect(JSON.parse(r.stdout).systemMessage).toBe(`Shield KYA: Node ${v} is unsupported but works; kya supports Node.js 22+ (24 recommended).`);
    }
    const old = runAs("18.20.8", data, noNpm());
    expect(old.status).toBe(0);
    const msg = JSON.parse(old.stdout).systemMessage as string;
    expect(msg).toContain("Node 18.20.8 is not supported by kya");
    expect(msg).not.toMatch(/works/);
  });

  it("npm missing gives a loud NOT recording message and exit 0", () => {
    const r = run(tmp(), noNpm());
    expect(r.status).toBe(0);
    const msg = JSON.parse(r.stdout).systemMessage as string;
    expect(msg).toContain("Shield KYA is NOT recording");
    expect(msg).toContain("npm was not found");
  });

  it.skipIf(!posix)("installs hardened into a staging prefix and swaps it in", () => {
    const data = tmp();
    writeFileSync(join(data, ".npmrc"), "@shield-agent:registry=http://evil.invalid/\n");
    const npm = fakeNpm();
    const r = run(data, {
      PATH: npm.PATH,
      npm_config_registry: "http://evil.invalid/",
      NPM_CONFIG_USERCONFIG: "/evil/npmrc",
      npm_config_ignore_scripts: "false",
      NODE_OPTIONS: "--no-warnings",
      HTTPS_PROXY: "http://proxy.corp:3128",
      KEEP_ME: "1",
      NPM_TOKEN: "npm-secret",
      GITHUB_TOKEN: "gh-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      OPENAI_API_KEY: "sk-secret",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const log = readFileSync(npm.log, "utf8");
    const args = /^ARGS:(.*)$/m.exec(log)![1];
    for (const flag of ["--ignore-scripts", "--omit=optional", "--registry=https://registry.npmjs.org/", pinArg]) expect(args).toContain(flag);
    const user = /--userconfig=(\S+)/.exec(args)![1];
    const glob = /--globalconfig=(\S+)/.exec(args)![1];
    expect(user).not.toBe(glob); // npm refuses one file as both
    expect(log).toMatch(/^CWD:.*\.install-\d+$/m);
    expect(log).not.toMatch(/^npm_config_/im);
    expect(log).not.toMatch(/^NODE_OPTIONS=/m);
    expect(log).toContain("KEEP_ME=1");
    expect(log).not.toMatch(/secret|NPM_TOKEN|GITHUB_TOKEN|API_KEY/i); // no credential from the user's machine reaches npm
    expect(log).toContain("HTTPS_PROXY=http://proxy.corp:3128"); // proxy env is honored on purpose
    expect(log).toContain("NPMRC_PRESENT:no");
    expect(existsSync(join(pkgDir(data), "dist/cli.js"))).toBe(true);
    expect(leftovers(data)).toEqual([]);
    expect(existsSync(join(data, ".bootstrap.lock"))).toBe(false);
  });

  it.skipIf(!posix)("detects a partial install (version ok, no dist) and replaces it", () => {
    const data = tmp();
    seed(data, version); // package.json at the pin, no dist/cli.js
    const npm = fakeNpm();
    expect(run(data, { PATH: npm.PATH }).stdout).toBe("");
    expect(npm.calls()).toBe(1);
    expect(existsSync(join(pkgDir(data), "dist/cli.js"))).toBe(true);
  });

  it.skipIf(!posix)("a stale version is upgraded; the old tree is gone afterwards", () => {
    const data = tmp();
    seed(data, "0.0.1", "process.exit(0);");
    writeFileSync(join(pkgDir(data), "old-marker"), "");
    const npm = fakeNpm();
    expect(run(data, { PATH: npm.PATH }).stdout).toBe("");
    expect(JSON.parse(readFileSync(join(pkgDir(data), "package.json"), "utf8")).version).toBe(version);
    expect(existsSync(join(pkgDir(data), "old-marker"))).toBe(false);
    expect(leftovers(data)).toEqual([]);
  });

  it.skipIf(!posix)("a failed upgrade (dead network) keeps the working copy and still reports", () => {
    const data = tmp();
    seed(data, "0.0.1", "process.exit(0);");
    writeFileSync(join(pkgDir(data), "old-marker"), "");
    const r = run(data, { PATH: fakeNpm({ fail: true }).PATH });
    expect(JSON.parse(r.stdout).systemMessage).toContain("ECONNREFUSED");
    expect(JSON.parse(readFileSync(join(pkgDir(data), "package.json"), "utf8")).version).toBe("0.0.1");
    expect(existsSync(join(pkgDir(data), "old-marker"))).toBe(true);
    expect(existsSync(join(pkgDir(data), "dist/cli.js"))).toBe(true);
    expect(leftovers(data)).toEqual([]);
    expect(existsSync(join(data, ".bootstrap.lock"))).toBe(false);
  });

  it.skipIf(!posix)("an install whose entry does not load is rejected before the swap", () => {
    const data = tmp();
    seed(data, "0.0.1", "process.exit(0);");
    const r = run(data, { PATH: fakeNpm({ cliBody: "process.exit(1);" }).PATH });
    expect(JSON.parse(r.stdout).systemMessage).toContain("installed incompletely");
    expect(JSON.parse(readFileSync(join(pkgDir(data), "package.json"), "utf8")).version).toBe("0.0.1");
    expect(leftovers(data)).toEqual([]);
  });

  it.skipIf(!posix || process.getuid?.() === 0)(
    "an unmovable stage dir rolls the swap back, keeps the working copy, cannot be cleaned up, and still exits 0 with the lock released",
    () => {
      const data = tmp();
      seed(data, "0.0.1", "process.exit(0);");
      writeFileSync(join(pkgDir(data), "old-marker"), "");
      // The staged tree verifies, but its parent is read-only, so renaming node_modules out of it fails.
      const r = run(data, { PATH: fakeNpm({ lockStage: true }).PATH });
      try {
        expect(r.status).toBe(0);
        const msg = JSON.parse(r.stdout).systemMessage as string;
        expect(msg).toContain("Keeping the previous version");
        expect(msg).not.toContain("NOT recording"); // the kept copy still records
        expect(msg).toContain("could not delete"); // the undeletable stage dir is reported, not thrown
        expect(JSON.parse(readFileSync(join(pkgDir(data), "package.json"), "utf8")).version).toBe("0.0.1");
        expect(existsSync(join(pkgDir(data), "old-marker"))).toBe(true); // rollback restored the old tree
        expect(readdirSync(data).filter((f) => f.startsWith(".old-"))).toEqual([]);
        expect(existsSync(join(data, ".bootstrap.lock"))).toBe(false);
      } finally {
        for (const f of readdirSync(data).filter((n) => n.startsWith(".install-"))) chmodSync(join(data, f), 0o755);
      }
    },
  );

  it("a session that loses the install lock says so loudly", () => {
    const data = tmp();
    writeFileSync(join(data, ".bootstrap.lock"), "");
    const r = run(data, noNpm());
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toContain("another session is installing");
  });

  it.skipIf(!posix)("a stale lock is cleaned up and the install proceeds", () => {
    const data = tmp();
    const lock = join(data, ".bootstrap.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lock, old, old);
    const npm = fakeNpm();
    expect(run(data, { PATH: npm.PATH }).stdout).toBe("");
    expect(npm.calls()).toBe(1);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(data).filter((f) => f.includes("stale"))).toEqual([]);
  });

  it.skipIf(!posix)("concurrent sessions make one npm call; losers say so", async () => {
    const data = tmp();
    const npm = fakeNpm({ sleep: 1 });
    const one = () =>
      new Promise<string>((resolve) => {
        const c = spawn(process.execPath, [script, pinArg], { env: { PATH: npm.PATH, CLAUDE_PLUGIN_DATA: data } });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.on("close", () => resolve(out));
      });
    const outs = await Promise.all([one(), one(), one(), one()]);
    expect(npm.calls()).toBe(1);
    expect(outs.filter((o) => o === "")).toHaveLength(1);
    expect(outs.filter((o) => o.includes("another session is installing"))).toHaveLength(3);
    expect(existsSync(join(pkgDir(data), "dist/cli.js"))).toBe(true);
  });

  it.skipIf(!posix)("re-checks after taking the lock: a session that finished meanwhile is not reinstalled over", async () => {
    const data = tmp();
    const flag = join(tmp(), "ready");
    // The load check fails (after 1.5 s) until the flag exists, like a tree another session is still finishing.
    seed(data, version, `const fs=require("fs");if(fs.existsSync(${JSON.stringify(flag)}))process.exit(0);setTimeout(()=>process.exit(1),1500);`);
    const npm = fakeNpm();
    const c = spawn(process.execPath, [script, pinArg], { env: { PATH: npm.PATH, CLAUDE_PLUGIN_DATA: data } });
    const closed = new Promise((resolve) => c.on("close", resolve));
    await new Promise((r) => setTimeout(r, 500));
    writeFileSync(flag, ""); // the other session is done; our first check is already in flight and will fail
    await closed;
    expect(npm.calls()).toBe(0);
  });

  it.skipIf(!posix)("SIGTERM during the install releases the lock and removes staging", async () => {
    const data = tmp();
    const npm = fakeNpm({ sleep: 30 });
    const c = spawn(process.execPath, [script, pinArg], { env: { PATH: npm.PATH, CLAUDE_PLUGIN_DATA: data } });
    const closed = new Promise<number | null>((resolve) => c.on("close", resolve));
    for (let i = 0; i < 100 && !existsSync(npm.log); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(npm.log)).toBe(true);
    expect(existsSync(join(data, ".bootstrap.lock"))).toBe(true);
    c.kill("SIGTERM");
    expect(await closed).toBe(143);
    expect(existsSync(join(data, ".bootstrap.lock"))).toBe(false);
    expect(leftovers(data)).toEqual([]);
  });

  it("rejects ranges, non-semver and shell-ish pins, and a missing data dir, without crashing", () => {
    // Built by concatenation so check-version-pins does not read these as live pins.
    const at = (v: string) => `@shield-agent/kya${"@"}${v}`;
    const bad = ["^0.23.2", "latest", "01.2.3", "0.23.2-.", "0.23.2 && x", "0.23.2\n", "0.23"].map(at).concat("kya@latest");
    for (const b of bad) {
      const r = spawnSync(process.execPath, [script, b], { encoding: "utf8", env: { CLAUDE_PLUGIN_DATA: tmp() } });
      expect(r.status, b).toBe(0);
      expect(JSON.parse(r.stdout).systemMessage, b).toContain("bad kya pin");
    }
    for (const ok of ["0.23.2-beta.1", "10.0.0"].map(at)) {
      const r = spawnSync(process.execPath, [script, ok], { encoding: "utf8", env: { PATH: tmp(), CLAUDE_PLUGIN_DATA: tmp() } });
      expect(r.stdout, ok).not.toContain("bad kya pin");
    }
    const nodata = spawnSync(process.execPath, [script, pinArg], { encoding: "utf8", env: {} });
    expect(nodata.status).toBe(0);
    expect(JSON.parse(nodata.stdout).systemMessage).toContain("CLAUDE_PLUGIN_DATA is not set");
  });
});

describe("e2e: hooks.json handlers against the built kya", () => {
  const haveDist = existsSync(cliJs);
  const rows = (kyaHome: string) => {
    const f = join(kyaHome, ".kya/trail.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  /** A DATA dir whose installed kya is the working tree (symlink), so the real hook command runs. */
  function dataWithKya(): string {
    const data = tmp();
    mkdirSync(join(data, "node_modules/@shield-agent"), { recursive: true });
    symlinkSync(root, join(data, "node_modules/@shield-agent/kya"));
    return data;
  }

  it.skipIf(!haveDist)("ALLOW records one row, never-list DENY blocks, repeat dedupes", () => {
    const data = dataWithKya();
    const kyaHome = tmp();
    const pre = (tool: string, id: string) => runHandler("PreToolUse", data, { KYA_HOME: kyaHome }, payload(tool, id));

    expect(pre("Read", "toolu_allow1").status).toBe(0);
    expect(rows(kyaHome)).toHaveLength(1);

    const deny = pre("mcp__postgres__drop_table", "toolu_deny1");
    expect(deny.status).toBe(2);
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(rows(kyaHome)).toHaveLength(2);

    expect(pre("mcp__postgres__drop_table", "toolu_deny1").status).toBe(2);
    expect(pre("Read", "toolu_allow1").status).toBe(0);
    expect(rows(kyaHome)).toHaveLength(2);
  });

  it.skipIf(!haveDist)("the bootstrap load check accepts the real build", () => {
    const data = dataWithKya();
    const r = runHandler("SessionStart", data, { PATH: tmp() });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("with kya missing the hook exits non-0/2, which the host treats as non-blocking (fail open)", () => {
    const r = runHandler("PreToolUse", tmp(), { KYA_HOME: tmp() }, payload("Read", "toolu_m1"));
    expect([0, 2]).not.toContain(r.status);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("kya is not installed yet");
    // The same shim starts the MCP server; with no copy it also fails cleanly, not with a stack trace.
    const mcp = spawnSync(process.execPath, [join(root, "plugins/kya/scripts/kya.mjs"), "serve-mcp", "--stdio"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(mcp.status).toBe(1);
    expect(mcp.stderr).toContain("kya is not installed yet");
  });

  it.skipIf(!haveDist)("MCP server starts through the shim and answers initialize and tools/list", async () => {
    const data = dataWithKya();
    const server = json("plugins/kya/.mcp.json").mcpServers["shield-kya"];
    const child = spawn(process.execPath, server.args.map((a: string) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", join(root, "plugins/kya"))), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", KYA_HOME: tmp(), ...Object.fromEntries(Object.entries(server.env as Record<string, string>).map(([k, v]) => [k, v.replaceAll("${CLAUDE_PLUGIN_DATA}", data)])) },
    });
    try {
      const replies: Record<number, any> = {};
      const polluted: string[] = [];
      let acc = "";
      child.stdout.on("data", (d) => {
        acc += d;
        for (let i = acc.indexOf("\n"); i >= 0; i = acc.indexOf("\n")) {
          const line = acc.slice(0, i).trim();
          acc = acc.slice(i + 1);
          if (!line) continue;
          let m: any;
          try { m = JSON.parse(line); } catch { m = undefined; }
          if (m?.jsonrpc !== "2.0") polluted.push(line); // any other stdout line is pollution
          else if (m.id !== undefined) replies[m.id] = m;
        }
      });
      const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "plugin-test", version: "0" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      for (let i = 0; i < 300 && !(replies[1] && replies[2]); i++) await new Promise((r) => setTimeout(r, 50));
      expect(replies[1]?.result?.serverInfo, JSON.stringify(replies)).toBeTruthy();
      expect((replies[2]?.result?.tools ?? []).length).toBeGreaterThan(0);
      expect(polluted, "non-JSON-RPC lines on stdout").toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30000);

  it("a kya that throws on import: the hook exits non-0/2 with empty stdout (fail open)", () => {
    const data = tmp();
    const dir = join(data, "node_modules/@shield-agent/kya/dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli.js"), 'throw new Error("boom");\n');
    const r = runHandler("PreToolUse", data, { KYA_HOME: tmp() }, payload("Read", "toolu_broken"));
    expect([0, 2]).not.toContain(r.status);
    expect(r.stdout).toBe("");
  });

  it("an unexpanded or relative CLAUDE_PLUGIN_DATA never loads code from the project (fail open)", () => {
    const project = tmp();
    const marker = join(project, "PWNED");
    for (const value of ["${CLAUDE_PLUGIN_DATA}", "rel-data"]) {
      // A repository could ship a fake kya at the path a literal or relative value resolves to.
      const dir = join(project, value, "node_modules/@shield-agent/kya/dist");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cli.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
      const r = spawnSync(process.execPath, [join(root, "plugins/kya/scripts/kya.mjs"), "hook", "--host", "claude"], {
        cwd: project,
        input: payload("Read", "toolu_unexpanded"),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_DATA: value, KYA_HOME: tmp() },
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("the shim passes argv, stdin and the exit code through, and drops an ambient hosted key", () => {
    const data = tmp();
    const dir = join(data, "node_modules/@shield-agent/kya/dist");
    mkdirSync(dir, { recursive: true });
    // A stand-in kya: kya starts only when it is the entry file, like the real cli.js.
    writeFileSync(
      join(dir, "cli.js"),
      `if (process.argv[1] !== ${JSON.stringify(join(dir, "cli.js"))}) process.exit(9);
let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin: d, key: process.env.KYA_API_KEY ?? null, shield: process.env.SHIELD_API_KEY ?? null, offline: process.env.KYA_OFFLINE ?? null }));
  process.exitCode = 2;
});`,
    );
    const r = runHandler("PreToolUse", data, { KYA_API_KEY: "secret-key", SHIELD_API_KEY: "secret-2", KYA_OFFLINE: "1" }, "PAYLOAD");
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ argv: ["hook", "--host", "claude"], stdin: "PAYLOAD", key: null, shield: null, offline: "1" });
  });
});
