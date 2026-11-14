# Compliance and evidence

ORR, Certify, trace import and investigation. Moved out of the package README. Back to the [README](../README.md).

## ORR (reporting only)

```bash
npx @shield-agent/kya orr run --path . --out ./orr-report --skip-optional-producers
npx @shield-agent/kya orr run --path . --out ./orr-report --scorecard ./scorecard.json --producer openssf.scorecard
npx @shield-agent/kya orr run --path . --out ./orr-report --producer harness.agentshield --agentshield-json ./agentshield-report.json
```

ORR checks if your agent setup is safe to run. It is a reporting board only. Scanners, `--scorecard`, and `harness.agentshield` are evidence. They never ALLOW a high-stakes side effect, so they are not a second policy gate. AgentShield is optional and read-only: no `--fix`, no MiniClaw, no runtime hook. This package does not depend on `ecc-agentshield`. If you pass `--producer harness.agentshield` and have neither `--agentshield-json` nor an `agentshield` binary, ORR records a coverage gap and still exits 0. Explicit `--producer` always attempts; `--skip-optional-producers` only skips producers you did not ask for.

## Certify (ongoing trust checks)

`kya certify` evaluates the open **Agent Trust Baseline** catalog (`catalog/agent-trust-baseline-v0.json`: 31 requirements across Data & Privacy, Security, Safety, Reliability, Accountability, Society) against local evidence: the global record, ORR output, wired hosts, sandbox inventory, receipts, showback, and your recorded attestations. It writes a gap report to `.kya/certify/` (JSON + Markdown + HTML). The gap list is your work plan. The receipt report shows the same state live: a **Certify** panel recomputed on every render (so `kya start`'s live report updates as events stream in), plus a dedicated **Certify** tab with the full live requirement table. Run `kya certify` for the full gap report plus a signed evidence bundle.

```bash
npx @shield-agent/kya certify                  # gap report; exit 1 when gaps exist (CI-friendly)
npx @shield-agent/kya certify --open           # open the HTML report
npx @shield-agent/kya certify --fail-on never  # report only, always exit 0
npx @shield-agent/kya certify --attest SOC-01 --text "Acceptable-use policy: https://example.com/aup"
npx @shield-agent/kya certify --sign           # also emit a signed evidence-bundle.json
```

Certify is **evidence-only**. It never ALLOWs, DENYs, or blocks anything. The sole PEP (policy enforcement point: the component that can block a call) remains Shield KYA. Record-based machine checks never pass on an empty record (they report `insufficient_evidence`). What a machine cannot check is covered by explicit local attestations (`--attest`), recorded in `.kya/attestations.json`. These are unverified operator statements, labeled as such.

`--sign` emits `evidence-bundle.json`: canonical JSON, ed25519-signed (a public-key signature) by a locally generated key (`~/.kya/keys/evidence-ed25519.json`, mode 0600, auto-created on first use). Each `--sign` run prints the signing key fingerprint. When the key was just created, the CLI notes that key continuity resets there (earlier bundles stay verifiable only under the old pubkey). A self-signed developer key proves bundle **integrity** and **continuity of a key**, **not identity**. Bundles from `--sign` verify offline. On the public verify endpoint (`POST /api/v1/kya/evidence/verify`) and badge, they show a grey `self-signed` badge. Only a bundle signed with the key of an active hosted workspace earns the green Shield Verified badge. That ties the badge to a hosted account. It does not prove the legal identity of the company or the agent. The bundle format is open and documented in `docs/certify.md`; anyone can verify a bundle offline with the embedded pubkey.

`kya certify` is local, free, and offline: no account, no network calls, no license check (it never sends usage stats). The catalog is MIT-licensed and PRs are welcome. An EU AI Act crosswalk (baseline requirements mapped to Articles 9-15, 26, 72) ships in [docs/certify-eu-ai-act.md](certify-eu-ai-act.md) and `src/certify/eu-ai-act-map.json`.

## Import traces (LangSmith, Langfuse, Phoenix, OTel, AGT, ADR Sensor, OpenShell)

Bring existing monitoring exports into the record so the receipt and certify see them:

```bash
kya import --from langsmith ./runs.json
kya import --from langfuse ./observations.jsonl
kya import --from otel ./otraces.json
kya import --from agt   # Microsoft Agent Governance Toolkit audit log
kya import --from adr-sensor ./adr-sensor-events.jsonl
kya import --from openshell ./openshell-events.jsonl
```

The AGT importer verifies AGT's hash chain (a checksum link between log rows), flags tampered logs with chainVerified=false, and never duplicates rows on re-import; see [docs/import-agt.md](import-agt.md). ADR Sensor events map one `AgentEvent` to one or more KYA events, with stable `uuid` dedup on re-import; see [docs/import-adr-sensor.md](import-adr-sensor.md). OpenShell OCSF logs map one log line to one KYA event, with stable `uid` dedup on re-import; see [docs/import-openshell.md](import-openshell.md). AGT's hash chain is unkeyed (it has no secret key), so "verified" means internally consistent, not authentic. The hosted console accepts the same formats ([docs/import-agt-hosted.md](import-agt-hosted.md)).

Imports land as observe-mode events (`host: import`, `reasonCode: IMPORTED`, error runs become `DENY`/`IMPORTED_ERROR`), with latency and token counts mapped when the source carries them. Files over 50MB are refused. Broken records are skipped; they never stop the import. The report (`kya start` / `kya receipt`) shows an **Import** card with per-format counts, error count, and the latest imported event once any import has landed.

## Investigate (detections + fix briefs)

`kya investigate` runs fixed local detectors over the record, with no LLM calls: PII leaks in summaries, DENY spikes, approval retry loops, repeated never-event attempts, unknown tools under hold, slow tools. Findings group into incidents. Each incident renders a Markdown fix brief shaped to paste into Claude Code, Cursor, or Codex. Every run also saves a compact summary to `~/.kya/investigate-last.json`, which the report renders as an **Investigations** card (findings by severity with detector ids, plus the top fix brief).

```bash
kya investigate           # summary: counts by severity + top incidents
kya investigate --json    # findings + incidents + briefs, machine-readable
```
