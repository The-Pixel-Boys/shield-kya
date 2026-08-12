# Shield KYA — public baseline

**Know Your Agent** control plane for agent tools: identity, policy, dual-plane host labels, human approval, trail.

> **One command**

```bash
# When npm is live:
npx @shield-agent/kya@latest --help

# Until then (GitHub):
npx --yes github:The-Pixel-Boys/shield-kya --help
```

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Install](https://img.shields.io/badge/install-shield--agent.com%2Finstall-0A0A0A)](https://shield-agent.com/install)
[![GitHub](https://img.shields.io/badge/github-The--Pixel--Boys%2Fshield--kya-181717)](https://github.com/The-Pixel-Boys/shield-kya)

**Free try (offline, no account):**

```bash
npx --yes github:The-Pixel-Boys/shield-kya eval-tool --offline --tool-id org.sample.never.event --irreversible
# → DENY
npx --yes github:The-Pixel-Boys/shield-kya eval-tool --offline --tool-id org.sample.data.write --irreversible
# → REQUIRE_APPROVE
```

## Dual plane (`host=ide` | `host=runtime`)

```text
┌─────────────────────┐         ┌──────────────────────┐
│  host=ide           │         │  host=runtime        │
│  authoring / dry-run│         │  production work     │
└──────────┬──────────┘         └──────────┬───────────┘
           │                               │
           └────────────┬──────────────────┘
                        ▼
              ┌───────────────────┐
              │  Shield KYA PEP   │
              │  sole enforcement │
              │  ALLOW | DENY |   │
              │  REQUIRE_APPROVE  │
              └─────────┬─────────┘
                        │
              human plane (approve)
                        │
              trail / observe metrics
```

## Sample custom tools only

| toolId | Expected verdict |
|--------|------------------|
| `org.sample.safe.read` | `ALLOW` |
| `org.sample.data.write` | `REQUIRE_APPROVE` |
| `org.sample.never.event` | `DENY` |

## Commands

| Command | Purpose |
|---------|---------|
| `init` | Scaffold `.kya/` + sample tools |
| `register-agent` | Register principal on a control plane |
| `eval-tool` | Policy evaluate (`--offline` for local sample) |
| `serve-mcp` | Local MCP gate (HTTP or `--stdio`) |
| `orr run --path` | Read-only ORR report (evidence only — **not** a second PEP) |

See [LIMITATIONS.md](./LIMITATIONS.md). Product: [shield-agent.com/install](https://shield-agent.com/install).

## Develop

```bash
pnpm install && pnpm test && pnpm build
node dist/cli.js --help
```
