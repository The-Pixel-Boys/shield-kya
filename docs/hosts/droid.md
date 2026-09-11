# Droid (Factory)

Wire KYA into [Factory's Droid](https://factory.ai) so tool calls routed through MCP pass Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

**Schema warning, up front:** Droid's on-disk MCP config format is not verified against a live install. The preferred path is Droid's own CLI. Treat [`droid/mcp.example.json`](../../droid/mcp.example.json) as a starting point, not gospel.

## Setup — preferred: `droid mcp add`

```bash
droid mcp add shield-kya "npx --no-install @shield-agent/kya@0.1.34 serve-mcp --stdio" \
  --env KYA_BASE_URL=https://shield-agent.com \
  --env KYA_API_KEY=$KYA_API_KEY \
  --env KYA_HOST=ide
```

This needs the package installed (`npm i -g @shield-agent/kya`); `--no-install` means no registry fetch at startup. Restart Droid afterwards.

## Setup — by hand (unverified)

The expected on-disk shape is `~/.factory/mcp.json` (global) or `.factory/mcp.json` (project) with a standard `mcpServers` block — see the example. If `droid mcp add` wrote something different on your machine, trust what it wrote and tell us via an issue; the example gets corrected from real installs.

## What KYA reports

Three tools: `kya.policy_evaluate` (Allow / Deny / Hold), `kya.session_ingest`, `kya.request_approval`. Calls land on the receipt with a clipped, redacted change preview: `kya receipt --open`.

## Files written

`droid mcp add` writes Droid's config itself (believed to be `~/.factory/mcp.json`). KYA installs nothing else.

## Verify

1. Open Droid's `/mcp` manager — `shield-kya` should be listed.
2. Ask Droid for a small change; check the trail.
3. Offline smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row.

## Uninstall

`droid mcp remove shield-kya` (or delete the block from the config file) and restart.

## Troubleshooting

- **`/mcp` doesn't list shield-kya.** Restart Droid. Then check the config file Droid actually reads — if `droid mcp add` wrote a different path than `~/.factory/mcp.json`, that's the schema drift the warning above is about.
- **Server fails to start.** Install the package globally so `npx --no-install` resolves without a fetch.
- **`KYA_API_KEY` empty inside Droid.** The `--env KYA_API_KEY=$KYA_API_KEY` flag copies the value at add time — re-run the add command if the key rotated.
- **Empty trail despite a listed server.** Only MCP-routed calls reach KYA; see the honesty note.

## Honesty note

Two honesty items, both deliberate. First: the on-disk schema is unverified — this page says so rather than pretending otherwise. Second: Droid decides which tools go through MCP; anything native is outside the gate.

## Wrap fallback

```bash
kya wrap --offline -- droid "triage the issue queue"
```

Wrap evaluates the command itself before it runs and records a trail row. Exit `0` Allow, `4` Hold, `1` Deny.
