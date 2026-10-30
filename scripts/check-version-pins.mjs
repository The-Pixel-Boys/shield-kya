#!/usr/bin/env node
// Fails when any file still names an old version of this package.
//
// package.json is the single source of truth. `pnpm sync:version` rewrites every pin it
// finds, and this check scans the same way (see lib/version-pins.mjs), so neither depends
// on a hand-kept file list. server.json / manifest.json version fields are compared too, as are the `version` fields
// of plugin / marketplace / extension manifests (MANIFESTS in lib/version-pins.mjs).
//
//   node scripts/check-version-pins.mjs        # exit 1 and list offenders on drift
//
// History is exempt (CHANGELOG*, lockfiles, node_modules, dist, coverage).
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PIN_RE, manifestVersions, packagingVersions, pythonVersionProblems, readText, relPosix, walkPinFiles } from "./lib/version-pins.mjs";

const SHA256_RE = /^[0-9a-f]{64}$/;

// ponytail: compares x.y.z numerically, a prerelease sorts below its release, prereleases among
// themselves compare as plain strings. Enough for "is this channel ahead of package.json".
function cmpSemver(a, b) {
  const [ca, pa] = a.split(/-(.*)/s);
  const [cb, pb] = b.split(/-(.*)/s);
  const d = ca.split(".").map((n, i) => n - cb.split(".")[i]).find((n) => n !== 0);
  if (d) return Math.sign(d);
  if (pa === pb) return 0;
  return pa === undefined ? 1 : pb === undefined ? -1 : pa < pb ? -1 : 1;
}

/** Returns a list of human-readable problems; empty means no drift. */
export function findVersionDrift(root) {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const problems = [];
  const channels = []; // every version pinned by a packaging channel file

  for (const file of walkPinFiles(root)) {
    const text = readText(file);
    for (const m of text.matchAll(PIN_RE)) {
      if (m[1] !== version) {
        problems.push(`${relative(root, file)}: pins @shield-agent/kya@${m[1]} (package.json is ${version})`);
      }
    }
    for (const c of packagingVersions(relPosix(root, file), text)) channels.push({ ...c, rel: relative(root, file) });
    for (const { label, leaf } of manifestVersions(relPosix(root, file), text)) {
      if (leaf.value !== version) {
        problems.push(`${relative(root, file)}: ${label} ${leaf.value} (package.json is ${version})`);
      }
    }
  }

  // Channel files may trail package.json (bumped after publish) but never lead it or each other.
  for (const c of channels) {
    const where = `${c.rel}: ${c.label}`;
    if (!c.version) problems.push(`${where} has no x.y.z version`);
    else if (cmpSemver(c.version, version) > 0) problems.push(`${where} ${c.version} is ahead of package.json ${version}`);
    else if (c.version !== channels[0].version) problems.push(`${where} ${c.version} disagrees with ${channels[0].rel}: ${channels[0].label} ${channels[0].version}`);
    if (c.sha !== undefined && !SHA256_RE.test(c.sha)) problems.push(`${where}: sha256 is not 64 lowercase hex chars`);
  }

  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  if (server.version !== version) problems.push(`server.json: version ${server.version} (package.json is ${version})`);
  for (const [i, pkg] of (server.packages ?? []).entries()) {
    if (pkg.version !== version) problems.push(`server.json: packages[${i}].version ${pkg.version} (package.json is ${version})`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (manifest.version !== version) problems.push(`manifest.json: version ${manifest.version} (package.json is ${version})`);

  problems.push(...pythonVersionProblems(root, version));

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
