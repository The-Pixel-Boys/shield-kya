# `@shield-agent/kya`

Light install CLI and local MCP gate for **Know Your Agent** (Shield KYA).

An agent that can change a real system must ask Shield first. Register the agent, wrap the tool, get Allow / Hold / Deny. Hold waits for a person. This package does not scan a network. Agents that never call evaluate stay invisible.

Walkthrough: [how you use it](https://shield-agent.com/how-kya-works#using).

```bash
npx @shield-agent/kya@latest --help
```

- Works on any collab host, cloud, or LLM that speaks MCP or OpenAPI.
- Vertical packs are optional.
- Sole PEP: Shield evaluates. This gate never auto-approves irreversible side effects.
- Fail closed: empty `KYA_API_KEY` against an authenticated plane exits non-zero. `eval-tool` / `wrap` / `invoke` exit `0` on ALLOW, `4` on REQUIRE_APPROVE, `1` on DENY or unknown — so `eval-tool && write` cannot skip the gate.
- Offline demo: `--offline` sample evaluate (`DENY` then `REQUIRE_APPROVE`) without a paid cloud.
- Creating an agent is a tool. `kya.agent.register` evaluates `REQUIRE_APPROVE` offline. Human mint modes (allow / break-glass / approve) live on the control plane.

## 15-minute path

```bash
# Offline demo (no account, no monorepo)
npx @shield-agent/kya eval-tool --offline --tool-id org.sample.never.event --irreversible
# → verdict: DENY
npx @shield-agent/kya eval-tool --offline --tool-id org.sample.data.write --irreversible
# → verdict: REQUIRE_APPROVE

# Scaffold + local plane
npx @shield-agent/kya init
npx @shield-agent/kya eval-tool --offline --tool-id kya.agent.register --irreversible
# → verdict: REQUIRE_APPROVE
npx @shield-agent/kya register-agent --name solo-builder --version-hash dev-local
npx @shield-agent/kya eval-tool --tool-id org.sample.never.event --irreversible
npx @shield-agent/kya serve-mcp --stdio

# Terminal dashboard (free individual panes; --offline works without a key)
npx @shield-agent/kya dash --once --offline
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
| `KYA_DASH_PLAN` | No | `enterprise` unlocks licensed TUI panes |

## MCP tools

| Tool | Role |
|------|------|
| `kya.policy_evaluate` | `ALLOW` \| `DENY` \| `REQUIRE_APPROVE` |
| `kya.session_ingest` | Observe / raise-only risk |
| `kya.request_approval` | Open a human gate. Does not execute the side effect |

MCP Registry: `server.json` + package `mcpName` `io.github.The-Pixel-Boys/shield-kya`.

```json
{
  "mcpServers": {
    "shield-kya": {
      "command": "npx",
      "args": ["--no-install", "@shield-agent/kya@0.1.15", "serve-mcp", "--stdio"],
      "env": {
        "KYA_BASE_URL": "http://127.0.0.1:8090",
        "KYA_API_KEY": "${KYA_API_KEY}",
        "KYA_HOST": "ide"
      }
    }
  }
}
```

## Wrap and decide

```bash
npx @shield-agent/kya wrap --offline --tool-id org.sample.data.write --irreversible
npx @shield-agent/kya approve --id <approval-id>
npx @shield-agent/kya reject --id <approval-id>
```

`wrap` evaluates and may open a pending ticket. It never executes the side effect.
`invoke` asks the live plane to authorize after Allow or APPROVED. It does not run the write on this machine.
The TUI (`dash`) is observational. Keys `a`/`x` print this CLI. They do not decide.

## Claude connector

**Desktop / Claude Code (local stdio):**

```bash
# Prefer a preinstalled package (no registry auto-install):
npx --no-install @shield-agent/kya@0.1.15 serve-mcp --stdio
# Or after npm i -g / local install:
kya serve-mcp --stdio
```

Copy `claude/claude_desktop_config.example.json` into Claude Desktop MCP settings, or use `.mcp.json` for Claude Code.
Pack a Desktop extension with `npx @anthropic-ai/mcpb pack` (see `manifest.json` — launches packed `dist/cli.js`, not `npx -y`).

**Claude.ai / Cowork (hosted):** add custom connector URL `https://shield-agent.com/mcp` with request header `Authorization: Bearer <KYA_API_KEY>` (or `X-API-Key`). Not Directory-listed yet (API-key auth, no OAuth DCR).

## Cursor plugin

`.cursor-plugin/plugin.json` + `mcp.json` + wrap skill. Public listing repo: https://github.com/The-Pixel-Boys/shield-kya

## ORR (reporting only)

```bash
npx @shield-agent/kya orr run --path . --out ./orr-report --skip-optional-producers
npx @shield-agent/kya orr run --path . --out ./orr-report --scorecard ./scorecard.json --producer openssf.scorecard
npx @shield-agent/kya orr run --path . --out ./orr-report --producer harness.agentshield --agentshield-json ./agentshield-report.json
```

ORR is a **reporting orchestrator**. Scanners, `--scorecard`, and `harness.agentshield` are evidence. They never ALLOW high-stakes side effects (no dual PEP). AgentShield is optional and read-only: no `--fix`, no MiniClaw, no runtime hook. `@shield-agent/kya` does not depend on `ecc-agentshield`. If `--producer harness.agentshield` is set and neither `--agentshield-json` nor an `agentshield` binary is present, ORR records a coverage gap and still exits 0. Explicit `--producer harness.agentshield` always attempts; `--skip-optional-producers` only omits implicit optionals.

## Enterprise (distinct tier)

Pin, private registry, multi-tenant density, ORR board ops, and support are never required for the day-1 npx path above.

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


## Cost showback (observe only)

`kya orr run --usage ./usage.json` (or `.kya/usage.json`) adds a **showback** section: tokens and estimated USD by agent/run. Subagents nest under `parentRunId`. This is **not** a billing meter and **not** a PEP. Hosted metrics show the same rollup when usage is ingested on session ingest.
