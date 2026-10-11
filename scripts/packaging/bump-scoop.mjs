#!/usr/bin/env node
// Rewrites version + url + hash of packaging/scoop/shield-kya.json for a published version.
//
//   node scripts/packaging/bump-scoop.mjs 0.23.1            # downloads the npm tarball, hashes it
//   node scripts/packaging/bump-scoop.mjs 0.23.1 --check    # exit 1 if the manifest is not at 0.23.1
//
// Idempotent. The manifest is kept in canonical form (4-space JSON, trailing newline, key order
// preserved), so a bump produces a minimal diff. `checkver` / `autoupdate` are left untouched.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBump, tarballUrl } from "./lib.mjs";

const NPM_URL_RE = /^https:\/\/registry\.npmjs\.org\/@shield-agent\/kya\/-\/kya-.+\.tgz$/;

/** Pure: returns the manifest text pinned to `version` / `sha256`. Throws if the manifest shape changed. */
export function bumpManifest(text, version, sha256) {
  const m = JSON.parse(text);
  if (typeof m.url !== "string" || !NPM_URL_RE.test(m.url)) throw new Error("manifest url is not the npm tarball url");
  if (typeof m.version !== "string" || typeof m.hash !== "string") throw new Error("manifest has no version/hash string");
  m.version = version;
  m.url = tarballUrl(version);
  m.hash = `sha256:${sha256}`;
  return `${JSON.stringify(m, null, 4)}\n`;
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const defaultFile = join(import.meta.dirname, "../../packaging/scoop/shield-kya.json");
  runBump({ argv: process.argv.slice(2), defaultFile, bump: bumpManifest }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message);
      process.exit(2);
    },
  );
}
