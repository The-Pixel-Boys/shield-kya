# What is open source and what is hosted

The KYA client (`@shield-agent/kya`) is MIT licensed. It runs locally by default: no account and no API key. The only default network call is a daily version check after `kya start` (see [Network calls](#network-calls)). The hosted service at shield-agent.com is a separate product. It needs an account and an API key, and you opt in to it by configuration.

This page lists which is which, so you can decide what you need.

## Runs locally in the open source client

| Feature | Notes |
|---|---|
| Offline policy evaluate | Built-in sample evaluator plus the never-list. No network. |
| Never-list | A tool on a known MCP server whose name contains `drop`, `truncate`, `purge` or `transfer` is denied locally. The sample never tool is denied too. By default the hooks block only the never-list. Shell commands such as `rm -rf` are recorded, not blocked. |
| Advisory hooks for supported hosts | Claude Code, Codex, Gemini CLI, Grok, Kimi Code and the GitHub Copilot CLI plugin. Every tool call is recorded. Hooks fail open: if kya breaks or times out, the call goes ahead. The Copilot plugin records MCP calls but does not block never-list MCP calls. |
| Local trail | `~/.kya/trail.jsonl`. Reports read the newest 1 MB of it. |
| `kya certify` | Local report against the Agent Trust Baseline. "pass" means local evidence shows no gap. It is not a certification by a third party. See [certify.md](certify.md). |
| Receipts and `--share` | `kya receipt` is an offline HTML report. `--share` publishes a redacted summary (see below). |
| Discovery | `kya discover` scans your own machine. `--push` is the only part that talks to a hosted console. See [discovery.md](discovery.md). |
| Importers | AGT, ADR Sensor and OpenShell logs. See [import-agt.md](import-agt.md). |
| `kya wrap` | Puts the evaluate gate in front of any CLI. |
| MCP gateway | `kya gate` on loopback. Observe mode records calls. The deny set is the only hard stop. See [mcp-servers.md](mcp-servers.md). |
| Usage stats | Opt-in and off by default. See [telemetry.md](telemetry.md). |

## Needs the hosted service (account and API key)

| Feature | Notes |
|---|---|
| Hosted policy evaluate | Your workspace policy decides, not the built-in sample evaluator. |
| Session ingest | Sessions and events are sent to your workspace. |
| Human approvals | A Review verdict waits for a person in your workspace. |
| Approval and policy events | Signed webhooks for pending, approved, rejected and expired approvals (expired only when the workspace sets an approval TTL), DENY and REQUIRE_APPROVE verdicts and incidents. The workspace also lists them for 30 days (`GET /api/v1/kya/events`) for clients without a public HTTPS URL, such as a local n8n. Receiving an event approves nothing. The local `notify.webhooks` alerts above are separate. |
| Workspace and team features | Shared console, agents, seats. |
| Operator SSO and SCIM | Hosted only. See [hosted-operator-sso.md](hosted-operator-sso.md). |
| Fail-closed hosted hook mode (beta) | When the workspace cannot answer, the call is denied. See [hosted-hook.md](hosted-hook.md). |
| Plan limits | Caps on agents, seats and trail visibility depend on your plan. |

The short version: the open source client is advisory and fails open, apart from the never-list. Enforcement lives on the MCP gate path and on the hosted service, and the hosted service fails closed.

## Signatures and the verified badge, plainly

`kya certify --sign` writes `evidence-bundle.json`. It is signed with a key generated on your machine (`~/.kya/keys/evidence-ed25519.json`).

- A valid signature shows the bundle was not changed after signing.
- Bundles signed with the same key show key continuity over time.
- It does **not** show who you are. Anyone can create a key and sign a bundle.
- Anyone can verify a bundle offline, using the public key embedded in it.

No hosted verify page exists. The public verify endpoint (`POST /api/v1/kya/evidence/verify`) and the badge endpoints (`GET /api/v1/kya/badge/{fingerprint}.svg` and `.json`) show the result of the latest signed bundle submitted for a signing key. The badge has these states:

- Green `shield verified`: the result is pass and the bundle was signed with the key of an active hosted workspace.
- Amber `N gaps`: the same kind of key, but the bundle reports gaps.
- Grey `self-signed`: any other key, including every key made by the CLI, whatever the result.
- Grey `stale`: the newest bundle is older than 7 days.

Green ties the badge to a hosted account. It does not check the legal identity of the company or the agent, and it is not a third-party audit or a statement by Shield Agent about them.

Attestations in `.kya/attestations.json` are statements by the operator, recorded locally and not verified. See [certify.md](certify.md) and [LIMITATIONS.md](../LIMITATIONS.md).

## Network calls

| When | What is sent |
|---|---|
| Default | Evaluate, hooks, trail, certify and receipts are local and send nothing. |
| `kya start` (human output) | Checks npm (`registry.npmjs.org`) for a newer version, at most once a day. `KYA_UPDATE_CHECK=0` or `--no-update-check` turns it off. CI and `--json` skip it. |
| `kya gate setup` | Downloads the pinned gateway binary from our releases (`kya start` does this only when it finds MCP servers to govern). No other default command downloads anything. |
| Usage stats, if you said yes | A small anonymous heartbeat. `kya telemetry show` prints the exact payload. Never paths, prompts, tool arguments or keys. |
| `kya receipt --share` | A redacted summary (verdict counts, rollups, Certify status) goes to a public, anonymous endpoint and you get a public link that expires after 7 days. The endpoint is rate limited. No paths, tool arguments or session IDs are included. The Certify status on the page is labelled as self-reported. |
| Alert webhooks and OTLP export, if you configure them | `notify.webhooks` and `otlpExport` in `.kya/config.json` (or `KYA_NOTIFY_WEBHOOK` and `KYA_OTLP_EXPORT_ENDPOINT`) send redacted events to the URLs you set. `KYA_OTLP_ENDPOINT` exports evaluate latency metrics. See [otlp.md](otlp.md). |
| `KYA_BASE_URL` and an API key are set | Hosted calls: evaluate, ingest, approvals, and `discover --push`. Only these configured commands call your workspace. |

## Names and license

The MIT license covers the code. The names "Shield Agent" and "KYA" and the logo are not licensed by it.
