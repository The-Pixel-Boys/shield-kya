#!/usr/bin/env node
// Rewrites the url + sha256 of packaging/homebrew/shield-kya.rb for a published version.
//
//   node scripts/packaging/bump-homebrew.mjs 0.23.1            # downloads the npm tarball, hashes it
//   node scripts/packaging/bump-homebrew.mjs 0.23.1 --check    # exit 1 if the formula is not at 0.23.1
//
// Idempotent: a second run with the same version changes nothing.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBump, tarballUrl } from "./lib.mjs";

const URL_RE = /^(\s*url\s+)"https:\/\/registry\.npmjs\.org\/@shield-agent\/kya\/-\/kya-[^"]+\.tgz"/m;
const SHA_RE = /^(\s*sha256\s+)"[0-9a-f]{64}"/m;

/** Pure: returns the formula text pinned to `version` / `sha256`. Throws if the formula shape changed. */
export function bumpFormula(text, version, sha256) {
  for (const [name, re] of [["url", URL_RE], ["sha256", SHA_RE]]) {
    if (!re.test(text)) throw new Error(`formula has no recognizable ${name} line (expected the npm tarball url + a 64-hex sha256)`);
  }
  return text.replace(URL_RE, `$1"${tarballUrl(version)}"`).replace(SHA_RE, `$1"${sha256}"`);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const defaultFile = join(import.meta.dirname, "../../packaging/homebrew/shield-kya.rb");
  runBump({ argv: process.argv.slice(2), defaultFile, bump: bumpFormula }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message);
      process.exit(2);
    },
  );
}
