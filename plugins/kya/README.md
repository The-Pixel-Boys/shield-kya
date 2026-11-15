# kya (Claude Code plugin)

Stops your coding agent from deleting, leaking or dropping things. Records everything else.

Advisory and fail-open: records every tool call on the local trail and blocks only the small never-list. The hook evaluates locally; it does not call the hosted plane and has no Hold tickets or human sign-off.

```text
/plugin marketplace add The-Pixel-Boys/shield-kya
/plugin install kya@shield-kya
```

- `hooks/hooks.json`: SessionStart runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs`, which installs kya at the manifest version once into `${CLAUDE_PLUGIN_DATA}`; PreToolUse runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/kya.mjs hook --host claude`, which runs that copy. No npx at hook time.
- `.mcp.json`: the `shield-kya` MCP server through the same `scripts/kya.mjs`, with no hosted-plane base URL and no key (`kya.mjs` drops `KYA_API_KEY`; webhooks, OTLP and opt-in telemetry can still send; see the guide).
- Every command is `node` with one literal `${CLAUDE_PLUGIN_ROOT}/scripts/<file>` first, as the Claude plugin directory requires.

Full guide (team and admin rollout, uninstall, limits): [`docs/hosts/claude-plugin.md`](../../docs/hosts/claude-plugin.md).

Codex CLI loads this same folder through `.codex-plugin/plugin.json` (it wins over `.claude-plugin/` in Codex): hooks come from `hooks/codex-hooks.json` (shell-string commands with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`, `--host codex`) and no MCP server is bundled. Install with `codex plugin marketplace add The-Pixel-Boys/shield-kya` and `codex plugin add kya@shield-kya`, then trust the hooks in `/hooks`. Codex trusts the hook commands, not the scripts they run: the SessionStart command carries the kya version, so each release asks again, and an auto-upgraded marketplace runs whatever this repo's main branch holds at the next start (pin a release ref to control that). Guide: [`docs/hosts/codex.md`](../../docs/hosts/codex.md#codex-plugin).
