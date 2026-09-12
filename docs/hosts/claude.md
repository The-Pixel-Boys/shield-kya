# Claude (Code, Desktop, claude.ai)

Wire KYA into Claude Code or Claude Desktop so tool calls that go through MCP pass Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

## Setup — Claude Code

```bash
cd your-project
kya start
```

`kya start` inits `.kya/`, wires `shield-kya` into `.mcp.json` (and `mcp.json`, `.cursor/mcp.json` when present), and opens the live activity report — it runs in the background, so your terminal returns immediately (`kya stop` stops it). Restart Claude Code once so MCP loads. `kya start --no-open` wires without the report; `--force` rewrites existing blocks.

## Setup — Claude Desktop

Copy [`claude/claude_desktop_config.example.json`](../../claude/claude_desktop_config.example.json) into Claude Desktop's MCP settings and restart the app. To ship it as a Desktop extension instead, pack with `npx @anthropic-ai/mcpb pack` (see `manifest.json`) — that pack runs the bundled `dist/cli.js`, not `npx -y`.

## Setup — claude.ai / Cowork (hosted)

Add a custom connector at `https://shield-agent.com/mcp` with request header `Authorization: Bearer <KYA_API_KEY>` (or `X-API-Key`). Not Directory-listed yet — API-key auth, no OAuth DCR.

## What KYA reports

Three MCP tools: `kya.policy_evaluate` (Allow / Deny / Hold), `kya.session_ingest` (observe / raise-only risk), `kya.request_approval` (opens a human Hold — it does not execute the side effect). Every call lands on the receipt with a clipped, redacted change preview: `kya receipt --open`.

## Files written

| Setup | Path |
|-------|------|
| Claude Code (project) | `.mcp.json`, `.kya/` in your repo |
| Claude Desktop | the app's own MCP settings file (you paste it) |

`kya start` merges — existing servers and keys stay.

## Verify

1. Restart the host after wiring.
2. In Claude Code, run `/mcp` — `shield-kya` should list as connected with the three tools.
3. Offline smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row on the trail.

## Uninstall

Delete the `shield-kya` block from `.mcp.json` (or the Desktop settings file) and restart. Remove `.kya/` if you don't want the local trail.

## Troubleshooting

- **`/mcp` shows shield-kya failed.** The wired block runs `npx --no-install @shield-agent/kya@…` — install it first (`npm i -g @shield-agent/kya`) or run `kya start --force` from a machine where it's installed. `--no-install` is deliberate: no silent registry fetch at startup.
- **Tool calls error with `KYA_API_KEY is required`.** `kya start` wires `KYA_OFFLINE=1` for keyless sample evaluation. Pointing at an authenticated plane without a key fails closed — set `KYA_API_KEY` in the block's `env`.
- **Receipt shows nothing.** Only calls through MCP (or `kya wrap`) produce rows. Built-in tools Claude runs natively are outside the gate — see the honesty note.
- **Desktop: changes ignored.** Claude Desktop reads MCP config at launch. Quit fully (not just close the window) and reopen.

## Honesty note

Claude Code's built-in tools don't all route through MCP. KYA governs the MCP path completely; what the host executes natively never reaches evaluate. For shell-level coverage of any command, use the wrap fallback below.

## Wrap fallback

```bash
kya wrap --offline -- claude "refactor src/"
```

Wrap evaluates the command itself before it runs and records a trail row. Exit `0` Allow, `4` Hold, `1` Deny — so `kya wrap … && next-step` can't skip the gate.
