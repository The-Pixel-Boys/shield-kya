# Reference

Upgrade notes, team rollout, dual plane, plans, environment variables, MCP tools, wrap and the SDK shims. Moved out of the package README. Back to the [README](../README.md).

## Upgrade notes

- Semantic search is no longer installed by default (about 230 MB less on disk). After upgrading, activity search is lexical (BM25) only until you run the install command in [Natural-language search](activity-record.md#natural-language-search).
- The CLI loads the OpenTelemetry SDK only when an OTLP endpoint is set. A start error is logged once to stderr; metrics stay off and the command continues.
- Hook verdicts and fail-open rules are unchanged.
- `kya update` self-updates kya to the latest npm version.

## Team rollout

- `kya team init` adds a tag-pinned plugin marketplace and an enabled plugin to the project settings, so everyone who opens the repo gets the plugin. Run it with `--dry-run` first to see the change.
- `kya team managed-settings` prints the managed-settings JSON that an administrator deploys.
- Step by step: [Team rollout](team-rollout.md).

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

## Plans (hosted, plan tiers v2)

The rows below apply only when the hosted service turns plan tiers v2 on. Until then the hosted plans are Free, Starter, Pro and Scale.

The hosted console has these plans. The CLI works on every plan. Solo and the no-card trial appear only when the hosted service turns plan tiers on.

| Plan | Price | Seats | Trail history | Notes |
|---|---|---|---|---|
| Free | $0 | 2 | 30 days | Start here |
| Solo | $90 a year | 1 | 90 days | CSV evidence export. Yearly only |
| Team | $29 a month | 5 | 90 days | Formerly "Starter" |
| Pro | $149 a month | 25 | 90 days | Compliance report PDF, signed evidence bundles |
| Scale | $499 a month | Unlimited | 365 days | SSO and SCIM |

n8n and Zapier access is included in every paid plan. There is no add-on price.

## Environment

| Variable | Required | Meaning |
|----------|----------|---------|
| `KYA_BASE_URL` | Yes (network cmds) | Control plane origin |
| `KYA_API_KEY` | When auth is on | API key (or Bearer JWT for decide verbs) |
| `KYA_HOST` | No (default `ide`) | `ide` \| `runtime` |
| `KYA_AGENT_ID` | After register | Agent principal id |
| `KYA_MCP_PORT` | No (default `3920`) | HTTP MCP listen port |
| `KYA_OFFLINE` | No | `1`/`true` for sample evaluate |
| `KYA_HOLD` | No | `1`/`true` for the org Hold path (REQUIRE_APPROVE opens a human ticket) |
| `KYA_DASH_PLAN` | No | `enterprise` unlocks licensed TUI panes |
| `KYA_IOC` | No | `0` turns off the daily background IoC scan started by `kya hook` (`kya doctor --iocs` still runs) |
| `KYA_DIFF_PREVIEW` | No | `0` disables clipped change previews on the receipt |
| `KYA_RECEIPT_AUTO` | No | `0` disables auto-open receipt after wrap; `1` forces |
| `KYA_SEARCH_SEMANTIC` | No | `off` disables MiniLM semantic reranking (BM25 still works) |
| `KYA_SEARCH_INDEX_MAX` | No (default `20000`) | Most events kept in the search vector file |
| `KYA_RECEIPT_MAX_RSS_MB` | No (default `512`; `2048` when plain-language search is installed) | The live report process exits when its memory (RSS) is above this many MB; the next `kya start` or `kya receipt` starts a new one. `0` turns the check off |
| `KYA_SEMANTIC` | No | `on` lets `kya start` install the plain-language search runtime without asking; `off` never asks |
| `KYA_SHARE_URL` | No | `kya receipt --share` collector base (default `https://shield-agent.com`) |
| `KYA_TELEMETRY` | No | `0`/`off` forces anonymous usage stats off ([docs/telemetry.md](telemetry.md)); they are off unless you opted in |
| `DO_NOT_TRACK` | No | `1` forces anonymous usage stats off, same as `KYA_TELEMETRY=0` |
| `KYA_BASE_URL` | No | Hosted console for `kya login` (default `https://shield-agent.com`; https or loopback only) |
| `KYA_QUIET` | No | Any true value hides the one-line hosted calls to action (`kya certify`, `kya receipt`) |
| `KYA_CTA` | No | `0`/`off` turns off the one-line hosted calls to action ([docs/login.md](login.md#calls-to-action-one-line)) |

Gate mode can also be set in the project's `.kya/config.json`:
`{"gateMode": "hold"}` or `{"gateMode": "offline"}` (exact values only;
anything else is ignored). The gate itself (wrap / hook / eval) follows it
with the precedence flags > env > config > observe, and `kya certify`
reports through the same resolver, so a certify pass on gate mode always
reflects how the gate actually runs.

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
      "args": ["--no-install", "@shield-agent/kya@0.35.1", "serve-mcp", "--stdio"],
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

A hosted high-risk request (HIGH priority now or before, or created with the irreversible hint) cannot be approved from the CLI or the TUI: the hosted plane answers 403 `kya.approval_console_mfa_required`. Approve it in the hosted console with a two-factor code. `reject` always works.

`wrap --tool-id …` evaluates and may open a pending ticket. It never executes the side effect. `wrap [--offline] -- <cmd…>` gates the command as a shell call and runs it only when the verdict allows (an observed Review counts as allowed). Its exit code is the command's own, or `1` Deny, `4` Hold pending, `126` not executable, `127` not found. The verdict lines go to stderr, so the command's stdout stays clean. `invoke` asks the live plane to authorize after Allow or APPROVED. It does not run the write on this machine. The TUI (`dash`) can `a`/`x` decide only after `y` confirm with a JWT (`sk_*` refused).

## In-process SDK shims

Agents built on LangGraph.js, the Vercel AI SDK, Mastra, OpenAI Agents TS, or the Claude Agent SDK can route tool calls through the same evaluate path without a gateway:

```ts
import { governed, governLangGraphTool, KyaDeniedError } from "@shield-agent/kya/sdk";

const run = governed({ toolId: "write_file", server: "filesystem", fn: myWrite });
await run({ path: "out.txt", content: "hi" }); // throws KyaDeniedError on DENY
```

Offline evaluate by default (no network, no hosted plane); an explicit config uses the live plane. `governA2aSend` gates in-process agent-to-agent sends. The `shield-kya` Python package on PyPI ships framework hooks (LangChain, CrewAI, OpenAI Agents SDK and others), fail-open like `kya hook`. Support matrix and recipes: `docs/sdk-integrations.md`; runnable scripts: `examples/sdk/`.

Framework recipes (each one tested with a scripted model and the published CLI): [LangChain](sdk-integrations.md#langchain-python) · [OpenAI Agents SDK](sdk-integrations.md#openai-agents-sdk-python) · [CrewAI](sdk-integrations.md#crewai-python) · [LlamaIndex](sdk-integrations.md#llamaindex-python) · [Mastra](sdk-integrations.md#mastra-typescript) · [Vercel AI SDK](sdk-integrations.md#vercel-ai-sdk-typescript)
