# Alerts, sandbox and cost showback

Alert webhooks, security alerts, the optional sandbox wrap and cost showback. Moved out of the package README. Back to the [README](../README.md).

## Alert webhooks (decision routing)

Route DENY / REQUIRE_APPROVE events to Slack, Microsoft Teams, Linear, Jira, or any webhook. Config lives in `.kya/config.json` (project) or `~/.kya/config.json` (global):

```json
{
  "notify": {
    "webhooks": [
      { "url": "https://hooks.slack.com/services/...", "template": "slack", "events": ["DENY", "REQUIRE_APPROVE"] },
      { "url": "https://<env>.environment.api.powerplatform.com:443/powerautomate/...", "template": "teams", "events": ["DENY"] },
      { "url": "https://example.invalid/jira", "template": "jira", "events": ["DENY"] }
    ]
  }
}
```

Every Slack message ends with a line that says a Slack reaction or reply is not an approval. The hosted plane can also post new approval requests to Slack (Approvals > Slack notify in the console); that message only links to the console and has no approve button.

The `teams` template sends one Adaptive Card to a Teams Workflows webhook (in Teams: channel, Workflows, "Send webhook alerts to a channel", copy the webhook link). The card has no buttons and ends with a line that says a Teams reaction or reply is not an approval. Event text loses the characters that Teams uses for links, mentions and Markdown. The workflow URL holds a signature, so keep it secret; the notify log stores the host only. The hosted plane can also post new approval requests to Teams (Approvals > Teams notify in the console).

`KYA_NOTIFY_WEBHOOK=<url>` is the zero-config variant (generic payload). Delivery retries with exponential backoff (250ms/1s/4s + jitter), per-attempt timeouts, a per-URL circuit breaker (stops sending to a target that keeps failing), and a send rate limiter. Payloads are built only from redacted record fields, with an automatic minimized fallback if the secret scan finds something. From short-lived hook/wrap spawns, a detached helper (`kya notify-flush`) sends the webhooks, so the gate path never waits on the network. Every delivery attempt is appended to `~/.kya/notify-log.jsonl` (target host only, never the full URL; capped at the last 500 entries), and the report's System tab shows an **Alerts** panel with per-target delivered/failed counts and the last attempt.

## Security alerts

`kya` can alert you when its detectors find an incident, for example a never-list tool that an agent tries again and again. The fixed detectors decide that it is an incident. An optional local model (about 150 MB plus a local runtime of about 100 MB, fully offline after one download, advisory) adds a category, an urgency and a next step. Alerts are **off by default** and **advisory**: they never block a tool call, and the model never removes an alert.

`kya start` asks once, in a terminal: `Turn on security alerts? [Y/n]`. Yes installs the local runtime and model, turns alerts on and sends one test alert (desktop notification and webhooks). No is remembered and never asked again; turn it on later with `KYA_ALERTS=on kya start`. `KYA_ALERTS=off` never asks. Without a terminal `kya start` asks nothing and prints nothing about alerts; `kya doctor` prints the "alerts are off" line. If the install fails, `kya start` still works and alerts use the detector severity only. To turn alerts off: `kya alerts off` (or `KYA_ALERTS=off`). Each new incident also shows a desktop notification (fixed text, no agent text); turn it off with `"alerts": {"desktop": false}`.

```bash
kya alerts on        # write alerts.enabled to ~/.kya/config.json (no model download)
kya alerts status    # setting, severity floor, desktop, triage model, receivers, last 10 alerts (--json for scripts)
kya alerts test      # send one synthetic incident, marked as a test, to the desktop and to each receiver
kya alerts off
```

The alert goes to every webhook in `notify.webhooks` of `~/.kya/config.json` whose `events` list holds `"incident.opened"` (or that has no `events` list). It uses the same templates, retries, circuit breaker and rate limit as the decision alerts. The live report also lists the incidents that alerted, with the triage. The `triage` object holds `model`, `category`, `urgency` and `action` (each `{id, p}`) and `benign` (the probability that the incident is harmless); the model cannot change the severity or remove an alert, and a missing model means no `triage` object. Settings (user level only, a repo config cannot change them): `{"alerts": {"enabled": true, "minSeverity": "high", "windowMinutes": 120, "desktop": true}}`. `KYA_ALERTS=on|off` overrides `enabled`. See [docs/alerts.md](alerts.md).

## Optional sandbox wrap (Firecracker, OpenShell)

Beside the gate, not inside MCP. Opt-in only:

```bash
KYA_SANDBOX=mock kya sandbox spawn
KYA_SANDBOX=mock kya sandbox exec --sandbox-id <id> --cmd "true"
KYA_SANDBOX=mock kya sandbox kill --sandbox-id <id>
```

`org.sample.sandbox.exec` without `--sandbox-id` is **DENY** `MISSING_SANDBOX_ID`. Real Firecracker needs `firecracker` + `jailer` on PATH and kernel/rootfs env (`KYA_SANDBOX_KERNEL`, `KYA_SANDBOX_ROOTFS`). We do not ship those binaries. `KYA_SANDBOX=openshell` drives [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) through the `openshell` CLI and needs `openshell` plus `docker` or `podman` on PATH; KYA renders an OpenShell policy per spawn, pins a minimum CLI version, and always sets `OPENSHELL_TELEMETRY_ENABLED=false`. See [docs/sandbox.md](sandbox.md) for backend details. `serve-mcp` still exposes only evaluate / ingest / request_approval.

## Cost showback (observe only)

`kya orr run --usage ./usage.json` (or `.kya/usage.json`) adds a showback section: tokens and estimated USD by agent and run. Subagents nest under `parentRunId`. That section is not a billing meter and not a policy gate. Hosted metrics show the same rollup when usage is ingested with a session. Events in the record that carry host-reported token counts (hook payloads with a `usage` object, imported traces) are used before the static per-event estimate, and the report states how many window events had real usage.
