---
name: kya-wrap
description: Wrap an agent tool through Shield KYA evaluate before any irreversible side effect, when the kya MCP tools are connected. Use when adding tools, MCP calls, or writes that need ALLOW | DENY | REQUIRE_APPROVE.
---

# Wrap a tool through Shield KYA

## First check: are the kya MCP tools here?

This skill applies only when the kya MCP tools (`kya.policy_evaluate`, `kya.request_approval`) are available in this session.
If they are not, for example in the Gemini CLI extension, which installs hooks only, stop here: do not try to call
evaluate and do not wait for an approval, because none will arrive. In that setup kya is advisory: its hook records
each tool call and blocks only a small never-list, and the user reviews the trail afterwards.

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
