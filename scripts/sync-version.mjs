#!/usr/bin/env node
// Single source of truth: package.json version.
// Mirrors it into server.json (MCP Registry) and manifest.json (mcpb extension).
// Run after every version bump: pnpm sync:version
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// Connector examples + README pin the npm package by exact version.
// Text-level replace (no reformat) so examples never drift from package.json.
const pinFiles = [
  ".mcp.json",
  "mcp.json",
  "claude/claude_desktop_config.example.json",
  "gemini/settings.example.json",
  "openai/codex.config.example.toml",
  "grok/README.md",
  "README.md",
];
const pinRe = /@shield-agent\/kya@\d+\.\d+\.\d+/g;
for (const f of pinFiles) {
  const path = join(root, f);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pinRe, `@shield-agent/kya@${version}`);
  if (after !== before) writeFileSync(path, after);
}

console.log(`synced server.json + manifest.json + ${pinFiles.length} pin files to ${version}`);
