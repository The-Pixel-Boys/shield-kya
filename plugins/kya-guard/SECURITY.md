# KYA Guard: reviewer sheet

One page for a reviewer. Plugin `kya-guard`, version 1.0.0.

## What runs

- One hook: `PreToolUse`, matcher `*`, `node ${CLAUDE_PLUGIN_ROOT}/dist/guard.mjs --host claude`, timeout 5 s.
- `dist/guard.mjs` is built from `sdks/kya/src/guard-entry.ts` by `pnpm run build:guard` (esbuild 0.25.12). It is not minified. It is 300 KB or less.
- `commands/status.md` runs the same file with `--status`. It reads the trail and prints text.
- `commands/share.md` runs the same file with `--card`. Only you start it. It reads the trail, writes one SVG to `~/.kya/cards/` and prints a caption. The card builder takes four strings (rule id, label, host, date) and cannot see the command, a path, the project name or the session id.
- No `SessionStart` hook. No install step. No MCP server. No agent.

## Files read

- `~/.kya/config.json`: the keys `shellNeverList`, `secretsGuard`, `exfilGuard` and `guardAllow`. Only this user-level file counts.
- `<project>/.kya/policy.json`: optional. It can only add denies. It cannot lift a deny.
- `~/.kya/trail.jsonl`: only for `/kya-guard:status` and `/kya-guard:share`.
- The hook input on stdin. The guard does not read the content of a file named in a tool call. It reads the words in the command or path, and it resolves symlinks to see where a path points.

## Files written

- `~/.kya/trail.jsonl`: one JSON line per call, in the format the full `kya` CLI reads. The line holds the tool name, the verdict, the rule id, a hash of the arguments, a short redacted summary and a clipped redacted preview. It never holds a matched secret. A secret-shaped write gets no preview.
- `~/.kya/cards/*.svg`: only when you run `/kya-guard:share`. Never from the hook.
- Nothing else. The guard does not rotate the trail, create a lock file or a device id, or edit Claude Code settings. `kya` does that, if you also run it.

## No network, no child process

The bundle imports only `node:fs`, `node:os`, `node:path` and `node:crypto`. It has no update check, telemetry, IoC helper, share, login or OTLP code. The test `test/guard-bundle.test.ts` parses the bundle and fails the build if it imports `node:http`, `node:https`, `node:net`, `node:dns` or `node:child_process` (or `tls`, `http2`, `dgram`, `worker_threads`), calls `require` or `import()` with a non-literal name, or references `fetch`. A second test checks that the committed bundle equals a fresh build. CI runs both.

## Fail-open

Any internal error exits 0 and appends one line with `outcome: error`. One exception: if the rule engine breaks, the never-list and the guard rules with their default settings still run, so a broken config cannot turn the guard off. If `node` is missing or older than 22, the hook does not start and the call runs unguarded. See the README.

## Limits

This is a seatbelt, not a sandbox. It reads command text. A script the agent writes and then runs can do things the text does not show. Hosts other than Claude Code are not covered by this plugin.

## Uninstall

`/plugin uninstall kya-guard@shield-kya`. The plugin stores no data in `${CLAUDE_PLUGIN_DATA}`. `~/.kya/trail.jsonl` stays. It is your record. Delete it by hand if you want.

## Report a bypass

Email it@shield-agent.com. Send the tool call (the command or path) and the plugin version. Do not open a public issue before a fix ships. We reply within 72 hours.
