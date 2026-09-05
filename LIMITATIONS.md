# Known limitations

- This package does not scan a network or discover agents that never call evaluate.
- Offline `eval-tool --offline` and `dash --once --offline` use a sample policy surface for demos. Production needs a real control plane (local free or hosted).
- Unsigned v1 passport JSON is observational. Signed v2 claims (`shield-kya-agent-passport-v2`, `shield-kya-session-claim-v1`) need the hosted control-plane key.
- If a host never wraps tools, session shrink cannot stop it. Spawn without a control plane cannot be gated.
- `wrap` evaluates (and may open a pending ticket). It never executes the side effect. Offline wrap does not call the approval API.
- `invoke` authorizes on a live plane after Allow or APPROVED. It never runs the customer write in the CLI. There is no `--offline` invoke.
- The TUI (`dash`) can `a`/`x` decide only after `y` confirm, and only with a JWT that has `kya.approve`. Machine `sk_*` keys are refused (print the CLI hint instead).
- Human decide is also `kya approve --id` / `kya reject --id` against `POST /api/v1/kya/approvals/{id}/approve|reject` (`kya.approve` scope).
- Shield KYA evaluate/approve is the only policy decision point (`ALLOW` / `DENY` / `REQUIRE_APPROVE`). Scanners, `--scorecard`, `harness.agentshield`, and the ORR CLI write evidence. They never ALLOW a side effect. AgentShield is opt-in (`--producer harness.agentshield` or `--agentshield-json`). Trust scores never authorize writes. The CLI never passes `--fix`, never starts MiniClaw, and never installs `ecc-agentshield`.
- Dialog safety belongs in a guardrails product.
- Multi-language in-process runtimes are out of scope.
- Use OPA if you need a general policy language.
- Multi-tenant density, private registries, ORR board ops, pin, and support are separate from the solo `npx` path.
- Growth counts are observe metrics (principals, evaluates, approvals).
- OTLP metrics are opt-in and off by default. OSS CLI is thin (evaluate latency only). Hosted is richer Micrometer export. Neither path is a policy decision. See `docs/otlp.md`.

- Showback USD is an estimate from a checked-in published rate table. Unknown models report tokens only. ORR / metrics never ALLOW, DENY, or kill on spend.
- `--usage` must sit inside `--path`. Usage rows drop secret-shaped strings and labels over 64/128 chars. Hosted ingest is merchant-scoped and length-capped the same way.

- The hosted Claude connector uses machine API keys (Bearer). It is a custom connector, not an Anthropic Directory listing. OAuth DCR is a later slice.
- OpenAI: Codex CLI and the Responses API use the same `/mcp` URL with a machine API key. ChatGPT Apps on chatgpt.com (Developer Mode) are deferred until OAuth DCR. ChatGPT cannot attach a local stdio server.
- Gemini CLI supports stdio and hosted `httpUrl` with a Bearer header. Gemini Enterprise / Spark custom MCP OAuth is out of scope.
- Grok (grok.com) custom connectors need a public HTTPS URL. Localhost and private IPs are rejected. If the UI only offers OAuth or no auth, use Codex, Gemini CLI, or the xAI SDK instead of turning auth off.
- Local HTTP MCP remains loopback-only. Do not bind it to a public interface.
- Optional `kya sandbox` (Firecracker) is a runtime wrap beside the gate, not a hypervisor product. Binaries are not in npm. Default off (`KYA_SANDBOX`). MCP still never executes spawn/exec. Kernel bugs and unwrapped shells remain residual risk (see ADR 0007).
