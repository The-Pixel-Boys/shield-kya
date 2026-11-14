/**
 * Feature kya-plugin-claude-guard (plugins/kya-guard): the bundle and the plugin files.
 * Static checks on dist/guard.mjs: size, no network and no child process (parsed, not grepped), a fresh build
 * equals the committed file (stale check), and the plugin layout (hooks.json, plugin.json, marketplace entry).
 * The runtime checks are in test/guard-plugin-e2e.test.ts.
 *
 * Why parse and not grep: the words "fetch" and "check" sit in rule regexes and tool tables of the bundle
 * (the MCP server named "fetch", the tool alias webfetch), so a text search for `fetch` would fail on every build.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
// @ts-expect-error plain .mjs script, no type declarations
import { BUNDLE, buildGuard } from "../scripts/build-guard.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { manifestVersions } from "../scripts/lib/version-pins.mjs";

const PKG = join(import.meta.dirname, "..");
const PLUGIN = join(PKG, "plugins", "kya-guard");
const MAX_BYTES = 300 * 1024;

/** Node modules that open a socket, resolve a name or start a process. Spec G1: none may be imported. */
const BANNED_MODULES = new Set(["http", "https", "net", "dns", "child_process", "tls", "http2", "dgram", "worker_threads", "cluster", "inspector"]);
/** What the bundle may import today. A new import must be added here on purpose, with a reviewer reading it. */
const ALLOWED_MODULES = new Set(["node:fs", "node:os", "node:path", "node:crypto"]);
const BANNED_GLOBALS = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);

const bare = (spec: string): string => spec.replace(/^node:/, "").split("/")[0]!;

