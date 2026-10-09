#!/usr/bin/env node
// Single source of truth: package.json version.
// Mirrors it into server.json (MCP Registry) and manifest.json (mcpb extension), then rewrites
// every `@shield-agent/kya@X.Y.Z` pin found anywhere in the package (README, host docs,
// connector examples). The scan is shared with check-version-pins.mjs, so there is no
// hand-kept file list to forget a file in.
// Run after every version bump: pnpm sync:version
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PIN_RE, readText, walkTextFiles } from "./lib/version-pins.mjs";

const root = join(import.meta.dirname, "..");
const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));
const write = (f, o) => writeFileSync(join(root, f), JSON.stringify(o, null, 2) + "\n");

const { version } = read("package.json");

const server = read("server.json");
server.version = version;
server.packages[0].version = version;
write("server.json", server);

const manifest = read("manifest.json");
manifest.version = version;
write("manifest.json", manifest);

// Text-level replace (no reformat) so docs and examples never drift from package.json.
const changed = [];
for (const file of walkTextFiles(root)) {
  const before = readText(file);
  const after = before.replace(PIN_RE, `@shield-agent/kya@${version}`);
  if (after !== before) {
    writeFileSync(file, after);
    changed.push(relative(root, file));
  }
}

console.log(`synced server.json + manifest.json to ${version}; rewrote pins in ${changed.length} file(s)`);
for (const f of changed) console.log(`  ${f}`);
