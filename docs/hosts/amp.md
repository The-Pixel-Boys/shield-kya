# Amp

Wire KYA into [Amp](https://ampcode.com) so every tool call the agent makes passes Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

## Setup

```bash
kya connect amp
```

That writes a `shield-kya` entry into `~/.config/amp/settings.json` — under `amp.mcpServers`, not the usual bare `mcpServers`. Amp prefixes its MCP root key; connect knows that and won't create a second, ignored `mcpServers` block.

Amp has no project-scope config in the registry, so `kya connect amp --project` exits with a usage error. Global scope is the only option today.

Restart Amp after connecting — MCP servers load at startup.

Prefer editing by hand? Copy [`amp/settings.example.json`](../../amp/settings.example.json) into place and merge the `amp.mcpServers` section yourself.

## What KYA reports

Every tool call Amp routes through MCP lands on the receipt: tool id, verdict (Allow / Deny / Hold), timestamp, and a clipped, redacted preview of what would change. Open it with `kya receipt --open`.

## Files written

| Scope | Path |
|-------|------|
| Global | `~/.config/amp/settings.json` |

Connect merges. Your other Amp settings stay as they were. If the existing file doesn't parse as JSON, connect stops and tells you — it never overwrites a config it can't read.

## Verify

1. Restart Amp.
2. Ask the agent to list its MCP tools — `kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval` should appear.
3. Offline smoke, no cloud needed:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row on the trail (`--irreversible` without a policy never auto-allows).

## Uninstall

Edit `~/.config/amp/settings.json` and delete the `shield-kya` entry under `amp.mcpServers`. Nothing else is installed — no daemon, no background process. (`kya connect amp --force` rewires the entry if you only want to refresh it.)

## Troubleshooting

- **Server not listed in Amp.** Restart Amp. MCP servers load at startup, not hot. Also check the entry landed under `amp.mcpServers` — a hand-added `mcpServers` block is ignored by Amp.
- **`command not found` errors.** Connect wires `node …/cli.js serve-mcp --stdio` from the install you ran it from. If you connected via a temp `npx` cache and later cleared it, rerun `kya connect amp --force` from a real install (`npm i -g @shield-agent/kya`).
- **`--project` fails.** Expected — Amp has no project-scope config wired. Use the global file.
- **Verdicts require a key.** The wired env sets `KYA_OFFLINE=1`, so the server starts keyless and sample-evaluates. Against an authenticated control plane, set `KYA_API_KEY` in the entry's `env` block.

## Honesty note

Amp decides which tools go through MCP. KYA governs the ones that do. A tool Amp executes outside MCP is outside the gate — don't treat this setup as full coverage of the agent.

## Wrap fallback

Works with or without MCP:

```bash
kya wrap --offline -- amp "explain this stack trace"
```

Wrap evaluates the command itself before it runs and records a trail row. Use it for hosts, shells, or scripts that never speak MCP.
