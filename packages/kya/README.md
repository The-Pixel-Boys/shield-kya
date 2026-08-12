# `@shield-agent/kya`

Light install CLI and local MCP gate for **Know Your Agent** (Shield KYA).

```bash
npx @shield-agent/kya@latest --help
```

- **Provider-agnostic** — no core lock to a single collab host, cloud, or LLM.
- **Zero vertical packs required** (R8) — disputes is optional.
- **Sole PEP** — Shield evaluates; this gate never auto-approves irreversible side effects.
- **Fail-closed** — empty `KYA_API_KEY` against an authenticated plane → non-zero exit.
- **Offline demo** — `--offline` sample evaluate (DENY → REQUIRE_APPROVE) without paid cloud.

## 15-minute path

```bash
# Offline demo (no account, no monorepo)
npx @shield-agent/kya eval-tool --offline --tool-id org.sample.never.event --irreversible
# → verdict: DENY
npx @shield-agent/kya eval-tool --offline --tool-id org.sample.data.write --irreversible
# → verdict: REQUIRE_APPROVE

# Scaffold + local plane
npx @shield-agent/kya init
npx @shield-agent/kya register-agent --name solo-builder --version-hash dev-local
npx @shield-agent/kya eval-tool --tool-id org.sample.never.event --irreversible
npx @shield-agent/kya serve-mcp --stdio
```

Install hub: [https://shield-agent.com/install](https://shield-agent.com/install)

## Dual plane

```
 host=ide (authoring)          host=runtime (production)
        │                              │
        └────────── same agent ────────┘
                    identity
                    policy evaluate  → ALLOW | DENY | REQUIRE_APPROVE
                    approval + trail
```

Tag sessions with `KYA_HOST=ide` or `KYA_HOST=runtime`. Same sole PEP either way.

## Environment

| Variable | Required | Meaning |
|----------|----------|---------|
| `KYA_BASE_URL` | Yes (network cmds) | Control plane origin |
| `KYA_API_KEY` | When auth is on | Bearer token |
| `KYA_HOST` | No (default `ide`) | `ide` \| `runtime` |
| `KYA_AGENT_ID` | After register | Agent principal id |
| `KYA_MCP_PORT` | No (default `3920`) | HTTP MCP listen port |
| `KYA_OFFLINE` | No | `1`/`true` for sample evaluate |

## MCP tools

| Tool | Role |
|------|------|
| `kya.policy_evaluate` | `ALLOW` \| `DENY` \| `REQUIRE_APPROVE` |
| `kya.session_ingest` | Observe / raise-only risk |
| `kya.request_approval` | Open human gate — **does not** execute side effect |

MCP Registry: `server.json` + package `mcpName` `io.github.the-pixel-boys/shield-kya`.

```json
{
  "mcpServers": {
    "shield-kya": {
      "command": "npx",
      "args": ["-y", "@shield-agent/kya", "serve-mcp", "--stdio"],
      "env": {
        "KYA_BASE_URL": "http://127.0.0.1:8090",
        "KYA_API_KEY": "${KYA_API_KEY}",
        "KYA_HOST": "ide"
      }
    }
  }
}
```

## ORR (reporting only)

```bash
npx @shield-agent/kya orr run --path . --out ./orr-report --skip-optional-producers
```

ORR is a **reporting orchestrator**. Scanners are evidence. They never ALLOW high-stakes side effects (no dual PEP).

## Enterprise (distinct tier)

Pin private registry builds, multi-tenant density, ORR board ops, and support — **never** required for the day-1 npx path above.

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

## Docs

- [Light install](../../docs/guides/kya-light-install.md)
- [MCP snippets](../../docs/guides/kya-mcp-snippet.md)
- [Local free console](../../docs/guides/kya-local-free.md)
- [Public baseline](../../public/kya-baseline/README.md)
