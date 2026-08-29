# Known limitations

- This package does not scan a network or discover agents that never call evaluate.
- Offline `eval-tool --offline` and `dash --once --offline` use a **sample** policy surface for demo. Production uses a real control plane (local free or hosted).
- Unsigned v1 passport JSON is observational. Signed v2 claims (`shield-kya-agent-passport-v2`, `shield-kya-session-claim-v1`) need the hosted control-plane key.
- Spawn without a control plane cannot be gated. Hosts that skip wrap still walk around session shrink.
- `wrap` evaluates (and may open a pending ticket). It **never** executes the side effect. Offline wrap does not call the approval API.
- `invoke` authorizes on a live plane after Allow or APPROVED. It never runs the customer write in the CLI. There is no `--offline` invoke.
- The TUI (`dash`) is observational. Keys `a`/`x` print the CLI decide hint; they do not APPROVE or REJECT.
- Human decide is `kya approve --id` / `kya reject --id` against `POST /api/v1/kya/approvals/{id}/approve|reject` (`kya.approve` scope).
- Sole PEP is Shield KYA evaluate/approve (`ALLOW` / `DENY` / `REQUIRE_APPROVE`). Scanners, `--scorecard`, `harness.agentshield`, and ORR CLI write evidence. They never ALLOW a side effect. AgentShield is opt-in (`--producer harness.agentshield` or `--agentshield-json`). The CLI never passes `--fix`, never starts MiniClaw, and never installs `ecc-agentshield`.
- Dialog safety stays in a guardrails product.
- Multi-language in-process runtimes are out of scope.
- Use OPA if you need a general policy language.
- Multi-tenant density, private registries, ORR board ops, pin, and support are separate from the solo `npx` path.
- Growth counts are observe metrics (principals, evaluates, approvals).

- Showback USD is an estimate from a checked-in published rate table. Unknown models report tokens only. ORR / metrics never ALLOW, DENY, or kill on spend.
