# kya (Claude Code plugin)

Audit trail and traceability for AI agents. See what every coding agent did.

Advisory and fail-open: records every tool call on the local trail and blocks only the small never-list. The hook evaluates locally; it does not call the hosted plane and has no Hold tickets or human sign-off.

```text
/plugin marketplace add The-Pixel-Boys/shield-kya
/plugin install kya@shield-kya
```

- `hooks/hooks.json`: SessionStart installs the pinned kya once into `${CLAUDE_PLUGIN_DATA}` (`scripts/bootstrap.mjs`); PreToolUse runs that copy, no npx at hook time.
- `.mcp.json`: the `shield-kya` MCP server from the same copy, with no hosted-plane base URL and no key (webhooks, OTLP and opt-in telemetry can still send; see the guide).

Full guide (team and admin rollout, uninstall, limits): [`docs/hosts/claude-plugin.md`](../../docs/hosts/claude-plugin.md).

Codex CLI loads this same folder through `.codex-plugin/plugin.json` (it wins over `.claude-plugin/` in Codex): hooks come from `hooks/codex-hooks.json` (shell-string commands with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`, `--host codex`) and no MCP server is bundled. Install with `codex plugin marketplace add The-Pixel-Boys/shield-kya` and `codex plugin add kya@shield-kya`, then trust the hooks in `/hooks`. Codex trusts the hook commands, not the scripts they run: the SessionStart command carries the kya version, so each release asks again, and an auto-upgraded marketplace runs whatever this repo's main branch holds at the next start (pin a release ref to control that). Guide: [`docs/hosts/codex.md`](../../docs/hosts/codex.md#codex-plugin).
