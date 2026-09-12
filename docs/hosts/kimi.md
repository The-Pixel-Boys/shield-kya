# Kimi Code CLI

Wire KYA into [Kimi Code](https://www.kimi.com) so every tool call the agent makes passes Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

## Setup

```bash
kya connect kimi
```

That writes a `shield-kya` entry into `~/.kimi-code/mcp.json` under `mcpServers`. For a per-project setup instead:

```bash
kya connect kimi --project   # writes ./.kimi-code/mcp.json
```

Restart Kimi Code after connecting — MCP servers load at startup.

Prefer editing by hand? Copy [`kimi/mcp.example.json`](../../kimi/mcp.example.json) into place and merge the `mcpServers` section yourself.

## What KYA reports

Every tool call Kimi routes through MCP lands on the receipt: tool id, verdict (Allow / Deny / Hold), timestamp, and a clipped, redacted preview of what would change. Open it with `kya receipt --open`.

## Files written

| Scope | Path |
|-------|------|
| Global | `~/.kimi-code/mcp.json` |
| Project | `./.kimi-code/mcp.json` |

Connect merges. Your other MCP servers and settings stay as they were. If the existing file doesn't parse as JSON, connect stops and tells you — it never overwrites a config it can't read.

## Verify

1. Restart Kimi Code.
2. Ask the agent to list its MCP tools — `kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval` should appear.
3. Offline smoke, no cloud needed:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row on the trail (`--irreversible` without a policy never auto-allows).

## Uninstall

Edit `~/.kimi-code/mcp.json` and delete the `shield-kya` entry under `mcpServers`. Nothing else is installed — no daemon, no background process. (`kya connect kimi --force` rewires the entry if you only want to refresh it.)

## Troubleshooting

- **Server not listed in Kimi.** Restart Kimi Code. MCP servers load at startup, not hot.
- **`command not found` errors.** Connect wires `node …/cli.js serve-mcp --stdio` from the install you ran it from. If you connected via a temp `npx` cache and later cleared it, rerun `kya connect kimi --force` from a real install (`npm i -g @shield-agent/kya`).
- **Tools silently bypass the gate.** KYA only sees calls that go through MCP. A tool Kimi runs natively without MCP never reaches evaluate — see the honesty note below.
- **Verdicts require a key.** The wired env sets `KYA_OFFLINE=1`, so the server starts keyless and sample-evaluates. Against an authenticated control plane, set `KYA_API_KEY` in the entry's `env` block.

## Honesty note

Kimi decides which tools go through MCP. KYA governs the ones that do. A tool Kimi executes outside MCP is outside the gate — don't treat this setup as full coverage of the agent.

## Wrap fallback

Works with or without MCP:

```bash
kya wrap --offline -- kimi "summarize this repo"
```

Wrap evaluates the command itself before it runs and records a trail row. Use it for hosts, shells, or scripts that never speak MCP.
