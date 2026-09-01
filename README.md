# `@shield-agent/kya`

CLI and local MCP gate for Shield’s Know Your Agent path.

If an agent can change a real system, it has to ask Shield first. You register the agent, wrap the tool, and get Allow, Hold, or Deny. Hold waits for a person. This package does not scan your network. Agents that never call evaluate stay invisible on purpose.

Walkthrough: [how you use it](https://shield-agent.com/how-kya-works#using).

```bash
npx @shield-agent/kya@latest --help
```

It works with any host that speaks MCP or OpenAPI. Vertical packs are optional. Shield is the only policy decision point: this gate never auto-approves an irreversible side effect.

If `KYA_API_KEY` is empty against an authenticated plane, network commands exit non-zero. `eval-tool`, `wrap`, and `invoke` exit `0` on ALLOW, `4` on REQUIRE_APPROVE, and `1` on DENY or unknown, so a line like `eval-tool && write` cannot skip the gate.

`--offline` runs sample evaluate without a paid cloud (useful for DENY and REQUIRE_APPROVE demos). Creating an agent is itself a tool: offline, `kya.agent.register` comes back REQUIRE_APPROVE. Allow, break-glass, and approve mint modes live on the control plane.

## 15-minute path

```bash
# Offline demo (no account, no monorepo)
npx @shield-agent/kya eval-tool --offline --tool-id org.sample.never.event --irreversible
# → verdict: DENY
npx @shield-agent/kya eval-tool --offline --tool-id org.sample.data.write --irreversible
# → verdict: REQUIRE_APPROVE

# Scaffold + local plane
npx @shield-agent/kya init
npx @shield-agent/kya eval-tool --offline --tool-id kya.agent.register --irreversible
# → verdict: REQUIRE_APPROVE
npx @shield-agent/kya register-agent --name solo-builder --version-hash dev-local
npx @shield-agent/kya eval-tool --tool-id org.sample.never.event --irreversible
npx @shield-agent/kya serve-mcp --stdio

# Terminal desk (FREE personal panes; --offline works without a key)
npx @shield-agent/kya dash --once --offline
# Interactive TTY: 1-8 panes, e force-eval, p auto-refresh, y confirms kill/shrink/decide
npx @shield-agent/kya dash
```


Install hub: [https://shield-agent.com/install](https://shield-agent.com/install)

## Dual plane

```
 host=ide (authoring)          host=runtime (production)
        │                              │
        └────────── same agent ────────┘
                    identity
                    policy evaluate  → ALLOW | DENY | REQUIRE_APPROVE
                    approval + trail
```

Tag sessions with `KYA_HOST=ide` or `KYA_HOST=runtime`. Same policy path either way.

## Environment

| Variable | Required | Meaning |
|----------|----------|---------|
| `KYA_BASE_URL` | Yes (network cmds) | Control plane origin |
| `KYA_API_KEY` | When auth is on | API key (or Bearer JWT for decide verbs) |
| `KYA_HOST` | No (default `ide`) | `ide` \| `runtime` |
| `KYA_AGENT_ID` | After register | Agent principal id |
| `KYA_MCP_PORT` | No (default `3920`) | HTTP MCP listen port |
| `KYA_OFFLINE` | No | `1`/`true` for sample evaluate |
| `KYA_DASH_PLAN` | No | `enterprise` unlocks licensed TUI panes |

## MCP tools

| Tool | Role |
|------|------|
| `kya.policy_evaluate` | `ALLOW` \| `DENY` \| `REQUIRE_APPROVE` |
| `kya.session_ingest` | Observe / raise-only risk |
| `kya.request_approval` | Open a human Hold. Does not execute the side effect |

MCP Registry entry: `server.json` plus package `mcpName` `io.github.The-Pixel-Boys/shield-kya`.

```json
{
  "mcpServers": {
    "shield-kya": {
      "command": "npx",
      "args": ["--no-install", "@shield-agent/kya@0.1.23", "serve-mcp", "--stdio"],
      "env": {
        "KYA_BASE_URL": "http://127.0.0.1:8090",
        "KYA_API_KEY": "${KYA_API_KEY}",
        "KYA_HOST": "ide"
      }
    }
  }
}
```

## Wrap and decide

```bash
npx @shield-agent/kya wrap --offline --tool-id org.sample.data.write --irreversible
npx @shield-agent/kya approve --id <approval-id>
npx @shield-agent/kya reject --id <approval-id>
```

`wrap` evaluates and may open a pending ticket. It never executes the side effect. `invoke` asks the live plane to authorize after Allow or APPROVED. It does not run the write on this machine. The TUI (`dash`) can `a`/`x` decide only after `y` confirm with a JWT (`sk_*` refused).

## Claude connector

**Desktop / Claude Code (local stdio):**

```bash
# Prefer a preinstalled package (no registry auto-install):
npx --no-install @shield-agent/kya@0.1.23 serve-mcp --stdio
# Or after npm i -g / local install:
kya serve-mcp --stdio
```

Copy `claude/claude_desktop_config.example.json` into Claude Desktop MCP settings, or use `.mcp.json` for Claude Code. Pack a Desktop extension with `npx @anthropic-ai/mcpb pack` (see `manifest.json`). That pack runs the packed `dist/cli.js`, not `npx -y`.

**Claude.ai / Cowork (hosted):** add a custom connector at `https://shield-agent.com/mcp` with request header `Authorization: Bearer <KYA_API_KEY>` (or `X-API-Key`). It is not Directory-listed yet (API-key auth, no OAuth DCR).

## OpenAI (Codex / Responses)

**Codex CLI / IDE:** copy `openai/codex.config.example.toml` into `~/.codex/config.toml`. Local stdio uses `npx --no-install @shield-agent/kya@0.1.23 serve-mcp --stdio`. Hosted Codex uses `url = "https://shield-agent.com/mcp"` with `bearer_token_env_var = "KYA_API_KEY"`.

**Responses API:** see `openai/responses-mcp.example.json` (`server_url` + `Authorization: Bearer <KYA_API_KEY>`).

**ChatGPT Apps (chatgpt.com):** deferred. Developer Mode wants OAuth. Use Codex until then.

## Gemini CLI

Merge `gemini/settings.example.json` (stdio) or `gemini/settings.hosted.example.json` (`httpUrl` + Bearer) into `~/.gemini/settings.json` or `.gemini/settings.json`. Do not enable both at once.

## Grok

Hosted custom connector: `https://shield-agent.com/mcp` (see `grok/README.md`). Grok rejects localhost. Prefer a Bearer machine key when the UI offers a request header. For a local agent host, use the same stdio launch as Claude/Codex/Gemini.

## Cursor plugin

The package includes `.cursor-plugin/plugin.json`, `mcp.json`, and a wrap skill. Public listing repo: https://github.com/The-Pixel-Boys/shield-kya

## ORR (reporting only)

```bash
npx @shield-agent/kya orr run --path . --out ./orr-report --skip-optional-producers
npx @shield-agent/kya orr run --path . --out ./orr-report --scorecard ./scorecard.json --producer openssf.scorecard
npx @shield-agent/kya orr run --path . --out ./orr-report --producer harness.agentshield --agentshield-json ./agentshield-report.json
```

ORR is a reporting board. Scanners, `--scorecard`, and `harness.agentshield` are evidence. They never ALLOW a high-stakes side effect, so they are not a second policy gate. AgentShield is optional and read-only: no `--fix`, no MiniClaw, no runtime hook. This package does not depend on `ecc-agentshield`. If you pass `--producer harness.agentshield` and have neither `--agentshield-json` nor an `agentshield` binary, ORR records a coverage gap and still exits 0. Explicit `--producer` always attempts; `--skip-optional-producers` only skips producers you did not ask for.

## Optional sandbox wrap (Firecracker)

Beside the gate, not inside MCP. Opt-in only:

```bash
KYA_SANDBOX=mock kya sandbox spawn
KYA_SANDBOX=mock kya sandbox exec --sandbox-id <id> --cmd "true"
KYA_SANDBOX=mock kya sandbox kill --sandbox-id <id>
```

`org.sample.sandbox.exec` without `--sandbox-id` is **DENY** `MISSING_SANDBOX_ID`. Real Firecracker needs `firecracker` + `jailer` on PATH and kernel/rootfs env (`KYA_SANDBOX_KERNEL`, `KYA_SANDBOX_ROOTFS`). We do not ship those binaries. `serve-mcp` still exposes only evaluate / ingest / request_approval.

## Cost showback (observe only)

`kya orr run --usage ./usage.json` (or `.kya/usage.json`) adds a showback section: tokens and estimated USD by agent and run. Subagents nest under `parentRunId`. That section is not a billing meter and not a policy gate. Hosted metrics show the same rollup when usage is ingested with a session.

## Enterprise (separate tier)

Pin, private registry, multi-tenant density, ORR board ops, and support are not required for the day-1 `npx` path above.

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

## Docs

- [Install hub](https://shield-agent.com/install)
- [How KYA works](https://shield-agent.com/how-kya-works)
- See also `LIMITATIONS.md` in this repo

## OTLP (optional)

Set `KYA_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) to export thin CLI evaluate latency metrics to your Collector. Tags are low-cardinality (`verdict`, `host`) only — no tool args or API keys.

Hosted plane exports richer Micrometer gauges/timers when `KYA_OTLP_ENABLED=true`. See `docs/ops/kya-otlp-grafana.md` and `docs/ops/kya-otlp-datadog.md` in the monorepo.
