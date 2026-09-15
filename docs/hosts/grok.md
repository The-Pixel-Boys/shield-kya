# Grok

Wire KYA into Grok so calls to Shield's MCP pass evaluate first. Allow runs, Deny stops, Hold waits for a person.

## Setup — Grok CLI (local)

```bash
kya connect grok
```

That appends a `[mcp_servers.shield-kya]` table to `~/.grok/config.toml` (command: `kya serve-mcp --stdio` from the install you ran connect in; env: `KYA_HOST=ide`, `KYA_OFFLINE=1`, `KYA_SESSION_ID=mcp:grok`; `enabled = true`). Re-running skips an existing table; `--force` replaces just that table. In a running Grok session, press `r` in `/mcps` to refresh.

## Setup — grok.com connectors

1. Open [grok.com/connectors](https://grok.com/connectors).
2. **New Connector** → **Custom**.
3. Server URL: `https://shield-agent.com/mcp`.
4. Auth: your machine API key as `Authorization: Bearer <KYA_API_KEY>` when the UI offers a request-header / API-key field. If the UI only offers OAuth or None, stop — don't turn auth off; use the xAI SDK path below instead.

## Setup — xAI SDK

The Shield key must travel with every MCP request. Full snippet in [`grok/README.md`](../../grok/README.md):

```python
import os
from xai_sdk import Client
from xai_sdk.tools import mcp

chat = Client(api_key=os.environ["XAI_API_KEY"]).chat.create(
    model="grok-4.6",
    tools=[mcp(
        server_url="https://shield-agent.com/mcp",
        authorization=f"Bearer {os.environ['KYA_API_KEY']}",
    )],
)
```

## Setup — local agent host (not Grok CLI, not grok.com)

For a custom local Grok-driven agent, use the same stdio launch as Claude/Codex/Gemini: `npx --no-install @shield-agent/kya@… serve-mcp --stdio` with `KYA_BASE_URL`, `KYA_API_KEY`, `KYA_HOST` in env.

## What KYA reports

Same three tools everywhere: `kya.policy_evaluate` (Allow / Deny / Hold), `kya.session_ingest`, `kya.request_approval`. Shield stays the only policy decision point — the tools never execute the write themselves. Calls land on the receipt: `kya receipt --open`.

## Files written

| Setup | Path |
|-------|------|
| Grok CLI | `~/.grok/config.toml` — one appended `[mcp_servers.shield-kya]` table |
| grok.com | none locally — the connector lives in your grok.com account |
| xAI SDK | none — the `mcp(...)` tool lives in your own code |

Connect appends and never rewrites unrelated TOML. An inline `shield-kya = …` definition under `[mcp_servers]` can't be merged as text — connect stops and tells you instead of guessing.

## Verify

1. Grok CLI: open a session, run `/mcps` — `shield-kya` should list with the three tools (press `r` to refresh if the session was already open). In grok.com, open a chat with the connector enabled and ask for the available tools.
2. Trigger a small evaluation and check the receipt for the row.
3. Local smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row.

## Uninstall

Grok CLI: delete the `[mcp_servers.shield-kya]` table from `~/.grok/config.toml` (or rewire later with `kya connect grok --force`). grok.com: delete the connector in connector settings; xAI SDK: remove the `mcp(...)` tool from your code. Nothing else is installed — no daemon, no background process.

## Troubleshooting

- **Connector rejected at save.** grok.com refuses localhost and private IPs. The URL must be exactly `https://shield-agent.com/mcp`.
- **401/403 on calls.** The Bearer header didn't travel. In the SDK, confirm the kwarg is `authorization=f"Bearer {key}"` (see [xAI remote MCP docs](https://docs.x.ai/docs/developers/tools/remote-mcp)); in the UI, confirm the header field saved.
- **Tempted to ngrok the OSS server.** Don't. A public tunnel to an unauthenticated local MCP is worse than no gate. Hosted endpoint + machine key is the supported path.

## Honesty note

The connector gates what Grok sends to Shield's MCP. Grok's built-in tools (search, code execution on xAI's side) never pass through KYA. Coverage is the MCP path only.

## Wrap fallback

For local scripts that call the xAI API:

```bash
kya wrap --offline -- python scripts/grok_job.py
```

Wrap evaluates the command before it runs and records a trail row. Exit `0` Allow, `4` Hold, `1` Deny.