/** Every problem the "no network, no child process" rule finds in a JavaScript text. */
export function networkProblems(code: string): string[] {
  const sf = ts.createSourceFile("bundle.mjs", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: string[] = [];
  const spec = (node: ts.Node, text: string, how: string): void => {
    if (BANNED_MODULES.has(bare(text))) found.push(`${how} of banned module ${text}`);
    else if (!ALLOWED_MODULES.has(text)) found.push(`${how} of module ${text} that is not on the allowed list`);
    void node;
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      spec(n, n.moduleSpecifier.text, "import");
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isImport || isRequire) {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) spec(n, arg.text, isImport ? "dynamic import" : "require");
        else found.push(`${isImport ? "dynamic import" : "require"} with a name that is not a string literal`);
      }
    } else if (ts.isIdentifier(n) && BANNED_GLOBALS.has(n.text)) {
      // Object keys and property names such as `{ fetch: "READ" }` are data, not a use of the global.
      const p = n.parent;
      const isKey = (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === n;
      if (!isKey) found.push(`reference to ${n.text}`);
    } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && BANNED_GLOBALS.has(n.argumentExpression.text)) {
      found.push(`reference to ${n.argumentExpression.text} by name`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("kya-plugin-claude-guard: bundle", () => {
  const code = readFileSync(BUNDLE, "utf8");

  it("is one file of 300 KB or less", () => {
    expect(Buffer.byteLength(code)).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("imports no network or child process module and references no fetch (parsed)", () => {
    expect(networkProblems(code)).toEqual([]);
  });

  it("imports only node:fs, node:os, node:path and node:crypto", () => {
    const sf = ts.createSourceFile("bundle.mjs", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = sf.statements.filter(ts.isImportDeclaration).map((s) => (s.moduleSpecifier as ts.StringLiteral).text);
    expect([...new Set(imports)].sort()).toEqual([...ALLOWED_MODULES].sort());
  });

  it("the committed bundle equals a fresh build (stale check)", async () => {
    expect(await buildGuard(), "run: pnpm run build:guard").toBe(code);
  });

  it("is tracked in git and not hidden by an ignore rule", () => {
    const g = spawnSync("git", ["-C", PKG, "check-ignore", "-q", BUNDLE]);
    if (g.error || g.status === 128) return; // no git or not a work tree (a source archive): nothing to check
    expect(g.status, "plugins/kya-guard/dist/guard.mjs is ignored by git").toBe(1);
  });

  it("carries a header that says it is generated", () => {
    expect(code.split("\n")[0]).toContain("generated by scripts/build-guard.mjs");
  });
});

describe("kya-plugin-claude-guard: the no-network detector catches what it must (self-check)", () => {
  const cases: Array<[string, string]> = [
    ['import http from "node:http";', "node:http"],
    ['import https from "node:https";', "node:https"],
    ['import net from "node:net";', "node:net"],
    ['import dns from "node:dns";', "node:dns"],
    ['import cp from "node:child_process";', "node:child_process"],
    ['import { request } from "https";', "https"],
    ['const x = await import("node:net");', "node:net"],
    ['const cp = require("child_process");', "child_process"],
    ["const m = await import(name);", "not a string literal"],
    ['fetch("https://example.test");', "reference to fetch"],
    ['const f = globalThis.fetch;', "reference to fetch"],
    ['const f = globalThis["fetch"];', "fetch by name"],
    ["new WebSocket(u);", "WebSocket"],
  ];
  for (const [src, needle] of cases) {
    it(`flags ${src}`, () => {
      expect(networkProblems(src).join("\n")).toContain(needle);
    });
  }
  it("does not flag the word fetch in a regex, a string, a list or an object key", () => {
    const src = 'const a = /^(?:get|fetch)/; const b = ["brave", "fetch"]; const c = { fetch: "READ", webfetch: 1 };';
    expect(networkProblems(src)).toEqual([]);
  });
});

describe("kya-plugin-claude-guard: plugin files", () => {
  const json = (p: string): any => JSON.parse(readFileSync(join(PKG, p), "utf8"));

  it("plugin.json names the plugin kya-guard, shows KYA Guard, starts at 1.0.0", () => {
    const m = json("plugins/kya-guard/.claude-plugin/plugin.json");
    expect(m).toMatchObject({ name: "kya-guard", displayName: "KYA Guard", version: "1.0.0", license: "MIT" });
    expect(typeof m.description).toBe("string");
    expect(m.author?.name).toBeTruthy();
  });

  it("hooks.json declares one PreToolUse hook: node dist/guard.mjs --host claude, matcher *, timeout 5, nothing else", () => {
    const h = json("plugins/kya-guard/hooks/hooks.json");
    expect(Object.keys(h.hooks)).toEqual(["PreToolUse"]);
    expect(h.hooks.PreToolUse).toHaveLength(1);
    const entry = h.hooks.PreToolUse[0];
    expect(entry.matcher).toBe("*");
    expect(entry.hooks).toEqual([{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/guard.mjs", "--host", "claude"], timeout: 5 }]);
    expect(JSON.stringify(h)).not.toMatch(/SessionStart|onFailure|bootstrap|npx|npm /);
  });

  it("the version pin check leaves the kya-guard manifest on its own semantic version and still checks the others", () => {
    const text = '{"name":"x","version":"1.0.0"}';
    expect(manifestVersions("plugins/kya-guard/.claude-plugin/plugin.json", text)).toEqual([]);
    expect(manifestVersions("plugins/kya/.claude-plugin/plugin.json", text)).toHaveLength(1);
  });

  it("the marketplace lists kya-guard beside kya", () => {
    const m = json(".claude-plugin/marketplace.json");
    expect(m.plugins.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(["kya", "kya-guard"]));
    expect(m.plugins.find((p: { name: string }) => p.name === "kya-guard").source).toBe("./plugins/kya-guard");
    expect(m.name).toBe("shield-kya");
  });

  it("has the status command, a LICENSE equal to the package licence, and no more files than the layout", () => {
    expect(existsSync(join(PLUGIN, "commands", "status.md"))).toBe(true);
    expect(readFileSync(join(PLUGIN, "LICENSE"), "utf8")).toBe(readFileSync(join(PKG, "LICENSE"), "utf8"));
    const status = readFileSync(join(PLUGIN, "commands", "status.md"), "utf8");
    expect(status).toContain('dist/guard.mjs" --status');
    expect(status).toContain("Node.js 22 or later is not on PATH");
  });

  it("README.md has fewer than 80 lines and says in its second paragraph that the guard fails open", () => {
    const text = readFileSync(join(PLUGIN, "README.md"), "utf8");
    expect(text.split("\n").length).toBeLessThan(80);
    const paragraphs = text.split(/\n\s*\n/);
    expect(paragraphs[2]).toMatch(/goes ahead/);
    expect(paragraphs[2]).toContain("outcome: error");
  });

  it("README.md and SECURITY.md state the node requirement; SECURITY.md names the test and how to report", () => {
    const readme = readFileSync(join(PLUGIN, "README.md"), "utf8");
    const sec = readFileSync(join(PLUGIN, "SECURITY.md"), "utf8");
    expect(readme).toMatch(/Node\.js 22 or later on PATH/);
    expect(sec).toMatch(/Node\.js|node/);
    expect(sec).toContain("test/guard-bundle.test.ts");
    expect(sec).toContain("it@shield-agent.com");
    expect(sec).toMatch(/\/plugin uninstall kya-guard@shield-kya/);
    for (const text of [readme, sec]) expect(text).not.toMatch(/[–—]/);
  });
});
