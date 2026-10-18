// GitHub Copilot CLI PreToolUse (com.github.copilot/hooks/hooks.json). Copilot denies the tool call
// when a preToolUse command hook exits non-zero (only a timeout fails open), while kya is advisory and
// fails open. So: run the kya copy that bootstrap.mjs installed into the plugin data dir and forward
// only a real never-list deny (kya exit 2 WITH a deny decision on stdout; kya also exits 2 on a usage
// error). Everything else exits 0: kya not installed yet, bootstrap failed, a crash, a signal, a hang.
// A missing `node` is handled one level up, in the hook's bash command. Node builtins only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let out = "";
try {
  // Copilot sets both names for plugin hooks; ${PLUGIN_DATA} itself is not set for hooks (1.0.98).
  const data = process.env.COPILOT_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const cli = data && join(data, "node_modules", "@shield-agent", "kya", "dist", "cli.js");
  if (cli && existsSync(cli)) {
    const r = spawnSync(process.execPath, [cli, "hook", "--host", "copilot"], {
      input: readFileSync(0),
      stdio: ["pipe", "pipe", "inherit"],
      encoding: "utf8",
      timeout: 4000, // well under the 5 s timeoutSec in hooks.json
    });
    const d = r.status === 2 ? JSON.parse(r.stdout).hookSpecificOutput : undefined;
    if (d?.permissionDecision === "deny") {
      // Copilot reads the top-level fields; hookSpecificOutput is kept for Claude-format readers.
      out = `${JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: d.permissionDecisionReason, hookSpecificOutput: d })}\n`;
    }
  }
} catch {
  // fail open
}
process.exitCode = out ? 2 : 0;
process.stdout.write(out);
