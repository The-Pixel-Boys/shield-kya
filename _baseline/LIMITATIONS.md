# Known limitations

- Offline `eval-tool --offline` and `dash --once --offline` use a **sample** policy surface for demo. Production uses a real control plane (local free or hosted).
- Unsigned v1 passport JSON is observational. Signed v2 claims (`shield-kya-agent-passport-v2`, `shield-kya-session-claim-v1`) need the hosted control-plane key.
- Spawn without a control plane cannot be gated. Hosts that skip wrap still walk around session shrink.
- `wrap` evaluates (and may open a pending ticket). It **never** executes the side effect. Offline wrap does not call the approval API.
- The TUI (`dash`) is observational. Keys `a`/`x` print the CLI decide hint; they do not APPROVE or REJECT.
- Human decide is `kya approve --id` / `kya reject --id` against `POST /api/v1/kya/approvals/{id}/approve|reject` (`kya.approve` scope).
- Sole PEP is Shield KYA evaluate/approve path (`ALLOW` / `DENY` / `REQUIRE_APPROVE`). Scanners, `--scorecard`, and ORR CLI are **evidence only**, not a second PEP.
- Not a model/content moderation product (use guardrails for dialog rails).
- Not a multi-language in-process runtime like MS Agent Governance Toolkit.
- Not general OPA replacement for infra policy.
- Enterprise multi-tenant density, private registries, ORR board ops, pin, and support are separate from the solo `npx` path.
- Growth unit economics = observe metrics (principals, evaluates, approvals) — not quality/speed OKRs.
