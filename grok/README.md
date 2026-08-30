# Grok + Shield KYA

Same three MCP tools as Claude and Codex: `kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval`. Shield stays the only policy decision point. Tools never execute the write.

## Hosted (grok.com)

1. Open [grok.com/connectors](https://grok.com/connectors).
2. **New Connector** → **Custom**.
3. Server URL: `https://shield-agent.com/mcp`.
4. Auth: machine API key as `Authorization: Bearer <KYA_API_KEY>` when the UI offers a request header / API key field. If the UI only offers OAuth or None, stop and use the xAI SDK or Codex/Gemini CLI instead. Do not turn auth off.

Grok rejects `localhost` and private IPs. Do not expose OSS HTTP MCP through a public URL. Use `https://shield-agent.com/mcp` with a Bearer machine key.

## Hosted (xAI SDK)

The Shield machine key must travel with the MCP request. Do not register `https://shield-agent.com/mcp` without it.

```python
import os
from xai_sdk import Client
from xai_sdk.tools import mcp

kya_key = os.environ["KYA_API_KEY"]
client = Client(api_key=os.environ["XAI_API_KEY"])
chat = client.chat.create(
    model="grok-4.6",
    tools=[
        mcp(
            server_url="https://shield-agent.com/mcp",
            authorization=f"Bearer {kya_key}",
        ),
    ],
)
```

`authorization` is sent as the MCP `Authorization` header. Confirm kwargs in [xAI remote MCP docs](https://docs.x.ai/docs/developers/tools/remote-mcp). The URL is always `https://shield-agent.com/mcp`.

## Local / OSS

There is no grok.com stdio path. For a local agent host use the same stdio launch as Claude:

```bash
npx --no-install @shield-agent/kya@0.1.18 serve-mcp --stdio
```

Env: `KYA_BASE_URL`, `KYA_API_KEY`, `KYA_HOST`. Codex and Gemini example configs in this package show the full snippets.
