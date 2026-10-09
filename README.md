# `@shield-agent/kya`

[![npm](https://img.shields.io/npm/v/@shield-agent/kya.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@shield-agent/kya)
[![npm downloads/week](https://img.shields.io/npm/dw/@shield-agent/kya.svg?logo=npm&label=downloads%2Fweek)](https://www.npmjs.com/package/@shield-agent/kya)
[![npm downloads](https://img.shields.io/npm/dt/@shield-agent/kya.svg?logo=npm&label=total%20downloads)](https://www.npmjs.com/package/@shield-agent/kya)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Install](https://img.shields.io/badge/install-shield--agent.com%2Finstall-0A0A0A)](https://shield-agent.com/install)
[![X](https://img.shields.io/badge/X-%40coscosmico-000000?logo=x&logoColor=white)](https://x.com/coscosmico)


**AI agents audit trail & traceability.** Every tool call your coding agents make - gated (Allow / Review / Deny), recorded on a live local dashboard, and certifiable against the Agent Trust Baseline. One command. Free forever under MIT.

```bash
npm i -g @shield-agent/kya@latest && kya start
```

Requires **Node.js 24+**. Restart Cursor / Claude Code / Codex once so MCP loads. Hosted desk: [shield-agent.com](https://shield-agent.com/install).


CLI and local MCP gate for Shield’s Know Your Agent path.

If an agent can change a real system, it has to ask Shield first. You register the agent, wrap the tool, and get Allow, Review, or Deny. Review waits for a person. This package does not scan your network. Agents that never call evaluate stay invisible on purpose.

Walkthrough: [how you use it](https://shield-agent.com/how-kya-works#using).

```bash
npx @shield-agent/kya@latest --help
```

Requires **Node.js 24+** (`engines.node: >=24`). On an older Node the CLI offers to install 24 for you (via volta / fnm / nvm / brew), reinstall itself, and finish the command - declining just prints a warning and continues.

It works with any host that speaks MCP or OpenAPI. Vertical packs are optional. Shield is the only policy decision point: this gate never auto-approves an irreversible side effect.

If `KYA_API_KEY` is empty against an authenticated plane, network commands exit non-zero. `eval-tool`, `wrap`, and `invoke` exit `0` on ALLOW, `4` on REQUIRE_APPROVE, and `1` on DENY or unknown, so a line like `eval-tool && write` cannot skip the gate.

`--offline` runs sample evaluate without a paid cloud (useful for DENY and REQUIRE_APPROVE demos). Creating an agent is itself a tool: offline, `kya.agent.register` comes back REQUIRE_APPROVE. Allow, break-glass, and approve mint modes live on the control plane.

## One liner

```bash
npm i -g @shield-agent/kya@latest && kya start
```

Run it in your project directory. (From a clone of this repo, `./scripts/install-local.sh` replaces the npm install.)

That **inits** `.kya/`, **wires** local MCP (`.mcp.json`, `mcp.json`, `.cursor/mcp.json` → `kya serve-mcp --stdio`), also **wires user-level configs for every installed host it detects** (`~/.claude.json`, `~/.kimi-code/`, `~/.grok/`, `~/.cursor/`, …), and **opens** the live activity report. The report runs in the background - you get your terminal back; `kya stop` stops it, `kya receipt --open` reopens it. Cursor, Kiro, Qwen, Amp, Droid, Cline, and Grok pick the server up live with no restart (Kimi: just a new session); Claude Code, Codex, OpenCode, Gemini, Copilot CLI, and Kilo CLI load it on next launch - `claude --resume` keeps your conversation.

![KYA report - live dashboard: Certify trust baseline, verdicts, analytics](https://raw.githubusercontent.com/The-Pixel-Boys/shield-kya/main/assets/report-overview.png)

![Certify tab - full Agent Trust Baseline requirement table with evidence](https://raw.githubusercontent.com/The-Pixel-Boys/shield-kya/main/assets/report-certify.png)

![Activity tab - filterable agent tool-call feed with verdicts](https://raw.githubusercontent.com/The-Pixel-Boys/shield-kya/main/assets/report-activity.png)

![Changes tab - what actually changed per session: files touched with redacted diff previews](https://raw.githubusercontent.com/The-Pixel-Boys/shield-kya/main/assets/report-changes.png)

![Gateway section - local MCP gate with listeners, routes, backends, policies, and a dry-run playground](https://raw.githubusercontent.com/The-Pixel-Boys/shield-kya/main/assets/report-gateway.png)

<!-- Local paths kept in package for offline viewers: assets/report-overview.png, assets/report-certify.png, assets/report-activity.png, assets/report-changes.png, assets/report-gateway.png (legacy: assets/activity-receipt.png) -->

```bash
kya start --no-open   # wire only
kya start --force     # rewrite MCP blocks
# Receipt change previews (clipped + redacted): on by default for writes
# KYA_DIFF_PREVIEW=0 to disable
```

## One command per host

`kya start` covers Claude Code, Cursor, and any host that reads `.mcp.json` - and auto-wires the user-level config of every installed host it detects. For the rest, `kya connect` writes the host's own config dialect directly:

```bash
kya connect claude              # ~/.claude.json (merges mcpServers only)
kya connect grok                # ~/.grok/config.toml (appends [mcp_servers.shield-kya])
kya connect opencode            # ~/.config/opencode/opencode.json
kya connect qwen                # ~/.qwen/settings.json
kya connect amp                 # ~/.config/amp/settings.json
kya connect qwen --project      # project scope instead of global
kya connect kiro --force        # overwrite an existing shield-kya entry
```

Connect merges - it never rewrites a host config it can't parse, and it keeps your other servers and keys. Supported hosts: `claude`, `grok`, `opencode`, `kilo`, `kiro`, `qwen`, `kimi`, `mastracode`, `amp`, `copilot`, `cursor`. Each wires `serve-mcp --stdio` with `KYA_OFFLINE=1` so the gate starts keyless; set `KYA_API_KEY` in the host env when you point at an authenticated plane.

Hosts without a `connect` target still work: `kya wrap --offline -- <agent command>` puts the same evaluate gate in front of any CLI. Per-host recipes with verify steps and troubleshooting live in [docs/hosts/](docs/hosts/).

## Hook interception

`kya start` also wires a `PreToolUse` hook into every installed hook-capable host it detects: Claude Code (`~/.claude/settings.json`, merge-only), Grok (`~/.grok/hooks/shield-kya.json`, kya-managed file), and Kimi Code (`~/.kimi-code/config.toml`, `[[hooks]]` append). Every tool call the agent makes then passes through `kya hook` first: evaluated locally (offline, sub-second, no network) and recorded on the global trail. (If you opted in to anonymous usage stats, the hook also starts a detached helper at most once a day; see [Anonymous usage stats](#anonymous-usage-stats-opt-in-off-by-default).)

Decision mapping: a local never-list **DENY** blocks the tool call (exit `2` plus `hookSpecificOutput` deny JSON with `permissionDecision: "deny"`). **ALLOW** and **REQUIRE_APPROVE** are recorded on the trail as advisory and the call proceeds. Manual wiring can pass `--strict` on the hook command to also block **REQUIRE_APPROVE**.

Hooks are fail-open: any hook error or timeout allows the call. They are alerts plus local never-list enforcement, not the sole barrier - plane enforcement remains the MCP `kya.policy_evaluate` path. Hooks take effect in new sessions; all three hosts load hooks at session start.

```bash
kya connect claude --hooks   # wire the PreToolUse hook by hand
kya connect grok --hooks
kya connect kimi --hooks
```

## Gate (local MCP gateway)

`kya gate` puts one loopback-only listener (`127.0.0.1`, default port `3930`) in front of any MCP server you already use. Your host talks to the gateway; the gateway fans out to the real servers. Per-tool policy is generated from the [top-20 server taxonomy](docs/mcp-servers.md) - destructive names (`drop`/`truncate`/`purge`/`transfer`) and each server's ADMIN-tier tools are denied outright (and filtered from `tools/list`), everything else runs in observe mode: allowed, and audited. Every call is traced into the local trail and the live report, and can be forwarded as OTLP to the hosted intake.

**Zero-touch:** `kya start` already does this for you. It scans your detected host configs for third-party MCP servers, imports them into `.kya/gateways.json` (recorded with an `importedFrom` provenance field), installs the gateway binary, starts the listener, and rewrites each source host so the imported servers route through the gateway - the original host config is preserved under `.kya/backups/` before anything is removed. Nothing found → nothing downloaded, no listener. Opt out with `kya start --no-gate` or `KYA_GATE=off`. If the binary download fails (offline, no network), `kya start` warns once and continues without the gateway - host configs stay untouched. The manual path below is still there when you want full control:

```bash
kya gate init     # scaffold .kya/gateways.json with ready-to-move recipes
# edit gateways.json: move a recipe into "servers", fill its placeholders
kya gate setup    # download the pinned gateway binary into .kya/bin
kya gate run      # generate the gateway config, start the listener detached
kya connect claude --gate   # point the host at the gateway (server key shield-kya-gate)
kya gate doctor   # binary, config, listener health, loopback-only posture
```

`kya gate stop` stops the supervisor and the binary with it. Honest notes: `kya gate setup` (and `kya start`'s auto-bootstrap, only when it found servers to govern) downloads the pinned gateway binary from our releases - nothing else downloads anything (the only other network use is the opt-in anonymous usage stats in [docs/telemetry.md](docs/telemetry.md), off unless you say yes); `run` never downloads. Observe mode means allowed calls are recorded, not blocked - the deny set above is the only hard stop, and plane enforcement stays with `kya.policy_evaluate`. `kya connect <host> --gate` covers the same hosts as plain `connect` - grok gets a `[mcp_servers.shield-kya-gate]` url table in its config.toml (Grok supports remote MCP servers over HTTP). Per-server tiers and recipes: [docs/mcp-servers.md](docs/mcp-servers.md).

## Longer path (optional)

```bash
# Offline sample evaluate
kya eval-tool --offline --tool-id org.sample.never.event --irreversible
kya wrap --offline --tool-id Write --irreversible --args '{"path":"src/x.ts","content":"hi"}'
kya receipt --open
# Org Hold: KYA_HOLD=1 kya wrap …
kya dash --once --offline
```



Install hub: [https://shield-agent.com/install](https://shield-agent.com/install)

## Activity trail (global)

One trail for all projects: `~/.kya/trail.jsonl` (`KYA_HOME` overrides `~`). `kya receipt --open` from any directory shows activity from every project. Each event carries its project folder name - the report adds a Projects rollup once two or more projects appear, and shows the project on each feed entry. Older per-project `<project>/.kya/trail.jsonl` files are still read and merged; no migration. The trail is capped at 1 MB (tail-read: oldest events drop away), shared across all projects.

The report itself is a dashboard: a hero row on top (live **Certify** result, verdict mix, activity sparkline, showback) with tabbed sections below - **Overview** (analytics, sessions, reasons), **Certify** (the full live requirement table - every requirement grouped by domain with status, evidence, and attestation), **Activity** (the filterable event feed), **System** (wired hosts, sandboxes, ORR). Everything is one standalone offline HTML page (the live view adds a single external link: "Star on GitHub"); the live daemon from `kya start` re-renders it on every event.

### Sharing a report

`kya receipt --share` publishes a **redacted summary** of the current window (aggregate verdict counts, product and reason-code rollups, and the Certify status - no paths, no tool arguments, no session IDs) to shield-agent.com and prints a public URL (`/r/<id>`, expires after 7 days) anyone can open - every shared page carries the one-line install so readers can audit their own agents. Point it at a different collector with `--share-url <base>` or `KYA_SHARE_URL`.

Sharing is a single attempt by design (storm-proof: no silent retries against the collector); `--share-retries <n>` (max 3) opts into bounded retries on 429/5xx/network failures with exponential backoff + jitter, honoring the server's `Retry-After`.

### Natural-language search

The **Activity** search box understands plain English. It runs a hybrid of BM25 over tool IDs, summaries, reason codes, projects, and MCP server labels, plus optional local MiniLM semantic reranking. You can type things like `failed stripe transfers`, `files written by grok`, or `approval required production` - stopwords and stemming are handled automatically, and the same search works across the global trail.

- Offline or `KYA_OFFLINE=1` keeps search purely lexical (no model download).
- By default the live server downloads `BAAI/bge-small-en-v1.5` once into `~/.kya/models` and caches event vectors in `~/.kya/search-index.json`.
- `KYA_SEARCH_SEMANTIC=off` disables the model while still keeping BM25.

The hosted console uses the same hybrid search on the server side (Postgres full-text + optional OpenAI-compatible embeddings), so queries typed in either place behave the same way.

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
| `KYA_HOLD` | No | `1`/`true` for the org Hold path (REQUIRE_APPROVE opens a human ticket) |
| `KYA_DASH_PLAN` | No | `enterprise` unlocks licensed TUI panes |
| `KYA_DIFF_PREVIEW` | No | `0` disables clipped change previews on the receipt |
| `KYA_RECEIPT_AUTO` | No | `0` disables auto-open receipt after wrap; `1` forces |
| `KYA_SEARCH_SEMANTIC` | No | `off` disables MiniLM semantic reranking (BM25 still works) |
| `KYA_SHARE_URL` | No | `kya receipt --share` collector base (default `https://shield-agent.com`) |
| `KYA_TELEMETRY` | No | `0`/`off` forces anonymous usage stats off ([docs/telemetry.md](docs/telemetry.md)); they are off unless you opted in |
| `DO_NOT_TRACK` | No | `1` forces anonymous usage stats off, same as `KYA_TELEMETRY=0` |

Gate mode can also be pinned in the project's `.kya/config.json`:
`{"gateMode": "hold"}` or `{"gateMode": "offline"}` (exact values only -
anything else is ignored). The gate itself (wrap / hook / eval) honors it
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
      "args": ["--no-install", "@shield-agent/kya@0.23.0", "serve-mcp", "--stdio"],
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

## In-process SDK shims

Agents built on LangGraph.js, the Vercel AI SDK, Mastra, OpenAI Agents TS, or the Claude Agent SDK can route tool calls through the same evaluate path without a gateway:

```ts
import { governed, governLangGraphTool, KyaDeniedError } from "@shield-agent/kya/sdk";

const run = governed({ toolId: "write_file", server: "filesystem", fn: myWrite });
await run({ path: "out.txt", content: "hi" }); // throws KyaDeniedError on DENY
```

Offline evaluate by default (no network, no hosted plane); an explicit config honors the live plane. `governA2aSend` gates in-process agent-to-agent sends. Python frameworks (LangGraph, CrewAI, Pydantic AI, ADK, AutoGen, smolagents) use the `shield-kya` shim (`sdks/kya-python/`), which delegates to the local kya CLI. Support matrix and recipes: `docs/sdk-integrations.md`; runnable scripts: `examples/sdk/`.

## Claude connector

**Desktop / Claude Code (local stdio):**

```bash
# Prefer a preinstalled package (no registry auto-install):
npx --no-install @shield-agent/kya@0.23.0 serve-mcp --stdio
# Or after npm i -g / local install:
kya serve-mcp --stdio
```

Copy `claude/claude_desktop_config.example.json` into Claude Desktop MCP settings, or use `.mcp.json` for Claude Code. Pack a Desktop extension with `npx @anthropic-ai/mcpb pack` (see `manifest.json`). That pack runs the packed `dist/cli.js`, not `npx -y`.

**Claude.ai / Cowork (hosted):** add a custom connector at `https://shield-agent.com/mcp` with request header `Authorization: Bearer <KYA_API_KEY>` (or `X-API-Key`). It is not Directory-listed yet (API-key auth, no OAuth DCR).

## OpenAI (Codex / Responses)

**Codex CLI / IDE:** copy `openai/codex.config.example.toml` into `~/.codex/config.toml`. Local stdio uses `npx --no-install @shield-agent/kya@0.23.0 serve-mcp --stdio`. Hosted Codex uses `url = "https://shield-agent.com/mcp"` with `bearer_token_env_var = "KYA_API_KEY"`.

**Responses API:** see `openai/responses-mcp.example.json` (`server_url` + `Authorization: Bearer <KYA_API_KEY>`).

**ChatGPT Apps (chatgpt.com):** deferred. Developer Mode wants OAuth. Use Codex until then.

## Gemini CLI

Merge `gemini/settings.example.json` (stdio) or `gemini/settings.hosted.example.json` (`httpUrl` + Bearer) into `~/.gemini/settings.json` or `.gemini/settings.json`. Do not enable both at once.

## Grok

**Grok CLI (local):** `kya connect grok` appends a `[mcp_servers.shield-kya]` table to `~/.grok/config.toml` (`serve-mcp --stdio`, keyless offline sample evaluate). In a running session, press `r` in `/mcps` to refresh.

**grok.com (hosted):** custom connector at `https://shield-agent.com/mcp` (see `grok/README.md`). Grok rejects localhost. Prefer a Bearer machine key when the UI offers a request header.

## More hosts

Each ships a copy-paste example in its own directory; `kya connect <host>` writes the same thing for the starred ones. Full recipes (verify, uninstall, troubleshooting): [docs/hosts/](docs/hosts/).

| Host | Setup | Example |
|------|-------|---------|
| Claude Code | `kya connect claude` (or `kya start`) | - (merges `~/.claude.json` / `.mcp.json`) |
| Grok CLI | `kya connect grok` | - (appends `[mcp_servers.shield-kya]` to `~/.grok/config.toml`) |
| OpenCode | `kya connect opencode` | `opencode/opencode.example.json` |
| Kilo Code | `kya connect kilo` | `kilo/kilo.example.json` |
| Kiro | `kya connect kiro` | `kiro/mcp.example.json` |
| Qwen Code | `kya connect qwen` | `qwen/settings.example.json` (+ `settings.hosted.example.json`) |
| Kimi Code | `kya connect kimi` | `kimi/mcp.example.json` |
| MastraCode | `kya connect mastracode` | `mastracode/mcp.example.json` |
| Amp | `kya connect amp` | `amp/settings.example.json` |
| GitHub Copilot CLI | `kya connect copilot` | `copilot/mcp-config.example.json` |
| Cline | copy into VS Code globalStorage | `cline/cline_mcp_settings.example.json` |
| Droid | `droid mcp add` (schema unverified) | `droid/mcp.example.json` |
| Pi · OMP · Devin · Hermes · Qoder · Maki · Muse · Antigravity | `kya wrap --offline -- <cmd>` | [docs/hosts/](docs/hosts/) |

## Cursor plugin

The package includes `.cursor-plugin/plugin.json`, `mcp.json`, and a wrap skill. Public listing repo: https://github.com/The-Pixel-Boys/shield-kya

## ORR (reporting only)

```bash
npx @shield-agent/kya orr run --path . --out ./orr-report --skip-optional-producers
npx @shield-agent/kya orr run --path . --out ./orr-report --scorecard ./scorecard.json --producer openssf.scorecard
npx @shield-agent/kya orr run --path . --out ./orr-report --producer harness.agentshield --agentshield-json ./agentshield-report.json
```

ORR is a reporting board. Scanners, `--scorecard`, and `harness.agentshield` are evidence. They never ALLOW a high-stakes side effect, so they are not a second policy gate. AgentShield is optional and read-only: no `--fix`, no MiniClaw, no runtime hook. This package does not depend on `ecc-agentshield`. If you pass `--producer harness.agentshield` and have neither `--agentshield-json` nor an `agentshield` binary, ORR records a coverage gap and still exits 0. Explicit `--producer` always attempts; `--skip-optional-producers` only skips producers you did not ask for.

## Certify (continuous agent assurance)

`kya certify` evaluates the open **Agent Trust Baseline** catalog (`catalog/agent-trust-baseline-v0.json` - 30 requirements across Data & Privacy, Security, Safety, Reliability, Accountability, Society) against local evidence: the global trail, ORR output, wired hosts, sandbox inventory, receipts, showback, and your recorded attestations. It writes a gap report to `.kya/certify/` (JSON + Markdown + HTML). The gap list is your work plan. The receipt report shows the same state live: a **Certify** panel recomputed on every render (so `kya start`'s live report updates as events stream in), plus a dedicated **Certify** tab with the full live requirement table - run `kya certify` for the full gap report + signed evidence bundle.

```bash
npx @shield-agent/kya certify                  # gap report; exit 1 when gaps exist (CI-friendly)
npx @shield-agent/kya certify --open           # open the HTML report
npx @shield-agent/kya certify --fail-on never  # report only, always exit 0
npx @shield-agent/kya certify --attest SOC-01 --text "Acceptable-use policy: https://example.com/aup"
npx @shield-agent/kya certify --sign           # also emit a signed evidence-bundle.json
```

Certify is **evidence-only**. It never ALLOWs, DENYs, or blocks anything - the sole PEP remains Shield KYA. Trail-based machine checks never pass on an empty trail (they report `insufficient_evidence`). What a machine cannot check is covered by explicit local attestations (`--attest`), recorded in `.kya/attestations.json` - unverified operator statements, labeled as such.

`--sign` emits `evidence-bundle.json`: canonical JSON, ed25519-signed by a locally generated key (`~/.kya/keys/evidence-ed25519.json`, mode 0600, auto-created on first use). Each `--sign` run prints the signing key fingerprint; when the key was just created the CLI notes that key continuity resets there (earlier bundles stay verifiable only under the old pubkey). A self-signed developer key proves bundle **integrity** and **continuity of a key** - **not identity**. Identity binding and the verified badge are the hosted verification product (separate). The bundle format is open and documented in `docs/certify.md`; anyone can verify a bundle offline with the embedded pubkey.

`kya certify` is local, free, and offline: no account, no network calls, no license check (it never sends usage stats). The catalog is MIT-licensed and PRs are welcome. An EU AI Act crosswalk (baseline requirements mapped to Articles 9-15, 26, 72) ships in [docs/certify-eu-ai-act.md](docs/certify-eu-ai-act.md) and `src/certify/eu-ai-act-map.json`.

## Import traces (LangSmith, Langfuse, Phoenix, OTel)

Bring existing observability exports into the trail so the receipt and certify see them:

```bash
kya import --from langsmith ./runs.json
kya import --from langfuse ./observations.jsonl
kya import --from otel ./otraces.json
```

Imports land as observe-mode events (`host: import`, `reasonCode: IMPORTED`, error runs become `DENY`/`IMPORTED_ERROR`), with latency and token counts mapped when the source carries them. Files over 50MB are refused; malformed records are skipped, never fatal.

## Investigate (detections + fix briefs)

`kya investigate` runs deterministic local detectors over the trail - no LLM calls: PII leaks in summaries, DENY spikes, approval retry loops, repeated never-event attempts, unknown tools under hold, slow tools. Findings group into incidents, and each incident renders a markdown fix brief shaped to paste into Claude Code / Cursor / Codex.

```bash
kya investigate           # summary: counts by severity + top incidents
kya investigate --json    # findings + incidents + briefs, machine-readable
```

## Alert webhooks (verdict routing)

Route DENY / REQUIRE_APPROVE events to Slack, Linear, Jira, or any webhook. Config lives in `.kya/config.json` (project) or `~/.kya/config.json` (global):

```json
{
  "notify": {
    "webhooks": [
      { "url": "https://hooks.slack.com/services/...", "template": "slack", "events": ["DENY", "REQUIRE_APPROVE"] },
      { "url": "https://example.invalid/jira", "template": "jira", "events": ["DENY"] }
    ]
  }
}
```

`KYA_NOTIFY_WEBHOOK=<url>` is the zero-config variant (generic payload). Delivery retries with exponential backoff (250ms/1s/4s + jitter), per-attempt timeouts, a per-URL circuit breaker, and a send rate limiter; payloads are built only from redacted trail fields, with an automatic minimized fallback if the secret scan trips. From short-lived hook/wrap spawns delivery rides a detached helper (`kya notify-flush`), so the gate path never waits on the network.

## Optional sandbox wrap (Firecracker)

Beside the gate, not inside MCP. Opt-in only:

```bash
KYA_SANDBOX=mock kya sandbox spawn
KYA_SANDBOX=mock kya sandbox exec --sandbox-id <id> --cmd "true"
KYA_SANDBOX=mock kya sandbox kill --sandbox-id <id>
```

`org.sample.sandbox.exec` without `--sandbox-id` is **DENY** `MISSING_SANDBOX_ID`. Real Firecracker needs `firecracker` + `jailer` on PATH and kernel/rootfs env (`KYA_SANDBOX_KERNEL`, `KYA_SANDBOX_ROOTFS`). We do not ship those binaries. `serve-mcp` still exposes only evaluate / ingest / request_approval.

## Cost showback (observe only)

`kya orr run --usage ./usage.json` (or `.kya/usage.json`) adds a showback section: tokens and estimated USD by agent and run. Subagents nest under `parentRunId`. That section is not a billing meter and not a policy gate. Hosted metrics show the same rollup when usage is ingested with a session. Trail events that carry host-reported token counts (hook payloads with a `usage` object, imported traces) are preferred over the static per-event estimate, and the report states how many window events had real usage.

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
- [Per-host recipes (23 hosts)](docs/hosts/)
- [Top-20 MCP server support matrix (taxonomy + gate recipes)](docs/mcp-servers.md)
- [OTLP metrics (OSS + hosted)](docs/otlp.md)
- [Anonymous usage stats (opt-in): what is sent, controls, retention](docs/telemetry.md)
- [OWASP MCP governance map](docs/owasp-mcp-governance.md)
- [kya certify - Agent Trust Baseline gap reports](docs/certify.md)
- [EU AI Act crosswalk for the Agent Trust Baseline](docs/certify-eu-ai-act.md)
- [Works with your observability stack](docs/marketing/observability-stack.md)
- [SDK & framework integrations (in-process shims)](docs/sdk-integrations.md)
- [Hosted operator SSO / SCIM (not in OSS CLI)](docs/hosted-operator-sso.md)
- See also `LIMITATIONS.md` in this repo

## Anonymous usage stats (opt-in, off by default)

The first time you run `kya start`, `kya init` or `kya connect` in a terminal, KYA asks once whether to share anonymous usage stats (`[y/N]`, the default is No). Only an explicit `y` or `yes` turns it on. Nothing is sent in CI, in non-interactive runs, with `--json`, or when `DO_NOT_TRACK=1` / `KYA_TELEMETRY=0` is set. `kya hook` itself never touches the network; when you opted in it starts a detached helper at most once a day that sends one `ping`, so hook-only installs still count as active.

```bash
kya telemetry show        # the exact payload, field by field
kya telemetry status      # on / off / not asked, and what overrides it
kya telemetry off --purge # turn off and erase what the server holds for this install
```

Full details, the payload, retention and how to self-host the endpoint: [docs/telemetry.md](docs/telemetry.md).

## OTLP (optional)

Opt-in. Default off.

**OSS CLI:** set `KYA_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) to export thin evaluate latency (`kya.client.evaluate.latency`) with tags `verdict` and `host` only. No tool args or API keys.

**Verdict span export:** set `KYA_OTLP_EXPORT_ENDPOINT` (or `"otlpExport": { "endpoint": ... }` in `.kya/config.json`) to emit every verdict as an OTLP/JSON GenAI span (`gen_ai.tool.name`, `kya.verdict`, `kya.reason_code`, token attributes when known) to any OTLP/HTTP backend. Long-lived processes (MCP gate, gateway) export every verdict; hook/wrap spawns export DENY / REQUIRE_APPROVE via the detached `notify-flush` helper. Plaintext http is accepted for loopback only unless `"insecure": true`.

**Hosted plane:** richer Micrometer gauges and timers when `KYA_OTLP_ENABLED=true`.

Full env, Grafana/Datadog notes, forbid list, and a Collector sample: [`docs/otlp.md`](docs/otlp.md).
