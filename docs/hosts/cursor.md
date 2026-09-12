# Cursor (IDE + Agent CLI)

Wire KYA into Cursor so every tool call the agent makes passes Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person. The Cursor IDE and the Cursor Agent CLI share the same MCP config, so one wiring covers both.

## Setup

Two commands do the same job — pick one:

```bash
kya connect cursor   # writes ~/.cursor/mcp.json directly
kya start            # wires .cursor/mcp.json as part of project init
```

For a per-project setup instead of global:

```bash
kya connect cursor --project   # writes ./.cursor/mcp.json
```

Restart Cursor after connecting — MCP servers load at startup.

Two other paths, if you prefer them: merge the repo-root [`.mcp.json`](../../.mcp.json) by hand, or install the shipped [`.cursor-plugin/`](../../.cursor-plugin/) (`plugin.json` + a wrap skill) for a plugin-managed setup.

## What KYA reports

Every tool call Cursor routes through MCP lands on the receipt: tool id, verdict (Allow / Deny / Hold), timestamp, and a clipped, redacted preview of what would change. Open it with `kya receipt --open`, or check Cursor's MCP panel in Settings.

## Files written

| Scope | Path |
|-------|------|
| Global | `~/.cursor/mcp.json` |
| Project | `./.cursor/mcp.json` |

Connect merges. Your other MCP servers and settings stay as they were. If the existing file doesn't parse as JSON, connect stops and tells you — it never overwrites a config it can't read.

## Verify

1. Restart Cursor.
2. Open Settings → MCP and confirm `shield-kya` is connected with three tools: `kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval`.
3. Offline smoke, no cloud needed:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row on the trail (`--irreversible` without a policy never auto-allows).

## Uninstall

Edit `~/.cursor/mcp.json` and delete the `shield-kya` entry under `mcpServers`. Nothing else is installed — no daemon, no background process. (`kya connect cursor --force` rewires the entry if you only want to refresh it.)

## Troubleshooting

- **Server shows red in Settings → MCP.** Restart Cursor. MCP servers load at startup, not hot.
- **`command not found` errors.** Connect wires `node …/cli.js serve-mcp --stdio` from the install you ran it from. If you connected via a temp `npx` cache and later cleared it, rerun `kya connect cursor --force` from a real install (`npm i -g @shield-agent/kya`).
- **Wired but the agent ignores it.** Check Cursor's tool-approval settings — if the agent is set to run tools without MCP, those calls never reach evaluate. See the honesty note.
- **Verdicts require a key.** The wired env sets `KYA_OFFLINE=1`, so the server starts keyless and sample-evaluates. Against an authenticated control plane, set `KYA_API_KEY` in the entry's `env` block.

## Honesty note

Cursor decides which tools go through MCP, and its own approval modes can run tools outside it. KYA governs MCP calls only. A Cursor action executed natively is outside the gate — don't treat this setup as full coverage of the agent.

## Wrap fallback

Works with or without MCP, and it's the right choice for the Cursor Agent CLI in scripts and CI:

```bash
kya wrap --offline -- cursor-agent run "fix the failing test"
```

Wrap evaluates the command itself before it runs and records a trail row.
