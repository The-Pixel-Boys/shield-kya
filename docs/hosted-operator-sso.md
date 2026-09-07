# Hosted operator SSO / SCIM (not in OSS CLI)

Know Your Agent OSS (`@shield-agent/kya`) is the runtime gate (Allow / Deny / Hold) and agent API keys.

**Operator SSO (OIDC/SAML), SCIM 2.0, and IdP-group → role maps** ship on **Shield hosted** (**Scale**). They authenticate humans who approve Holds and manage agents. They never ALLOW a tool write.

Console roles on hosted: `OWNER` / `ADMIN` / `OPERATOR` / `READ_ONLY`. SSO manage is OWNER-only. Hold approve / kill needs operator capability (`OPERATOR` yes, `READ_ONLY` no).

Humans are created via invite or SCIM on hosted. SSO login links existing accounts — it does not JIT-create operators.

## Where to read more (hosted product)

- Hosted product: https://shield-agent.com
- Scale support / response targets: https://shield-agent.com/support
- Source of truth for the operator plane lives in the Shield Agent product repo (ADR 0009, SAML/SCIM/RBAC guides). This OSS tree intentionally does **not** ship SCIM or SAML SP code.

## Verification (hosted CI)

Hosted SSO/SCIM is exercised against local Keycloak in the Shield Agent product CI job `sso-scim-e2e` (inside workflow `ci`). A red run blocks auto-deploy. That harness is not part of this npm package.

## Policy enforcement vs SSO

Operator SSO/SCIM is the **human** plane (who may approve Holds). Runtime policy enforcement (Allow / Hold / Deny before tool writes) is a separate PEP on the control plane. Optional hosted OPA packs may further DENY only. Neither SSO nor OPA replaces Shield `APPROVED`.

## OSS stays

`register-agent`, `wrap`, `evaluate`, trail, MCP gate.
