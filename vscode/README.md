# Shield KYA for VS Code, Cursor and Open VSX editors

Audit trail and traceability for AI agents, inside your editor. This extension shows what kya recorded for every coding-agent tool call (Claude Code, Cursor, Codex, Gemini CLI and the other hosts kya wires). It does not gate anything itself.

**Advisory.** Local kya records every tool call, blocks only the never-list (for example a `drop_table` on a known Postgres MCP server) and fails open: if kya is missing or broken, the agent's call still runs. Enforcement (fail-closed hooks, Hold tickets, human approvals) is the hosted Shield product. This extension never claims or adds enforcement.

## What it does

- **Verdict feed** (activity bar, Shield KYA > Verdicts): live tail of the local trail `~/.kya/trail.jsonl` (or `$KYA_HOME/.kya/trail.jsonl`). Rows show ALLOW, REVIEW (kya's `REQUIRE_APPROVE` with no Hold path armed), HOLD (`REQUIRE_APPROVE` recorded by a hosted strict hook or `kya wrap --hold`) and DENY. Never-list denies are marked. Previews are the redacted, clipped text kya stores, redacted again before display. Malformed lines are skipped. Only the last 1 MB of the file is read.
- **Status bar**: gate mode and the counts over the last 200 rows (the rows the Verdicts view shows). A never-list deny seen since the extension last loaded the trail (activation, Refresh, or a truncated or rotated file) keeps the status bar red. An unreadable trail shows "trail unreadable" there and pauses only the feed. The mode comes from the kya hook commands wired in your user config (`~/.claude/settings.json`, `~/.grok/hooks/shield-kya.json`, `~/.kimi-code/config.toml`) and from the Claude Code plugin enabled there (`kya@shield-kya` is advisory):
  - `advisory`: the hooks have no `--strict`.
  - `strict`: the hooks use `--strict`, `--fail-closed` or a hosted `--plane-config`.
  - `mixed`: both kinds are wired.
  - `unknown`: nothing visible is wired but the trail has rows from the last 24 h.
  - `no hook`: nothing is wired and there are no recent rows.

  The Codex and Gemini plugins and project-level wiring are not inspected, which is why `unknown` exists.
- **Hosted approvals** (optional, off by default): lists the pending approvals of your hosted org and lets you approve or reject one of them after a confirmation. Only an approval in the list the hosted plane returned can be decided, and the confirmation shows the plane's own action text. So far these have been tested only against a local stub of the hosted API, not the live plane. Approve/reject needs a user token with the `kya.approve` scope. A machine key (`sk_...`) can only list; the extension opens the approval in the hosted console instead.
- **Connect this workspace**: runs `kya connect <host> --project` in the open folder after you pick the host and confirm. kya merges a `shield-kya` MCP server entry into that host's project config (for example `.cursor/mcp.json` or `.mcp.json`). Nothing is written without the confirmation.
- **MCP server**: offers the installed kya (`kya serve-mcp --stdio`, offline evaluate) to the editor's agent:
  - VS Code: through the MCP server definition provider API (VS Code 1.101+).
  - Cursor: through Cursor's `vscode.cursor.mcp.registerServer`.

  Turn it off with `shieldKya.mcp.enabled`.

## Requirements

- An installed kya: `npm i -g @shield-agent/kya` (Node.js 24+), then `kya start` to wire your agent.
- VS Code 1.101 or later, or a fork built on it (Cursor and other forks that install from Open VSX).

## Security and privacy

- **Runs only the installed kya.** It uses `shieldKya.cliPath` if you set one, otherwise the first `kya` on PATH. PATH entries that are relative or inside the open workspace are skipped, and both `kya` and `node` are rejected if they resolve into the workspace. It never runs `npx` and never runs a file from the workspace. kya and node are started directly, with no shell.
- **No network unless you turn on hosted approvals.** No telemetry is added: kya's own usage telemetry stays opt-in and off by default (`kya telemetry status`).
- **Keys stay out of settings.** The hosted key is stored with "Shield KYA: Set hosted API key" in VS Code SecretStorage (the OS keychain). It is never written to settings.json.
- **Workspace settings cannot redirect it.** The trail path, kya path, hosted switch and hosted URL are user-level settings. Values in a workspace's `.vscode/settings.json` are ignored. The hosted URL must be https (http only for 127.0.0.1/localhost), and redirects are refused.
- **Remote and dev containers.** The extension runs where the workspace runs. In a dev container the repo's container definition decides `KYA_HOME`, PATH and the installed kya. It can therefore choose which trail and hook files the extension reads, but it cannot make the extension run anything from the workspace.
- **Restricted Mode.** In Restricted Mode (untrusted workspace) and in virtual workspaces the feed is read-only: no kya process, no MCP registration, no connect and no hosted calls.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `shieldKya.trailPath` | empty (`~/.kya/trail.jsonl`) | Trail file to show |
| `shieldKya.cliPath` | empty (PATH) | Absolute path to the kya bin or its `dist/cli.js` |
| `shieldKya.hosted.enabled` | `false` | Hosted approvals (the only network use) |
| `shieldKya.hosted.baseUrl` | `https://shield-agent.com` | Hosted plane origin |
| `shieldKya.mcp.enabled` | `true` | Offer kya as an MCP server to the editor |

## Build from source

```bash
cd vscode
pnpm install --frozen-lockfile
pnpm test        # unit tests (node:test)
pnpm package     # dist/shield-kya.vsix
pnpm e2e         # real-editor e2e: needs a desktop VS Code (VSCODE_APP) and kya on PATH
code --install-extension dist/shield-kya.vsix
```

Docs: [docs/hosts/vscode.md](https://github.com/The-Pixel-Boys/shield-kya/blob/main/docs/hosts/vscode.md). License: MIT.
