# Cline

Wire KYA into [Cline](https://cline.bot) (the VS Code extension) so tool calls it routes through MCP pass Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

There's no `kya connect cline` — Cline's config lives inside VS Code's globalStorage, which is not safe to rewrite programmatically while VS Code is running. Copy the example by hand instead.

## Setup

1. Open the example: [`cline/cline_mcp_settings.example.json`](../../cline/cline_mcp_settings.example.json).
2. Merge its `mcpServers.shield-kya` block into Cline's MCP settings file:

   | OS | Path |
   |----|------|
   | macOS | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
   | Linux | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
   | Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |

   Using VS Code Insiders, VSCodium, or a fork? The `Code` path segment changes (`Code - Insiders`, `VSCodium`, …) — the rest is the same.
3. Fully quit and reopen VS Code. Cline reads MCP settings at extension startup.

The example leaves `"autoApprove": []` empty on purpose. Auto-approving MCP calls would skip exactly the human checkpoint KYA exists to provide.

## What KYA reports

Each MCP tool call shows on the KYA receipt with its verdict and a clipped, redacted change preview: `kya receipt --open`. Holds surface as pending approvals (`kya dash`) until a person decides.

## Files written

You write one file by hand: the `cline_mcp_settings.json` for your VS Code variant above. KYA installs nothing else.

## Verify

1. In Cline's MCP panel, confirm `shield-kya` shows as connected with three tools: `kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval`.
2. Ask Cline to do something small that needs approval.
3. Offline smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row on the trail.

## Uninstall

Remove the `shield-kya` block from `cline_mcp_settings.json` and restart VS Code.

## Troubleshooting

- **Server shows red / fails to start.** The example uses `npx --no-install @shield-agent/kya@…` — it needs the package already installed (`npm i -g @shield-agent/kya`) or on PATH. `--no-install` is deliberate: no silent registry fetch at editor startup.
- **Connected but no trail rows.** Check which tools Cline actually routes through MCP; native file edits may not go through the MCP path — see the honesty note.
- **Edits after setup not picked up.** Cline caches MCP config per VS Code window. Reload the window (`Cmd/Ctrl+Shift+P → Reload Window`) or restart VS Code.
- **globalStorage path not found.** The extension creates the directory on first run. Install Cline, open it once, then look again.

## Honesty note

Cline's MCP coverage is the weakest of the wired hosts: the extension decides per-tool whether a call goes through MCP, and `autoApprove` can bypass the human checkpoint entirely. Keep `autoApprove` empty, and treat anything Cline does outside MCP as ungated.

## Wrap fallback

```bash
kya wrap --offline -- <any command>
```

If you script around the extension or drive it headlessly, wrap evaluates the command itself before it runs and leaves a trail row — no MCP required.
