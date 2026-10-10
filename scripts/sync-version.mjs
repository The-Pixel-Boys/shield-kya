#!/usr/bin/env node
// Single source of truth: package.json version.
// Mirrors it into server.json (MCP Registry) and manifest.json (mcpb extension), then rewrites
// every `@shield-agent/kya@X.Y.Z` pin found anywhere in the package (README, host docs,
// connector examples) and the version field of every plugin / marketplace / extension
// manifest (MANIFESTS in lib/version-pins.mjs). The scan is shared with check-version-pins.mjs, so there is no
// hand-kept file list to forget a file in.
// Run after every version bump: pnpm sync:version
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncTree } from "./lib/version-pins.mjs";

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

// Text-level replace (no reformat) so docs, examples and plugin manifests never drift from package.json.
const changed = syncTree(root, version);

console.log(`synced server.json + manifest.json to ${version}; rewrote pins in ${changed.length} file(s)`);
for (const f of changed) console.log(`  ${f}`);
