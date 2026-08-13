# Shield KYA — public baseline

**Know Your Agent** control plane for agent tools: identity, policy, dual-plane host labels, human approval, trail.

> **One command**

```bash
npx @shield-agent/kya@latest --help
```

[![npm](https://img.shields.io/npm/v/@shield-agent/kya.svg)](https://www.npmjs.com/package/@shield-agent/kya)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Install](https://img.shields.io/badge/install-shield--agent.com%2Finstall-0A0A0A)](https://shield-agent.com/install)
[![GitHub](https://img.shields.io/badge/github-The--Pixel--Boys%2Fshield--kya-181717)](https://github.com/The-Pixel-Boys/shield-kya)

**Free try (offline, no account):**

```bash
npx @shield-agent/kya@latest eval-tool --offline --tool-id org.sample.never.event --irreversible
# → DENY
npx @shield-agent/kya@latest eval-tool --offline --tool-id org.sample.data.write --irreversible
# → REQUIRE_APPROVE

npx @shield-agent/kya@latest dash --once --offline
# → free terminal dashboard (sample policy pane; not production PEP)
```

Public GitHub: https://github.com/The-Pixel-Boys/shield-kya

This directory is the **thin public surface** (MIT) for PLG: sample custom tools only, honest LIMITATIONS, dual-plane diagram, comparison table. The monorepo may stay private; publish this tree (or the npm package) for stars/downloads.

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

Same agent identity, policy, approval, and trail on both hosts. Missing `APPROVED` ⇒ **no** irreversible side effect. Risk may only **raise** severity, never auto-ALLOW.

---

## Sample custom tools only

No vertical packs required (disputes optional elsewhere).

| toolId | Expected verdict | Notes |
|--------|------------------|-------|
| `org.sample.safe.read` | `ALLOW` | Read-only sample |
| `org.sample.data.write` | `REQUIRE_APPROVE` | Irreversible write |
| `org.sample.never.event` | `DENY` | Never-event / hard deny |

Custom tools are first-class via stable `toolId` + metadata. Register your own; no prebuilt adapter required.

---

## Commands

| Command | Purpose |
|---------|---------|
| `init` | Scaffold `.kya/` + sample tools |
| `register-agent` | Register principal on a control plane |
| `eval-tool` | Policy evaluate (`--offline` for local sample) |
| `serve-mcp` | Local MCP gate (HTTP or `--stdio`) |
| `dash --once --offline` | Free terminal dashboard (sample panes; enterprise panes licensed) |
| `orr run --path` | Read-only ORR report (evidence only — **not** a second PEP) |

Package: [`@shield-agent/kya`](https://www.npmjs.com/package/@shield-agent/kya) · MCP: `server.json` / `mcpName` in package.

---

## Comparison (honest)

| Capability | Shield KYA | AGT-class runtime gov | OPA / policy infra | AI SAFE²-class catalogs | agent-readiness scanners | OpenAI-style rails |
|------------|------------|----------------------|--------------------|-------------------------|--------------------------|--------------------|
| Fail-closed tool PEP for **any** custom `toolId` | **Yes** | Partial / runtime-specific | Policy engine only | Catalog + scanner | Readiness scores | Tripwires / needsApproval |
| Dual-plane `host=ide\|runtime` | **First-class** | Varies | No | No | No | Session-ish |
| Human `REQUIRE_APPROVE` as gate (not UI only) | **Yes** | Varies | DIY | DIY | No | HITL patterns |
| Sole PEP doctrine (no dual-PEP) | **Yes** | Varies | N/A | Evidence | Evidence | App-level |
| MCP / OpenAPI first | **Yes** | Varies | N/A | Often | CLI | SDK-first |
| Multi-lang enterprise runtime | Not the focus | **Strong** | Strong | Strong | N/A | Platform |
| General-purpose policy language | No (product plane) | Limited | **OPA** | Large catalogs | Checklists | Guardrails config |
| ORR / readiness board | Observe + ORR report | — | — | Strong | **Strong** | — |

**Positioning:** own protocol-first dual-plane identity + approval + trail (“KYA checkpoint”). Do not try to out-AGT on multi-lang runtime governance, out-OPA as general policy infra, or out-NeMo-class dialog rails.

---

## LIMITATIONS

- Offline `--offline` evaluate / `dash` is a **sample fixture** for demos and tests — **not** the production PEP.
- Production enforcement requires a control plane (local free console or hosted). Empty API key against an auth plane fails closed.
- This baseline ships **sample custom tools only** — no disputes pack, no vendor marketplace adapter as a core dependency.
- ORR / scanners produce **evidence**; they never ALLOW irreversible side effects (no dual PEP).
- Enterprise pin/private registry, multi-tenant density, ORR board ops, and support are a **separate tier** — they must not block day-1 solo PLG.
- Growth unit economics for KYA = **observe metrics** (principals, evaluates, approvals, orphans) — not quality/speed OKRs.
- Monorepo internals may remain private; npm package + this baseline are the public surface.

---

## Good first issues

- Add a sample custom `toolId` descriptor + offline test
- Host-agnostic MCP snippet for your editor
- Translate LIMITATIONS for a new language
- ORR probe for an additional first-party signal (read-only)

---

## Enterprise (distinct)

| Solo PLG | Enterprise |
|----------|------------|
| `npx` + offline demo | Pin / private registry |
| Public sample tools | Curated tool packs (optional) |
| Local free console | Multi-tenant density + isolation |
| ORR CLI report | ORR board + support |

Never block PLG on enterprise gates.

---

## Links

- Install: https://shield-agent.com/install  
- Package source (when monorepo visible): `sdks/kya/`  
- Doctrine: sole PEP = Shield KYA · dual-plane labels · custom tools first-class  

**License:** MIT — see [LICENSE](./LICENSE).
