/**
 * Version-drift guard for plugin / marketplace / extension manifests. Their `version`
 * fields must equal package.json; `syncTree` (used by sync-version.mjs) rewrites exactly
 * those fields in place. Absent manifests and absent extra roots are skipped.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { findVersionDrift } from "../scripts/check-version-pins.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { syncTree } from "../scripts/lib/version-pins.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The package lives at <tmp>/sdks/kya so the extra roots (../kya-vscode, ../../integrations)
// resolve inside the temp tree instead of polluting the real tmpdir.
let repo: string;
let dir: string;

function put(rel: string, body: string, base = dir): void {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
const read = (rel: string, base = dir): string => readFileSync(join(base, rel), "utf8");

function fixture(version: string): void {
  put("package.json", JSON.stringify({ name: "@shield-agent/kya", version }));
  put("server.json", JSON.stringify({ version, packages: [{ version }] }));
  put("manifest.json", JSON.stringify({ version }));
}

const WRONG = "0.0.1";
// Deliberately awkward formatting: tab indent, inline array, other "version" keys, no trailing newline.
const MANIFEST_FILES: Record<string, string> = {
  ".claude-plugin/marketplace.json": `{\n\t"name": "m",\n\t"metadata": { "version": "${WRONG}" },\n\t"plugins": [\n\t\t{ "name": "a", "version": "${WRONG}", "tags": ["x", "y"] },\n\t\t{ "name": "b", "version": "${WRONG}" }\n\t]\n}`,
  "claude/.claude-plugin/plugin.json": `{\n  "name": "p",\n  "version": "${WRONG}",\n  "dependencies": { "z": { "version": "9.9.9" } }\n}\n`,
  ".codex-plugin/plugin.json": `{ "name": "c", "version": "${WRONG}" }\n`,
  ".agents/plugins/marketplace.json": `{\n  "plugins": [{ "name": "a", "version": "${WRONG}" }]\n}\n`,
  "gemini/gemini-extension.json": `{\n  "name": "g",\n  "version": "${WRONG}"\n}\n`,
  ".cursor-plugin/plugin.json": `{\n  "name": "k",\n  "version": "${WRONG}",\n  "keywords": ["a", "b"]\n}\n`,
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kya-pin-manifests-"));
  dir = join(repo, "sdks/kya");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("manifest version drift", () => {
  it("reports every wrong manifest version, then sync fixes them all in place", () => {
    fixture("1.2.3");
    for (const [rel, body] of Object.entries(MANIFEST_FILES)) put(rel, body);
    const before = Object.fromEntries(Object.keys(MANIFEST_FILES).map((rel) => [rel, read(rel)]));

    expect([...findVersionDrift(dir)].sort()).toEqual([
      ".agents/plugins/marketplace.json: plugins[0].version 0.0.1 (package.json is 1.2.3)",
      ".claude-plugin/marketplace.json: plugins[0].version 0.0.1 (package.json is 1.2.3)",
      ".claude-plugin/marketplace.json: plugins[1].version 0.0.1 (package.json is 1.2.3)",
      ".claude-plugin/marketplace.json: metadata.version 0.0.1 (package.json is 1.2.3)",
      ".codex-plugin/plugin.json: version 0.0.1 (package.json is 1.2.3)",
      ".cursor-plugin/plugin.json: version 0.0.1 (package.json is 1.2.3)",
      "claude/.claude-plugin/plugin.json: version 0.0.1 (package.json is 1.2.3)",
      "gemini/gemini-extension.json: version 0.0.1 (package.json is 1.2.3)",
    ].sort());

    const changed = syncTree(dir, "1.2.3");

    expect([...changed].sort()).toEqual(Object.keys(MANIFEST_FILES).sort());
    expect(findVersionDrift(dir)).toEqual([]);
    // Only the version values changed: formatting, key order, other "version" keys, trailing newline.
    for (const rel of Object.keys(MANIFEST_FILES)) {
      expect(read(rel)).toBe(before[rel].replaceAll(`"version": "${WRONG}"`, `"version": "1.2.3"`));
    }
    expect(read("claude/.claude-plugin/plugin.json")).toContain('"z": { "version": "9.9.9" }');
    expect(syncTree(dir, "1.2.3")).toEqual([]);
  });

  it("skips absent manifests, absent optional fields and absent extra roots", () => {
    fixture("1.2.3");
    put(".claude-plugin/marketplace.json", JSON.stringify({ name: "m", plugins: [{ name: "a" }] }));
    put("docs/gemini-extension.json.md", "not a manifest\n");

    expect(findVersionDrift(dir)).toEqual([]);
    expect(syncTree(dir, "1.2.3")).toEqual([]);
    expect(existsSync(join(repo, "sdks/kya-vscode"))).toBe(false);
    expect(existsSync(join(repo, "integrations"))).toBe(false);
  });

  it("scans extra roots for pins and manifests when they exist", () => {
    fixture("1.2.3");
    put("README.md", "npx @shield-agent/kya@0.5.0 serve-mcp\n", join(repo, "sdks/kya-vscode"));
    put("acme/.claude-plugin/plugin.json", `{ "version": "${WRONG}" }\n`, join(repo, "integrations"));

    expect([...findVersionDrift(dir)].sort()).toEqual([
      "../../integrations/acme/.claude-plugin/plugin.json: version 0.0.1 (package.json is 1.2.3)",
      "../kya-vscode/README.md: pins @shield-agent/kya@0.5.0 (package.json is 1.2.3)",
    ]);

    syncTree(dir, "1.2.3");

    expect(findVersionDrift(dir)).toEqual([]);
    expect(read("README.md", join(repo, "sdks/kya-vscode"))).toBe("npx @shield-agent/kya@1.2.3 serve-mcp\n");
  });

  it("fails loudly on a malformed manifest instead of passing silently", () => {
    fixture("1.2.3");
    put(".codex-plugin/plugin.json", "{ not json");

    expect(() => findVersionDrift(dir)).toThrow(/\.codex-plugin\/plugin\.json: cannot parse manifest/);
  });

  it("sync-version.mjs CLI rewrites manifests and check-version-pins.mjs then exits 0", () => {
    fixture("1.2.3");
    for (const [rel, body] of Object.entries(MANIFEST_FILES)) put(rel, body);
    cpSync(join(PACKAGE_ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
    const check = join(dir, "scripts/check-version-pins.mjs");

    expect(() => execFileSync("node", [check], { stdio: "pipe" })).toThrow();
    execFileSync("node", [join(dir, "scripts/sync-version.mjs")]);
    expect(execFileSync("node", [check], { encoding: "utf8" })).toContain("version pins OK");
  });
});

describe("this repository", () => {
  it("has no manifest or pin drift (pnpm sync:version fixes any)", () => {
    expect(findVersionDrift(PACKAGE_ROOT)).toEqual([]);
  });
});
