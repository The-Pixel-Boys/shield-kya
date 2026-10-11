/**
 * Channel bump scripts (scripts/packaging/bump-*.mjs): rewrite the pinned npm tarball url + sha256
 * of the Homebrew formula / Scoop manifest. Pure functions are tested directly, the CLI driver with
 * an injected fetch (no network). The committed channel files must be bump-stable (a bump to their
 * own version is a no-op) so the post-release diff is only ever the version and the hash.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { bumpFormula } from "../scripts/packaging/bump-homebrew.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { bumpManifest } from "../scripts/packaging/bump-scoop.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { runBump, tarballSha256, tarballUrl } from "../scripts/packaging/lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORMULA = join(ROOT, "packaging/homebrew/shield-kya.rb");
const MANIFEST = join(ROOT, "packaging/scoop/shield-kya.json");
const OLD_SHA = "a".repeat(64);
const NEW_SHA = "b".repeat(64);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-bump-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytes = Buffer.from("fake tarball bytes");
const bytesSha = createHash("sha256").update(bytes).digest("hex");
const okFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

describe("bumpFormula", () => {
  const src = readFileSync(FORMULA, "utf8");

  it("rewrites url and sha256 and nothing else", () => {
    const out = bumpFormula(src, "9.9.9", NEW_SHA);
    expect(out).toContain(`url "${tarballUrl("9.9.9")}"`);
    expect(out).toContain(`sha256 "${NEW_SHA}"`);
    const changed = out.split("\n").filter((l, i) => l !== src.split("\n")[i]);
    expect(changed).toHaveLength(2);
  });

  it("is idempotent", () => {
    const once = bumpFormula(src, "9.9.9", NEW_SHA);
    expect(bumpFormula(once, "9.9.9", NEW_SHA)).toBe(once);
  });

  it("is a no-op for the version the formula already pins", () => {
    const [, v, sha] = /kya-(\S+)\.tgz"\n\s*sha256 "([0-9a-f]{64})"/.exec(src) ?? [];
    expect(bumpFormula(src, v, sha)).toBe(src);
  });

  it("refuses a formula whose url or sha256 line changed shape", () => {
    expect(() => bumpFormula(src.replace(/^\s*sha256 .*$/m, ""), "1.0.0", NEW_SHA)).toThrow(/sha256/);
    expect(() => bumpFormula(src.replace("registry.npmjs.org", "example.com"), "1.0.0", NEW_SHA)).toThrow(/url/);
  });
});

describe("bumpManifest", () => {
  const src = readFileSync(MANIFEST, "utf8");

  it("sets version, url and prefixed hash, leaving autoupdate untouched", () => {
    const m = JSON.parse(bumpManifest(src, "9.9.9", NEW_SHA));
    expect(m.version).toBe("9.9.9");
    expect(m.url).toBe(tarballUrl("9.9.9"));
    expect(m.hash).toBe(`sha256:${NEW_SHA}`);
    expect(m.autoupdate).toEqual(JSON.parse(src).autoupdate);
  });

  it("keeps the committed manifest canonical, so a bump is idempotent and the diff minimal", () => {
    expect(`${JSON.stringify(JSON.parse(src), null, 4)}\n`).toBe(src);
    const once = bumpManifest(src, "9.9.9", NEW_SHA);
    expect(bumpManifest(once, "9.9.9", NEW_SHA)).toBe(once);
    expect(once.split("\n").filter((l, i) => l !== src.split("\n")[i])).toHaveLength(3);
  });

  it("refuses a manifest that no longer points at the npm tarball", () => {
    const bad = JSON.stringify({ ...JSON.parse(src), url: "https://example.com/kya-1.0.0.tgz" });
    expect(() => bumpManifest(bad, "1.0.0", NEW_SHA)).toThrow(/npm tarball/);
  });
});

describe("scoop manifest shape (Scoop App-Manifests schema, UNVERIFIED on Windows)", () => {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));

  it("shims a .cmd launcher, never a bare .js (Scoop would hand a .js to bash)", () => {
    expect(m.bin).toEqual(["kya.cmd", ["kya.cmd", "shield-kya"]]);
    expect(JSON.stringify(m.bin)).not.toMatch(/\.js/);
  });

  it("writes kya.cmd before shims are created, running node on the extracted dist/cli.js", () => {
    expect(m.extract_dir).toBe("package");
    const pre = m.pre_install.join("\n");
    expect(pre).toContain("kya.cmd");
    expect(pre).toContain('%~dp0dist\\cli.js');
  });

  it("installs runtime deps next to package.json, not in a package/ subdir that extract_dir already stripped", () => {
    const post = m.post_install.join("\n");
    expect(post).toContain('Push-Location "$dir"');
    expect(post).not.toMatch(/package\\/);
    expect(post).toContain("--omit=dev");
  });
});

describe("runBump", () => {
  const formula = (v: string, sha: string) => `class X\n  url "${tarballUrl(v)}"\n  sha256 "${sha}"\nend\n`;
  const run = (argv: string[], file: string) => {
    const lines: string[] = [];
    return runBump({ argv, defaultFile: file, bump: bumpFormula, fetchImpl: okFetch, out: (s: string) => lines.push(s) }).then((code: number) => ({ code, lines }));
  };

  it("downloads the tarball, hashes it, writes the file, then reports a no-op on the second run", async () => {
    const file = join(dir, "f.rb");
    writeFileSync(file, formula("0.1.0", OLD_SHA));

    const first = await run(["0.2.0"], file);
    expect(first.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(formula("0.2.0", bytesSha));

    const second = await run(["0.2.0"], file);
    expect(second.lines[0]).toContain("already at 0.2.0");
    expect(readFileSync(file, "utf8")).toBe(formula("0.2.0", bytesSha));
  });

  it("--check writes nothing and exits 1 when the file would change", async () => {
    const file = join(dir, "f.rb");
    writeFileSync(file, formula("0.1.0", OLD_SHA));
    expect((await run(["0.2.0", "--check", "--sha256", NEW_SHA], file)).code).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(formula("0.1.0", OLD_SHA));
    expect((await run(["0.1.0", "--check", "--sha256", OLD_SHA], file)).code).toBe(0);
  });

  it("--file and --sha256 override the default file and skip the download", async () => {
    const other = join(dir, "other.rb");
    writeFileSync(other, formula("0.1.0", OLD_SHA));
    const lines: string[] = [];
    const never = async () => {
      throw new Error("must not download");
    };
    await runBump({ argv: ["0.2.0", "--file", other, "--sha256", NEW_SHA], defaultFile: join(dir, "missing"), bump: bumpFormula, fetchImpl: never, out: (s: string) => lines.push(s) });
    expect(readFileSync(other, "utf8")).toBe(formula("0.2.0", NEW_SHA));
  });

  it("rejects a missing/odd version and a malformed sha256 before touching anything", async () => {
    const file = join(dir, "f.rb");
    writeFileSync(file, formula("0.1.0", OLD_SHA));
    await expect(run([], file)).rejects.toThrow(/usage/);
    await expect(run(["latest"], file)).rejects.toThrow(/usage/);
    await expect(run(["1.0.0", "extra"], file)).rejects.toThrow(/usage/);
    await expect(run(["1.0.0", "--sha256", "XYZ"], file)).rejects.toThrow(/64 lowercase hex/);
    expect(readFileSync(file, "utf8")).toBe(formula("0.1.0", OLD_SHA));
  });

  it("fails loudly when the version is not published (HTTP 404)", async () => {
    await expect(tarballSha256("9.9.9", async () => ({ ok: false, status: 404 }))).rejects.toThrow(/HTTP 404.*published/);
  });

  it("the CLI entry points run end to end offline via --sha256 on a copy of the real files", async () => {
    const { execFileSync } = await import("node:child_process");
    cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
    cpSync(join(ROOT, "packaging"), join(dir, "packaging"), { recursive: true });
    for (const script of ["bump-homebrew", "bump-scoop"]) {
      const out = execFileSync("node", [join(dir, `scripts/packaging/${script}.mjs`), "9.9.9", "--sha256", NEW_SHA], { encoding: "utf8" });
      expect(out).toContain("bumped to 9.9.9");
      expect(execFileSync("node", [join(dir, `scripts/packaging/${script}.mjs`), "9.9.9", "--sha256", NEW_SHA, "--check"], { encoding: "utf8" })).toContain("already at 9.9.9");
    }
  });
});
