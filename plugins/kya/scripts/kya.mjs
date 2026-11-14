// Run the pinned kya that bootstrap.mjs installed into CLAUDE_PLUGIN_DATA, with the arguments
// given after this file: `node ${CLAUDE_PLUGIN_ROOT}/scripts/kya.mjs hook --host claude`.
// hooks.json and .mcp.json name only this file (a literal path under CLAUDE_PLUGIN_ROOT);
// the installed copy is found here, not in a command line. Node builtins only. No npm, no npx,
// no network. kya runs in this process, so stdin, stdout and its exit code are kya's own.
// Missing copy: one line on stderr and exit 1, which the host treats as a non-blocking error
// (fail open: the tool call proceeds; SessionStart already says "NOT recording").
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

// Only an absolute, expanded path. A relative or unexpanded "${CLAUDE_PLUGIN_DATA}" value would resolve
// against the user's project (cwd) and load code from it: refuse it and load nothing.
const raw = process.env.CLAUDE_PLUGIN_DATA ?? "";
const data = isAbsolute(raw) && !raw.includes("${") ? raw : "";
const cli = data ? join(data, "node_modules/@shield-agent/kya/dist/cli.js") : "";
if (!cli || !existsSync(cli)) {
  process.stderr.write("Shield KYA: kya is not installed yet (SessionStart installs it); nothing is recorded for this call.\n");
  process.exit(1);
}
// The plugin never uses a key from the user's machine: drop any ambient hosted-plane key before kya starts.
// First note that a key existed, as a presence flag only (never the key): opt-in telemetry reads it for hostedLinked.
if (["KYA_API_KEY", "SHIELD_API_KEY"].some((k) => (process.env[k] ?? "").trim() !== "")) process.env.KYA_HOSTED_LINKED = "1";
for (const k of ["KYA_API_KEY", "SHIELD_API_KEY"]) delete process.env[k];
process.argv[1] = cli; // kya starts only when it is the entry file
await import(pathToFileURL(cli).href);
