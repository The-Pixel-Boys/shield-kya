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
