/**
 * Pin check for packaging/ channel files (Homebrew formula, Scoop manifest). They pin the published
 * npm tarball version + sha256, so they may LAG package.json (bumped after `npm publish`) but must
 * never lead it, disagree with each other, or carry a malformed hash. The committed files must pass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { findVersionDrift } from "../scripts/check-version-pins.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { packagingVersions } from "../scripts/lib/version-pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = "c".repeat(64);

let dir: string;
function put(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
const formula = (v: string, sha = SHA) =>
  `class ShieldKya < Formula\n  url "https://registry.npmjs.org/@shield-agent/kya/-/kya-${v}.tgz"\n  sha256 "${sha}"\nend\n`;
const scoop = (v: string, urlV = v, hash = `sha256:${SHA}`) =>
  JSON.stringify({ version: v, url: `https://registry.npmjs.org/@shield-agent/kya/-/kya-${urlV}.tgz`, hash }, null, 4);

function fixture(pkgVersion: string, brew: string, scoopV: string): void {
  put("package.json", JSON.stringify({ name: "@shield-agent/kya", version: pkgVersion }));
  put("server.json", JSON.stringify({ version: pkgVersion }));
  put("manifest.json", JSON.stringify({ version: pkgVersion }));
  put("packaging/homebrew/shield-kya.rb", formula(brew));
  put("packaging/scoop/shield-kya.json", scoop(scoopV));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-pkgpins-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("packaging pins", () => {
  it("accepts channels at the package version", () => {
    fixture("1.2.3", "1.2.3", "1.2.3");
    expect(findVersionDrift(dir)).toEqual([]);
  });

  it("accepts channels that lag package.json (bump happens after publish)", () => {
    fixture("1.3.0", "1.2.9", "1.2.9");
    expect(findVersionDrift(dir)).toEqual([]);
  });

  it("flags a channel that is ahead of package.json", () => {
    fixture("1.2.3", "1.2.4", "1.2.4");
    expect(findVersionDrift(dir)).toEqual([
      "packaging/homebrew/shield-kya.rb: url 1.2.4 is ahead of package.json 1.2.3",
      "packaging/scoop/shield-kya.json: version 1.2.4 is ahead of package.json 1.2.3",
      "packaging/scoop/shield-kya.json: url 1.2.4 is ahead of package.json 1.2.3",
    ]);
  });

  it("orders versions numerically, not as strings", () => {
    fixture("1.10.0", "1.9.0", "1.9.0");
    expect(findVersionDrift(dir)).toEqual([]);
    fixture("1.9.0", "1.10.0", "1.10.0");
    expect(findVersionDrift(dir)).toHaveLength(3);
  });

  it("treats a prerelease as below its release", () => {
    fixture("1.2.3", "1.2.3-rc.1", "1.2.3-rc.1");
    expect(findVersionDrift(dir)).toEqual([]);
    fixture("1.2.3-rc.1", "1.2.3", "1.2.3");
    expect(findVersionDrift(dir)).toHaveLength(3);
  });

  it("flags channels that disagree with each other (half-done bump)", () => {
    fixture("1.2.3", "1.2.3", "1.2.2");
    expect(findVersionDrift(dir)).toEqual([
      "packaging/scoop/shield-kya.json: version 1.2.2 disagrees with packaging/homebrew/shield-kya.rb: url 1.2.3",
      "packaging/scoop/shield-kya.json: url 1.2.2 disagrees with packaging/homebrew/shield-kya.rb: url 1.2.3",
    ]);
  });

  it("flags a scoop manifest whose version and url disagree", () => {
    fixture("1.2.3", "1.2.3", "1.2.3");
    put("packaging/scoop/shield-kya.json", scoop("1.2.3", "1.2.2"));
    expect(findVersionDrift(dir)).toEqual([
      "packaging/scoop/shield-kya.json: url 1.2.2 disagrees with packaging/homebrew/shield-kya.rb: url 1.2.3",
    ]);
  });

  it("flags a malformed or placeholder sha256", () => {
    fixture("1.2.3", "1.2.3", "1.2.3");
    put("packaging/homebrew/shield-kya.rb", formula("1.2.3", "PLACEHOLDER"));
    put("packaging/scoop/shield-kya.json", scoop("1.2.3", "1.2.3", "sha256:ABC"));
    expect(findVersionDrift(dir)).toEqual([
      "packaging/homebrew/shield-kya.rb: url: sha256 is not 64 lowercase hex chars",
      "packaging/scoop/shield-kya.json: version: sha256 is not 64 lowercase hex chars",
    ]);
  });

  it("flags a channel file with no recognizable version", () => {
    fixture("1.2.3", "1.2.3", "1.2.3");
    put("packaging/homebrew/shield-kya.rb", 'class X\n  url "https://example.com/x.tgz"\n  sha256 "' + SHA + '"\nend\n');
    expect(findVersionDrift(dir)[0]).toBe("packaging/homebrew/shield-kya.rb: url has no x.y.z version");
  });

  it("ignores same-named files outside packaging/", () => {
    fixture("1.2.3", "1.2.3", "1.2.3");
    put("docs/shield-kya.rb", formula("9.9.9"));
    expect(findVersionDrift(dir)).toEqual([]);
  });

  it("packagingVersions matches by path suffix and returns [] for other files", () => {
    expect(packagingVersions("README.md", "x")).toEqual([]);
    expect(packagingVersions("packaging/homebrew/shield-kya.rb", formula("1.2.3"))).toEqual([
      { file: "packaging/homebrew/shield-kya.rb", label: "url", version: "1.2.3", sha: SHA },
    ]);
  });
});

describe("the committed repo", () => {
  it("passes the pin check including packaging/", () => {
    expect(findVersionDrift(ROOT)).toEqual([]);
  });
});
