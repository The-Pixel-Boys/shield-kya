# Shield KYA

**Know Your Agent** control plane for agent tools: identity, policy, dual-plane host labels, human approval, trail, policy-gated spawn, session shrink, signed claims.

```bash
npx @shield-agent/kya@latest --help
```

[![npm](https://img.shields.io/npm/v/@shield-agent/kya.svg)](https://www.npmjs.com/package/@shield-agent/kya)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Install](https://img.shields.io/badge/install-shield--agent.com%2Finstall-0A0A0A)](https://shield-agent.com/install)
[![GitHub](https://img.shields.io/badge/github-The--Pixel--Boys%2Fshield--kya-181717)](https://github.com/The-Pixel-Boys/shield-kya)

**Offline try (no account):**

```bash
npx @shield-agent/kya@latest eval-tool --offline --tool-id org.sample.never.event --irreversible
# → DENY
npx @shield-agent/kya@latest eval-tool --offline --tool-id org.sample.data.write --irreversible
# → REQUIRE_APPROVE

npx @shield-agent/kya@latest dash --once --offline
# → terminal dashboard (sample policy pane; not production PEP)
```

Public GitHub: https://github.com/The-Pixel-Boys/shield-kya

This directory is the MIT public surface: sample tools, LIMITATIONS, dual-plane diagram, comparison table. The monorepo may stay private.

---

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

Same agent identity, policy, approval, and trail on both hosts. Missing `APPROVED` means no irreversible side effect. Risk may only raise severity. It never auto-ALLOWs.

Creating an agent is a tool (`kya.agent.register`). A live session can shrink from Deploy to Build to Read without killing the agent. Hosted passports and session claims are signed (v2). This offline tree cannot mint those signatures.

---

## Sample custom tools only

No vertical packs required.

| toolId | Expected verdict | Notes |
|--------|------------------|-------|
| `org.sample.safe.read` | `ALLOW` | Read-only sample |
| `org.sample.data.write` | `REQUIRE_APPROVE` | Irreversible write |
| `org.sample.never.event` | `DENY` | Hard deny |
| `kya.agent.register` | `REQUIRE_APPROVE` | Creating an agent is a tool |

Register your own `toolId` plus metadata. No prebuilt adapter required.

---

## Commands

| Command | Purpose |
|---------|---------|
| `init` | Scaffold `.kya/` + sample tools |
| `register-agent` | Register principal on a control plane |
| `eval-tool` | Policy evaluate (`--offline` for local sample) |
| `wrap` | Evaluate + open a ticket on REQUIRE_APPROVE. Never executes. |
| `approve` / `reject` | Human decide (`kya.approve`). TUI does not decide. |
| `serve-mcp` | Local MCP gate (HTTP or `--stdio`) |
| `dash --once --offline` | Terminal dashboard (sample panes; enterprise panes licensed) |
| `orr run --path` | Read-only ORR report (evidence only) |

Package: [`@shield-agent/kya`](https://www.npmjs.com/package/@shield-agent/kya). MCP: `server.json` / `mcpName` in package.

---

## Comparison

| Capability | Shield KYA | AGT-class runtime gov | OPA / policy infra | AI SAFE²-class catalogs | agent-readiness scanners | OpenAI-style rails |
|------------|------------|----------------------|--------------------|-------------------------|--------------------------|--------------------|
| Fail-closed tool PEP for any custom `toolId` | **Yes** | Partial / runtime-specific | Policy engine only | Catalog + scanner | Readiness scores | Tripwires / needsApproval |
| Dual-plane `host=ide\|runtime` | Yes | Varies | No | No | No | Session-ish |
| Human `REQUIRE_APPROVE` as gate (not UI only) | **Yes** | Varies | DIY | DIY | No | HITL patterns |
| Sole PEP (no second ALLOW path) | **Yes** | Varies | N/A | Evidence | Evidence | App-level |
| MCP / OpenAPI first | **Yes** | Varies | N/A | Often | CLI | SDK-first |
| Multi-lang enterprise runtime | Not the focus | **Strong** | Strong | Strong | N/A | Platform |
| General-purpose policy language | No (product plane) | Limited | **OPA** | Large catalogs | Checklists | Guardrails config |
| ORR / readiness board | Observe + ORR report | — | — | Strong | **Strong** | — |

Shield is protocol-first dual-plane identity, approval, and trail. AGT covers multi-lang runtime governance. OPA is general policy infra. Dialog rails stay in a guardrails product.

---

## LIMITATIONS

- Offline `--offline` evaluate / `dash` is a sample fixture for demos and tests. It is not the production PEP.
- Production enforcement needs a control plane (local free console or hosted). An empty API key against an auth plane fails closed.
- This baseline ships sample custom tools only. No vendor marketplace adapter as a core dependency.
- Unsigned v1 passport JSON is observational. Signed v2 claims need the hosted control-plane key.
- Spawn without a control plane cannot be gated. Hosts that skip wrap still walk around session shrink.
- ORR / scanners produce evidence. They never ALLOW irreversible side effects.
- Pin, private registry, multi-tenant density, ORR board ops, and support are a separate tier. They must not block day-1 `npx`.
- Growth counts are observe metrics (principals, evaluates, approvals, orphans).
- Monorepo internals may stay private. npm plus this baseline are the public surface.

---

## Good first issues

- Add a sample custom `toolId` descriptor + offline test
- MCP snippet for your editor
- Translate LIMITATIONS for a new language
- ORR probe for an additional first-party signal (read-only)

---

## Enterprise (distinct)

| Solo `npx` | Enterprise |
|----------|------------|
| `npx` + offline demo | Pin / private registry |
| Public sample tools | Curated tool packs (optional) |
| Local free console | Multi-tenant density + isolation |
| ORR CLI report | ORR board + support |

Day-1 `npx` does not wait on enterprise gates.

---

## Links

- Install: https://shield-agent.com/install
- Package source (when monorepo visible): `sdks/kya/`
- Sole PEP is Shield KYA. Dual-plane labels. Your own `toolId`s.

**License:** MIT. See [LICENSE](./LICENSE).
