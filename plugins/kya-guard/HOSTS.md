# KYA Guard on other coding agents

The same `dist/guard.mjs` runs on every host. The hook passes `--host <name>`. The bundle reads that host's
payload, and answers in the shape that host reads. Exit code 2 blocks the call on all of them.
Only Claude Code has a prompt that KYA Guard relies on. On the other hosts a rule that asks becomes a deny.
The bundle is one file with no network call. Each variant folder holds a byte-identical copy (`pnpm run build:guard` writes and checks them).

| Host | Folder | Hook file | Payload read | Deny answer | Ask rule |
|---|---|---|---|---|---|
| Claude Code | `plugins/kya-guard` | `hooks/hooks.json` | `tool_name`, `tool_input` | `hookSpecificOutput` deny, exit 2 | asks (exit 0) |
| Codex | `plugins/kya-guard` | `hooks/codex-hooks.json` (from `.codex-plugin/plugin.json`) | same as Claude Code | same as Claude Code, exit 2 | deny |
| Cursor | `plugins/kya-guard-cursor` | `hooks/hooks.json`, event `preToolUse` | `tool_name`, `tool_input` | `{"permission":"deny",...}`, exit 2 | deny (Cursor does not apply an ask on `preToolUse`) |
| Copilot CLI | `plugins/kya-guard-copilot` | `com.github.copilot/hooks/hooks.json` | `toolName`, `toolArgs` (a JSON string) | top-level `permissionDecision` deny, exit 2 | deny |
| Gemini CLI | `plugins/kya-guard-gemini` | `hooks/hooks.json`, event `BeforeTool` | `tool_name`, `tool_input`, `mcp_context` | `{"decision":"deny",...}` | deny |

Notes by host:

- **Codex** runs plugin hooks only after you trust them in `/hooks`.
- **Cursor** runs `node ./dist/guard.mjs` from the plugin folder. An exit code other than 0 or 2 does not block.
- **Copilot CLI** denies a call when a hook exits with a code other than 0 or 2. The hook line turns any other exit code into 0, so a broken `node` does not block work. Copilot documents an ask answer, but it is a deny in autopilot mode and in the cloud agent, so the guard sends a deny.
- **Gemini CLI** reads the `decision` field from stdout. The hook line ends with `; exit 0` so a deny always travels as that field. Gemini installs an extension from a repository root, or from a local path with `gemini extensions install <path>`.
- The commands `/kya-guard:status` and `/kya-guard:share` exist on Claude Code only. On the other hosts run `node dist/guard.mjs --status` or `node dist/guard.mjs --card`.
- Trail rows carry the host as `product` (`codex`, `cursor`, `gemini`; Copilot is `other`, as for the full kya plugin).

Not verified on a live host: the hook files follow each host's documentation and the existing kya host code. The repository tests send each host's payload to the bundle and check its answer. They do not start the host.
