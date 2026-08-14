---
name: kya-wrap
description: Wrap an agent tool through Shield KYA evaluate before any irreversible side effect. Use when adding tools, MCP calls, or writes that need ALLOW | DENY | REQUIRE_APPROVE.
---

# Wrap a tool through Shield KYA

This plugin is a **thin MCP gate**. It does not decide policy. Shield KYA
evaluate on the control plane is the **sole PEP**.

## Verdicts

| Verdict | Meaning |
|---------|---------|
| `ALLOW` | Side effect may proceed |
| `DENY` | Do not execute. Never retry around the gate |
| `REQUIRE_APPROVE` | Wait for a human `APPROVED`. Missing approval ⇒ no irreversible effect |

Risk scores may only **raise** severity. They never auto-ALLOW.

## Dual plane

- `host=ide`: authoring / dry-run
- `host=runtime`: production work

Same agent id, policy, approval, and trail on both. Label the host. Do not invent a second enforcement path in the editor.

## How to wrap

1. Register the agent principal (`register-agent` or console). Creating an agent is itself a tool (`kya.agent.register`). It is not a free write.
2. Give the tool a stable `toolId`. No marketplace adapter required.
3. Call evaluate (MCP `evaluate` / `eval-tool`) **before** the side effect.
4. If `REQUIRE_APPROVE`, request approval and wait. Do not execute on a pending ticket.
5. Offline `--offline` is a **sample fixture**. Do not treat it as production PEP.

## Do not

- Bypass evaluate because the IDE "already reviewed" the change
- Treat scanners, ORR, or this skill as a second PEP
- Position Shield as a chargeback, dispute, or payment-recovery product
