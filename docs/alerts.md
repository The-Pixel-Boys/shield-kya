# Security alerts (incident alerts, optional local triage model)

`kya` can send an alert when it detects a security incident on this machine. The fixed detectors of `kya investigate` decide that something is an incident. An optional small local model adds a triage: the kind of incident, how fast a person must look, and the next step. Nothing leaves the machine except the alert to the webhooks that you set.

**Off by default.** The alert is advisory. It shows what the detectors found. It does not prevent anything and never blocks a tool call. The model is advisory too: it never decides whether an alert is sent.

## Turn it on

`kya start` asks once, in a terminal, after the plain-language search question:

```text
Security alerts (optional).
KYA tells you when it detects a security incident: a destructive change, secret access, data exfiltration or repeated denies.
A small local model adds a category, an urgency and a next step to each alert. It runs fully offline after one download: about 150 MB for the model and about 100 MB for a local runtime. Nothing leaves this machine.
Alerts are advisory: local KYA never blocks because of them.
Turn on security alerts? [Y/n]
```

- **Yes** (or Enter): installs the runtime and downloads the model once, turns `alerts.enabled` on in `~/.kya/config.json`, and sends one test alert (a desktop notification and every webhook that receives incidents).
- **No**: remembered in `~/.kya/alerts-choice.json`. `kya start` never asks again. It prints `Turn it on later: KYA_ALERTS=on kya start`.
- `KYA_ALERTS=on kya start` installs without asking (scripts, images). `KYA_ALERTS=off` never asks.
- Without a terminal `kya start` asks nothing and prints one hint line.
- If the install fails, `kya start` still works. It prints the manual command, and alerts are on with the detector severity only. Run `KYA_ALERTS=on kya start` later to add the model.
- `kya alerts on` (no download) turns alerts on without the model. `kya alerts status` shows whether the model is installed.

## The local triage model

| | |
|---|---|
| Model | `kya-triage-v1`: ModernBERT-base (Apache 2.0), fine-tuned with four heads, int8 ONNX |
| Download | one file, about 150 MB (at most 200 MB), from `https://models.shield-agent.com/triage-model-v1/kya-triage-v1.bin` (a public Cloudflare R2 bucket). The URL and the sha256 are pinned in the code. Rules: https only, that one host only, redirects are never followed (a redirect is a failure), the server must send a Content-Length of at most 200 MB, and the transfer stops at 200 MB. The bytes are hashed while they are written to a temp file next to the target. Only a file with the pinned sha256 is moved into place (atomic). A file with another hash, or any failed download, is removed. Time limits: 10 seconds to the first answer, 60 seconds of silence. No environment variable or option changes the URL. `KYA_TRIAGE_MODEL_PATH` only points at a model file you already have. |
| Runtime | `onnxruntime-node@1.30.0`, installed with `npm install --prefix ~/.kya/triage`. Other platforms' binaries are removed after the install. It is not a dependency of `@shield-agent/kya`. |
| Network | only the one download from `models.shield-agent.com` (port 443). After it the model runs fully offline: the file is not fetched again. No network at hook time or at triage time. |
| Speed | about 65 ms per incident on an 8-core laptop (Apple M1, 4 threads; 82 ms at the 90th percentile), after a model load of about 1.1 seconds. The model loads in the detached `kya notify-flush` helper or in the report, only when an alert is new, and is released after the scan. The hook never loads it. |
| Input | the same redacted text the hosted triage sees: detector ids, severity, counts, reason codes, never-list rule ids, target classes, tool ids and up to 5 short redacted summaries. No raw arguments, paths or session ids. |
| Output | `category`, `urgency`, `action` and `benign`, each with a calibrated probability, and the model id. Shown in the alert body (`incident.triage`), in the report list of incident alerts and in the Slack, Teams, Linear and Jira text. |

### The triage fields

The model fills one `triage` object in the alert. It is absent when the model is not installed, fails or is too slow.

```json
{
  "kind": "kya.incident.opened",
  "event": "incident.opened",
  "incident": {
    "severity": "high",
    "detectorIds": ["never-repeat"],
    "triage": {
      "model": "kya-triage-v1",
      "category": { "id": "policy-evasion", "p": 0.91 },
      "urgency": { "id": "within-hour", "p": 0.84 },
      "action": { "id": "review-session", "p": 0.88 },
      "benign": 0.04
    }
  }
}
```

| Field | Meaning |
|---|---|
| `model` | The model id (`kya-triage-v1`). |
| `category` | `id` is one of `destructive-change`, `credential-access`, `data-exfiltration`, `privilege-change`, `policy-evasion`, `supply-chain`, `prompt-injection-driven`, `benign-noise`. `p` is the probability of that answer (0 to 1, 3 decimals). |
| `urgency` | `id` is one of `page-now`, `within-hour`, `daily-digest`, `ignore`. `p` as above. |
| `action` | `id` is one of `stop-agent`, `review-session`, `rotate-secret`, `tighten-policy`, `none`. `p` as above. |
| `benign` | The probability that the incident is harmless (0 to 1). |

The other alert fields (`severity`, `detectorIds`, `counts`, `summaries`, `fix`, `advisory`) come from the detectors, not from the model. The model cannot change them. The local model has one fixed calibration: there is no `confident` flag, no threshold and no feedback. The hosted service has all three. See [oss-vs-hosted.md](oss-vs-hosted.md).

