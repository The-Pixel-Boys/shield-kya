#!/usr/bin/env node
// Fails when any file still names an old version of this package.
//
// package.json is the single source of truth. `pnpm sync:version` rewrites every pin it
// finds, and this check scans the same way (see lib/version-pins.mjs), so neither depends
// on a hand-kept file list. server.json / manifest.json version fields are compared too.
//
//   node scripts/check-version-pins.mjs        # exit 1 and list offenders on drift
//
// History is exempt (CHANGELOG*, lockfiles, node_modules, dist, coverage).
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PIN_RE, readText, walkTextFiles } from "./lib/version-pins.mjs";

/** Returns a list of human-readable problems; empty means no drift. */
export function findVersionDrift(root) {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const problems = [];

  for (const file of walkTextFiles(root)) {
    for (const m of readText(file).matchAll(PIN_RE)) {
      if (m[1] !== version) {
        problems.push(`${relative(root, file)}: pins @shield-agent/kya@${m[1]} (package.json is ${version})`);
      }
    }
  }

  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  if (server.version !== version) problems.push(`server.json: version ${server.version} (package.json is ${version})`);
  for (const [i, pkg] of (server.packages ?? []).entries()) {
    if (pkg.version !== version) problems.push(`server.json: packages[${i}].version ${pkg.version} (package.json is ${version})`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (manifest.version !== version) problems.push(`manifest.json: version ${manifest.version} (package.json is ${version})`);

  return problems;
}

// Compare real paths: argv[1] can be a symlinked spelling (macOS /var -> /private/var, pnpm
// links) while import.meta.url is always resolved. A plain string compare would skip the
// check and exit 0, which is the one thing a guard must never do.
if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = findVersionDrift(join(import.meta.dirname, ".."));
  if (problems.length > 0) {
    console.error(`version drift: ${problems.length} stale reference(s)\n  ${problems.join("\n  ")}`);
    console.error("\nFix: run `pnpm sync:version` (it rewrites every pin it finds).");
    process.exit(1);
  }
  console.log("version pins OK");
}
