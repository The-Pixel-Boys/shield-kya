# Qwen Code

Wire KYA into [Qwen Code](https://github.com/QwenLM/qwen-code) so every tool call the agent makes passes Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

## Setup

```bash
kya connect qwen
```

That writes a `shield-kya` entry into `~/.qwen/settings.json` under `mcpServers`. For a per-project setup instead:

```bash
kya connect qwen --project   # writes ./.qwen/settings.json
```

Restart Qwen Code after connecting — MCP servers load at startup.

Prefer editing by hand? Copy [`qwen/settings.example.json`](../../qwen/settings.example.json) (stdio) into place and merge the `mcpServers` section yourself.

**Hosted variant.** Instead of a local stdio server, Qwen can call the hosted MCP endpoint directly — merge [`qwen/settings.hosted.example.json`](../../qwen/settings.hosted.example.json) (`httpUrl: "https://shield-agent.com/mcp"` + `Authorization: Bearer ${KYA_API_KEY}`). Pick one: don't enable the stdio and hosted entries at the same time, or every call gets evaluated twice under two server names.

## What KYA reports

Every tool call Qwen routes through MCP lands on the receipt: tool id, verdict (Allow / Deny / Hold), timestamp, and a clipped, redacted preview of what would change. Open it with `kya receipt --open`.

## Files written

| Scope | Path |
|-------|------|
| Global | `~/.qwen/settings.json` |
| Project | `./.qwen/settings.json` |

Connect merges. Your other MCP servers and settings stay as they were. If the existing file doesn't parse as JSON, connect stops and tells you — it never overwrites a config it can't read.

## Verify

1. Restart Qwen Code.
2. Ask the agent to list its MCP tools — `kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval` should appear.
3. Offline smoke, no cloud needed:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row on the trail (`--irreversible` without a policy never auto-allows).

## Uninstall

Edit `~/.qwen/settings.json` and delete the `shield-kya` entry under `mcpServers`. Nothing else is installed — no daemon, no background process. (`kya connect qwen --force` rewires the entry if you only want to refresh it.)

## Troubleshooting

- **Server not listed in Qwen.** Restart Qwen Code. MCP servers load at startup, not hot.
- **`command not found` errors.** Connect wires `node …/cli.js serve-mcp --stdio` from the install you ran it from. If you connected via a temp `npx` cache and later cleared it, rerun `kya connect qwen --force` from a real install (`npm i -g @shield-agent/kya`).
- **Double verdicts on one action.** You enabled both the stdio and hosted entries. Remove one.
- **Verdicts require a key.** The wired env sets `KYA_OFFLINE=1`, so the server starts keyless and sample-evaluates. Against an authenticated control plane, set `KYA_API_KEY` in the entry's `env` block (stdio) or use the hosted variant's Bearer header.

## Honesty note

Qwen decides which tools go through MCP. KYA governs the ones that do. A tool Qwen executes outside MCP is outside the gate — don't treat this setup as full coverage of the agent.

## Wrap fallback

Works with or without MCP:

```bash
kya wrap --offline -- qwen "explain this diff"
```

Wrap evaluates the command itself before it runs and records a trail row. Use it for hosts, shells, or scripts that never speak MCP.
