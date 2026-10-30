/**
 * Version-drift guard. package.json is the single source of truth; every
 * `@shield-agent/kya@X.Y.Z` pin and the server.json / manifest.json version
 * fields must match it. History (CHANGELOG, lockfiles, node_modules) is exempt.
 *
 * Regression: docs/hosts/droid.md pinned 0.1.34 while the package was 0.21.0,
 * because sync-version.mjs only rewrote a hand-kept list that omitted it. The
 * scan is now tree-wide, so an unlisted file is caught and repaired.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { findVersionDrift } from "../scripts/check-version-pins.mjs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let dir: string;

function put(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function fixture(version: string): void {
  put("package.json", JSON.stringify({ name: "@shield-agent/kya", version }));
  put("server.json", JSON.stringify({ version, packages: [{ version }] }));
  put("manifest.json", JSON.stringify({ version }));
  put("README.md", `npx @shield-agent/kya@${version} start\n`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-pins-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findVersionDrift", () => {
  it("is clean when every pin matches package.json", () => {
    fixture("1.2.3");
    expect(findVersionDrift(dir)).toEqual([]);
  });

  it("catches a stale pin in a file no hand-kept list mentions", () => {
    fixture("1.2.3");
    put("docs/hosts/new-host.md", 'host add "npx @shield-agent/kya@0.1.34 serve-mcp"\n');

    expect(findVersionDrift(dir)).toEqual([
      "docs/hosts/new-host.md: pins @shield-agent/kya@0.1.34 (package.json is 1.2.3)",
    ]);
  });

  it("matches prerelease pins exactly", () => {
    fixture("1.2.3-beta.1");
    put("docs/a.md", "@shield-agent/kya@1.2.3-beta.1 ok, @shield-agent/kya@1.2.3-beta.0 stale\n");

    expect(findVersionDrift(dir)).toEqual([
      "docs/a.md: pins @shield-agent/kya@1.2.3-beta.0 (package.json is 1.2.3-beta.1)",
    ]);
  });

  it("reports server.json and manifest.json version fields", () => {
    fixture("1.2.3");
    put("server.json", JSON.stringify({ version: "1.2.2", packages: [{ version: "1.2.1" }] }));
    put("manifest.json", JSON.stringify({ version: "1.0.0" }));

    expect(findVersionDrift(dir)).toEqual([
      "server.json: version 1.2.2 (package.json is 1.2.3)",
      "server.json: packages[0].version 1.2.1 (package.json is 1.2.3)",
      "manifest.json: version 1.0.0 (package.json is 1.2.3)",
    ]);
  });

  it("tolerates a server.json without a packages array", () => {
    fixture("1.2.3");
    put("server.json", JSON.stringify({ version: "1.2.3" }));

    expect(findVersionDrift(dir)).toEqual([]);
  });

  it("exempts history, build output, vendored code and scripts", () => {
    fixture("1.2.3");
    put("CHANGELOG.md", "was @shield-agent/kya@0.1.0\n");
    put("CHANGELOG-2025.md", "was @shield-agent/kya@0.1.0\n");
    put("pnpm-lock.yaml", "@shield-agent/kya@0.1.0\n");
    put("node_modules/x/readme.md", "@shield-agent/kya@0.1.0\n");
    put("dist/cli.js", "@shield-agent/kya@0.1.0\n");
    put("scripts/example.mjs", "// e.g. @shield-agent/kya@0.1.0\n");
    put("test/version-pins.test.ts", "@shield-agent/kya@0.1.0\n");
    put("image.png", "@shield-agent/kya@0.1.0\n");

    expect(findVersionDrift(dir)).toEqual([]);
  });
});

describe("sync-version.mjs", () => {
  it("rewrites pins in unlisted files and leaves history alone", () => {
    fixture("1.2.3");
    put("docs/hosts/new-host.md", "npx @shield-agent/kya@0.1.34 serve-mcp\n");
    put("CHANGELOG.md", "was @shield-agent/kya@0.1.0\n");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(PACKAGE_ROOT, "scripts"), join(dir, "scripts"), { recursive: true });

    const out = execFileSync("node", [join(dir, "scripts/sync-version.mjs")], { encoding: "utf8" });

    expect(out).toContain("docs/hosts/new-host.md");
    expect(readFileSync(join(dir, "docs/hosts/new-host.md"), "utf8")).toBe("npx @shield-agent/kya@1.2.3 serve-mcp\n");
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe("was @shield-agent/kya@0.1.0\n");
    expect(findVersionDrift(dir)).toEqual([]);
  });

  it("pushes package.json's version into server.json and manifest.json", () => {
    fixture("1.2.3");
    put("server.json", JSON.stringify({ version: "0.0.1", packages: [{ version: "0.0.1" }] }));
    put("manifest.json", JSON.stringify({ version: "0.0.1" }));
    cpSync(join(PACKAGE_ROOT, "scripts"), join(dir, "scripts"), { recursive: true });

    execFileSync("node", [join(dir, "scripts/sync-version.mjs")]);

    expect(JSON.parse(readFileSync(join(dir, "server.json"), "utf8"))).toEqual({
      version: "1.2.3",
      packages: [{ version: "1.2.3" }],
    });
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version).toBe("1.2.3");
  });
});

describe("check-version-pins.mjs CLI", () => {
  it("exits 1 and names the offender on drift, 0 when clean", () => {
    fixture("1.2.3");
    put("docs/old.md", "@shield-agent/kya@0.1.34\n");
    cpSync(join(PACKAGE_ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
    const script = join(dir, "scripts/check-version-pins.mjs");

    let failure: { status?: number; stderr?: Buffer } = {};
    try {
      execFileSync("node", [script], { stdio: "pipe" });
    } catch (e) {
      failure = e as { status?: number; stderr?: Buffer };
    }
    expect(failure.status).toBe(1);
    expect(String(failure.stderr)).toContain("docs/old.md");

    execFileSync("node", [join(dir, "scripts/sync-version.mjs")]);
    expect(execFileSync("node", [script], { encoding: "utf8" })).toContain("version pins OK");
  });
});

describe("Python shim (sdks/kya-python) moves with package.json", () => {
  // root = <base>/kya (the npm package), sibling = <base>/kya-python (the monorepo layout).
  let base: string;
  let root: string;
  let py: string;
  const write = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  const pyproject = (v: string) => `[project]\nname = "shield-kya"\nversion = "${v}"  # old note\ndescription = "x"\n`;
  const init = (v: string) => `import logging\n\n__version__ = "${v}"\n__all__ = []\n`;
  const lockstep = (v: string, pyV = v, initV = v) => {
    write(join(root, "package.json"), JSON.stringify({ name: "@shield-agent/kya", version: v }));
    write(join(root, "server.json"), JSON.stringify({ version: v, packages: [{ version: v }] }));
    write(join(root, "manifest.json"), JSON.stringify({ version: v }));
    write(join(py, "pyproject.toml"), pyproject(pyV));
    write(join(py, "shield_kya/__init__.py"), init(initV));
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kya-py-"));
    root = join(base, "kya");
    py = join(base, "kya-python");
    mkdirSync(root, { recursive: true });
    cpSync(join(PACKAGE_ROOT, "scripts"), join(root, "scripts"), { recursive: true });
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("is clean when pyproject.toml and __version__ equal package.json", () => {
    lockstep("1.2.3");
    expect(findVersionDrift(root)).toEqual([]);
  });

  it("names a stale pyproject version and a stale __version__", () => {
    lockstep("1.2.3", "0.17.0", "0.9.0");
    expect(findVersionDrift(root)).toEqual([
      "../kya-python/pyproject.toml: version 0.17.0 (package.json is 1.2.3)",
      "../kya-python/shield_kya/__init__.py: version 0.9.0 (package.json is 1.2.3)",
    ]);
  });

  it("fails when the version line is gone or the file is missing", () => {
    lockstep("1.2.3");
    write(join(py, "pyproject.toml"), "[project]\nname = \"shield-kya\"\n");
    rmSync(join(py, "shield_kya/__init__.py"));
    expect(findVersionDrift(root)).toEqual([
      "../kya-python/pyproject.toml: no version line",
      "../kya-python/shield_kya/__init__.py: missing",
    ]);
  });

  it("sync-version.mjs rewrites both lines, drops the stale comment and keeps the rest of the file", () => {
    lockstep("1.2.3", "0.17.0", "0.17.0");
    const out = execFileSync("node", [join(root, "scripts/sync-version.mjs")], { encoding: "utf8" });
    expect(out).toContain("../kya-python/pyproject.toml");
    expect(readFileSync(join(py, "pyproject.toml"), "utf8")).toBe(
      '[project]\nname = "shield-kya"\nversion = "1.2.3"\ndescription = "x"\n',
    );
    expect(readFileSync(join(py, "shield_kya/__init__.py"), "utf8")).toBe(init("1.2.3"));
    expect(findVersionDrift(root)).toEqual([]);
  });

  it("a checkout without ../kya-python (the public mirror) is clean, and sync leaves no sibling behind", () => {
    write(join(root, "package.json"), JSON.stringify({ name: "@shield-agent/kya", version: "1.2.3" }));
    write(join(root, "server.json"), JSON.stringify({ version: "1.2.3", packages: [{ version: "1.2.3" }] }));
    write(join(root, "manifest.json"), JSON.stringify({ version: "1.2.3" }));
    expect(findVersionDrift(root)).toEqual([]);
    execFileSync("node", [join(root, "scripts/sync-version.mjs")]);
    expect(() => readFileSync(join(py, "pyproject.toml"))).toThrow();
  });
});

describe("this repository", () => {
  it("has no stale version pins (pnpm sync:version fixes any)", () => {
    expect(findVersionDrift(PACKAGE_ROOT)).toEqual([]);
  });
});
