# Grok

Wire KYA into Grok so calls to Shield's MCP pass evaluate first. Allow runs, Deny stops, Hold waits for a person.

Grok is hosted-only for this integration: grok.com rejects `localhost` and private IPs, and there is no grok.com stdio path. Do not tunnel the OSS HTTP server to a public URL — use the hosted endpoint with a machine key.

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

## Setup — local agent host (not grok.com)

For a local Grok-driven agent, use the same stdio launch as Claude/Codex/Gemini: `npx --no-install @shield-agent/kya@… serve-mcp --stdio` with `KYA_BASE_URL`, `KYA_API_KEY`, `KYA_HOST` in env.

## What KYA reports

Same three tools everywhere: `kya.policy_evaluate` (Allow / Deny / Hold), `kya.session_ingest`, `kya.request_approval`. Shield stays the only policy decision point — the tools never execute the write themselves. Calls land on the receipt: `kya receipt --open`.

## Files written

None locally. The connector lives in your grok.com account; the SDK path lives in your own code.

## Verify

1. In grok.com, open a chat with the connector enabled and ask for the available tools — the three `kya.*` tools should be listed.
2. Trigger a small evaluation and check the receipt for the row.
3. Local smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row.

## Uninstall

Delete the connector in grok.com's connector settings, or remove the `mcp(...)` tool from your SDK code. Nothing was installed locally.

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
