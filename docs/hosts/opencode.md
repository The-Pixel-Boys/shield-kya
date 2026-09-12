# OpenCode

Wire KYA into [OpenCode](https://opencode.ai) so every tool call the agent makes passes Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

## Setup

```bash
kya connect opencode
```

That writes a `shield-kya` entry into `~/.config/opencode/opencode.json` under the `mcp` key. For a per-project setup instead:

```bash
kya connect opencode --project   # writes ./opencode.json
```

Restart OpenCode after connecting — MCP servers load at startup.

Prefer editing by hand? Copy [`opencode/opencode.example.json`](../../opencode/opencode.example.json) into place and merge the `mcp` section yourself.

## What KYA reports

Every tool call OpenCode routes through MCP lands on the receipt: tool id, verdict (Allow / Deny / Hold), timestamp, and a clipped, redacted preview of what would change. Open it with `kya receipt --open`, or watch live in the host's MCP panel.

## Files written

| Scope | Path |
|-------|------|
| Global | `~/.config/opencode/opencode.json` |
| Project | `./opencode.json` |

Connect merges. Your other MCP servers and settings stay as they were. If the existing file doesn't parse as JSON, connect stops and tells you — it never overwrites a config it can't read.

## Verify

1. Restart OpenCode.
2. Ask the agent to read a file. On the receipt you should see a trail row for the call.
3. Offline smoke, no cloud needed:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row on the trail (`--irreversible` without a policy never auto-allows).

## Uninstall

Edit `~/.config/opencode/opencode.json` and delete the `shield-kya` entry under `mcp`. Nothing else is installed — no daemon, no background process. (`kya connect opencode --force` rewires the entry if you only want to refresh it.)

## Troubleshooting

- **Server not listed in OpenCode.** Restart OpenCode. MCP servers load at startup, not hot.
- **`command not found` / npx errors.** Connect wires `node …/cli.js serve-mcp --stdio` from the install you ran it from. If you connected via a temp `npx` cache and later cleared it, rerun `kya connect opencode --force` from a real install (`npm i -g @shield-agent/kya`).
- **Tools silently bypass the gate.** KYA only sees calls that go through MCP. If OpenCode runs a tool natively without MCP, that call never reaches evaluate — see the honesty note below.
- **Verdicts require a key.** The wired env sets `KYA_OFFLINE=1`, so the server starts keyless and sample-evaluates. Against an authenticated control plane, set `KYA_API_KEY` in the entry's `environment` block.

## Honesty note

OpenCode decides which tools go through MCP. KYA governs the ones that do. A tool OpenCode executes outside MCP is outside the gate — don't treat this setup as full coverage of the agent.

## Wrap fallback

Works with or without MCP:

```bash
kya wrap --offline -- opencode run "refactor src/"
```

Wrap evaluates the command itself before it runs and records a trail row. Use it for hosts, shells, or scripts that never speak MCP.
