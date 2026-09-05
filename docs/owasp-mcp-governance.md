# Shield KYA and OWASP MCP governance

Maps [OWASP MCP Governance & Risk Framework v1.0](https://github.com/OWASP/OWASP-MCP-Governance-and-Risk-Project) and the [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) onto Shield Know Your Agent (KYA).

This is an alignment guide. It is not an OWASP certification and not a claim that Shield replaces your GRC program.

## Four rules

| OWASP rule | Shield |
|------------|--------|
| No owner = no approval | Principals are named agents (`AgentId`). Machine API keys are scoped. Unowned shadow installs are outside the plane until registered. |
| No logging = no production | Evaluate, Hold, and session ingest write trail. Hosted keeps hash-chained event log. Opt-in OTLP is policy metrics, not a substitute for trail. |
| No scope = no access | Tools are evaluated by id. Never-event tools are DENY. High-stakes tools go to REQUIRE_APPROVE / Hold. |
| No review = no enterprise deploy | Hosted approvals queue, agent passport, kill/revoke. Periodic org review is still your process. |

## Six principles

| Principle | Shield surface |
|-----------|----------------|
| Ownership | Register agent; API key per principal |
| Classify before connect | Treat each **tool** by risk (read vs write vs admin). Tier 0–4 below is guidance for what to wrap. |
| Least privilege for tools | Policy is per toolId, not “the whole MCP server” |
| Meaningful human approval | Hold must show **what** (tool/action), **who** (agent), **where** (host=ide\|runtime when known), **impact** (side effect blocked until APPROVED) |
| Production logging | Trail + sessions; ORR for evidence reports |
| Approved path beats shadow IT | Hosted install hub / wrap path; unwrapped tools stay invisible (not auto-discovered) |

## Tier 0–4 (guidance only)

Use tiers when deciding which tools must go through Shield. Shield does not yet ship an org MCP inventory UI; classification is operator policy.

| Tier | Meaning | Shield expectation |
|------|---------|-------------------|
| 0 | Public read-only | Optional evaluate; still watch tool poisoning |
| 1 | Internal non-sensitive read | Prefer evaluate + trail |
| 2 | Sensitive read | Evaluate + trail; Hold if combined with write tools in one session |
| 3 | Write-capable | REQUIRE_APPROVE / Hold before invoke |
| 4 | Privileged / critical | Hold + named owner + kill path; CISO process outside product |

Classify by the **highest-risk tool** on the server, not the server marketing name.

## OWASP MCP Top 10

| Risk | Shield enforces (PEP) | Shield evidence | Customer / host |
|------|------------------------|-----------------|-----------------|
| MCP01 Token / secret exposure | Deny raw secret tools when policy says so; no secrets in OTLP | Trail redaction on hosted LLM path | Vault / secret hygiene |
| MCP02 Scope creep | Re-evaluate new toolIds; never-events | ORR / change review | Re-classify on tool add |
| MCP03 Tool poisoning | Does not rewrite remote tool schemas | ORR / scanner evidence optional | Scan MCP descriptors before approve |
| MCP04 Supply chain | Pin npm versions; no auto `npx -y` in our docs | Scorecard / ORR optional | SBOM / pin deps |
| MCP05 Command injection | DENY / Hold on shell-like toolIds you wrap | Trail of evaluates | Sandbox on host |
| MCP06 Prompt injection / intent subversion | Hold on write after untrusted read (policy) | Sessions | Separate read/write MCP catalogs |
| MCP07 Authn / authz | API key / Bearer on MCP; fail closed on Hold | Auth audit | OAuth audience on HTTP MCP servers |
| MCP08 Audit / telemetry | Trail, sessions, OTLP metrics | ORR reports | SIEM join |
| MCP09 Shadow MCP | Unwrapped = invisible | Orphan / growth metrics | Inventory discovery (hosted roadmap) |
| MCP10 Context over-sharing | Host labels ide vs runtime | Session ingest | Host context isolation |

## Evidence pack (what to show an auditor)

| Ask | Artifact |
|-----|----------|
| Who can act? | Agent passport / principal list |
| What was decided? | Evaluate records + Hold approve/reject |
| Was the write blocked until approve? | `sideEffect=blocked` on wrap / MCP request_approval |
| Immutable trail? | Hosted event log (hash chain) |
| Policy meters? | OTLP / console metrics (not a billing meter) |
| Readiness snapshot? | `kya orr run` JSON/MD |

## 30 / 90 day checklist (ops)

Copy of OWASP rollout, mapped to Shield:

1. Inventory MCP servers you know (spreadsheet or future hosted registry).  
2. Mark Tier by highest-risk tool; wrap Tier 2+ through Shield.  
3. Publish: no owner / no logging / no scope rules.  
4. Name owners for Tier 2+.  
5. Monthly: pending Holds, kill events, unwrapped usage if visible.

## Hosted inventory (shipping)

Hosted console: `/app/kya/mcp-assets` — tenant MCP asset list, OWASP-style eight-factor auto score, suggested Tier 0–4. Hard gates: no owner / no logging block production status. This is inventory, not a second PEP.

Sync roadmap (ToolHive + official MCP Registry): hosted `docs/dev/kya-mcp-registry-roadmap.md`.

Still deferred: network discovery of shadow MCP; vendor intake questionnaires.

## Non-claims

- We do not sell “OWASP compliant” as a certificate.  
- We do not scan your office LAN for shadow MCP.  
- Complements (ORR scanners) never ALLOW a write.
