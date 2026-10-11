// Shared by bump-homebrew.mjs and bump-scoop.mjs. No dependencies: Node 24 built-ins only.
//
// A bump rewrites the pinned npm tarball url + sha256 of one channel file to a published version.
// The tarball sha256 only exists after `npm publish`, so a bump always runs AFTER the release.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export const tarballUrl = (version) => `https://registry.npmjs.org/@shield-agent/kya/-/kya-${version}.tgz`;

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** Download the published tarball and hash it. `fetchImpl` is injectable for tests. */
export async function tarballSha256(version, fetchImpl = fetch) {
  const res = await fetchImpl(tarballUrl(version));
  if (!res.ok) throw new Error(`GET ${tarballUrl(version)} failed: HTTP ${res.status} (is ${version} published?)`);
  return sha256Hex(Buffer.from(await res.arrayBuffer()));
}

/**
 * CLI driver. `bump(text, version, sha256)` returns the new file text (or throws).
 * Usage: <script> <version> [--file <path>] [--sha256 <hex>] [--check]
 *   --sha256  skip the download (offline / already hashed)
 *   --check   write nothing, exit 1 when the file would change
 */
export async function runBump({ argv, defaultFile, bump, fetchImpl = fetch, out = console.log }) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const file = take("--file") ?? defaultFile;
  const given = take("--sha256");
  const checkIdx = args.indexOf("--check");
  const check = checkIdx >= 0 && args.splice(checkIdx, 1).length === 1;
  const [version, ...extra] = args;
  if (!version || extra.length > 0 || !SEMVER_RE.test(version)) {
    throw new Error("usage: <script> <x.y.z> [--file <path>] [--sha256 <hex>] [--check]");
  }
  if (given !== undefined && !SHA256_RE.test(given)) throw new Error(`--sha256 must be 64 lowercase hex chars, got "${given}"`);

  const sha = given ?? (await tarballSha256(version, fetchImpl));
  const before = readFileSync(file, "utf8");
  const after = bump(before, version, sha);
  if (after === before) {
    out(`${file}: already at ${version} (${sha})`);
    return 0;
  }
  if (check) {
    out(`${file}: would change to ${version} (${sha})`);
    return 1;
  }
  writeFileSync(file, after);
  out(`${file}: bumped to ${version} (${sha})`);
  return 0;
}