Quality, measured on 47 held-out synthetic incidents (not used for training or tuning, but made from the same label rules as the training data): category 0.91, urgency 0.91, next step 0.94 and harmless-or-not 1.00 accuracy. This is a small synthetic set. It does not say how the model does on your real incidents. Treat the triage as a hint.

Rules the model cannot change:

1. A never-list hit or a `critical` detector result always alerts, whatever the model says. The model adds text; it never removes an alert and never changes the severity.
2. Model missing, broken or slow (8 seconds): the alert goes out with the detector severity and no triage.
3. A text that an agent wrote can reach the model only as a clipped, redacted summary after the structured fields.

## Desktop notification

With alerts on, each new incident alert also shows a desktop notification: macOS (`osascript`), Linux (`notify-send`, when installed), Windows (a PowerShell toast). The text is fixed: the title "KYA security alert", the severity and the detector ids. No summary, tool name, path or session id is shown. The text is passed to the program as arguments (no shell string). On Windows the same text goes through two environment variables of the PowerShell process. One scan shows at most 3 notifications.

Turn it off with `"alerts": { "desktop": false }` in `~/.kya/config.json` or `KYA_ALERTS_DESKTOP=off`.

## What triggers an alert

The detectors read the trail events of the last `windowMinutes` (default 120). They read only your user-level trail (`~/.kya/trail.jsonl` and its archive). A trail file inside a project folder is never read, because a cloned repo can ship a forged one. Events with a time that does not parse, or that is more than 5 minutes in the future, are ignored. Findings group into incidents. An incident sends an alert when its severity is at or above `minSeverity` (default `high`).

| Detector | Severity | Trigger |
|---|---|---|
| `never-repeat` | high | A never-list tool was tried more than once. |
| `pii-in-summary` | high or critical | A real email, card number or token is in a trail summary (email and card are critical). |
| `deny-spike` | medium | More than 3 DENY events on one tool in 10 minutes. |
| `approval-loop` | medium | 3 or more held calls in a row on one tool. |
| `unknown-tool-hold`, `slow-calls` | low | Only with `minSeverity` set to `low`. |

An incident alerts once. It alerts again only when its severity rises, or when a new occurrence starts after the last alerted one ended. More events in the same incident do not alert again. `~/.kya/alerts-state.json` keeps the last 500 alerts for this check. A failed delivery is tried again after one minute, at most 3 times in total.

## When the check runs

- After a DENY or REQUIRE_APPROVE, the detached `kya notify-flush` helper runs the check. The hook never waits for it and a failure never changes the verdict.
- The live report (`kya start`) runs the check when the trail changes, at most once a minute.

## Commands

```bash
kya alerts on         # write alerts.enabled to ~/.kya/config.json
kya alerts off
kya alerts status     # setting, floor, desktop, triage model, receivers (host only), last 10 alerts. --json for scripts.
kya alerts test       # one synthetic incident, marked [TEST], to the desktop and to each receiver. Exit 1 on a failure.
```

## Configuration

Alert settings come from the user-level `~/.kya/config.json` only. A `.kya/config.json` inside a repo cannot turn alerts off, change the floor or add a receiver.

```json
{
  "alerts": { "enabled": true, "minSeverity": "high", "windowMinutes": 120, "desktop": true },
  "notify": {
    "webhooks": [
      { "url": "https://hooks.slack.com/services/...", "template": "slack", "events": ["incident.opened"] }
    ]
  }
}
```

- `minSeverity`: `low`, `medium`, `high` (default) or `critical`.
- `desktop`: `false` turns off the desktop notification (default `true`). `KYA_ALERTS_DESKTOP=off` does the same for the process.
- `KYA_ALERTS=on|off` overrides `alerts.enabled` for the process.
- A webhook gets incidents when its `events` list holds `incident.opened`, or when it has no `events` list. A webhook with `"events": ["DENY"]` gets no incidents. A webhook with `"events": ["incident.opened"]` gets no DENY alerts.
- `KYA_NOTIFY_WEBHOOK` stays a decision-alert webhook. It gets no incidents.
- With alerts on and no receiver, the incident only shows in the live report ("Incident alerts" on the overview).
- Templates: `slack`, `teams`, `linear`, `jira`, `generic`. The generic body has `"kind": "kya.incident.opened"` and `"event": "incident.opened"`.
- Delivery uses the same retries, circuit breaker and 20-per-minute limit as the decision alerts. Each attempt is logged in `~/.kya/notify-log.jsonl` (host only).

## Privacy

The alert body holds: a title, the severity, the detector ids, the counts of findings and verdicts, the first and last time, up to 3 short redacted summaries, up to 3 tool ids, the first step of the suggested fix, the local triage (when the model is installed) and the line "Local KYA is advisory."

The alert body never holds raw arguments, argument hashes, target paths, diff previews, project folders, session ids, device ids or home folders. Summaries pass the same redaction as the trail, home folders become `~`, and the body is scanned for secrets before it is sent. If the scan finds one, a minimal body (title, severity and the test mark) is sent instead. Text that an agent wrote cannot make a mention or a link in the receiver: Slack text escapes `&`, `<` and `>`, Teams text uses the same cleaning as decision alerts, and Linear and Jira text escapes link, mention and macro characters. In all of them, bare URLs and domains in agent text are broken (`https: //evil . example`), so no receiver turns them into a link.
