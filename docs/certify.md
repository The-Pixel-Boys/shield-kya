# kya certify — Agent Trust Baseline gap reports

`kya certify` answers one question with local data: **which requirements of the
Agent Trust Baseline does this machine's agent setup currently meet, and which
have gaps?** It is evidence-only — never a policy decision point, never a
certificate. The sole PEP remains Shield KYA.

## Quick start

```bash
npm i -g @shield-agent/kya   # or npx
kya start                    # wire the gate into your host (one-time)
kya certify                  # gap report → .kya/certify/{report.json,report.md,report.html}
kya certify --open           # view the HTML report
```

Exit codes: `0` no gaps · `1` gaps (default `--fail-on gap`, CI-friendly) ·
`2` usage error. `--fail-on never` always exits 0. Fail-closed: with
`--fail-on gap`, a run where every requirement is `insufficient_evidence`
(zero certifiable evidence) also exits `1`, even though it has zero gap
rows — see "Overall result" below.

## Flags

| flag | default | meaning |
|---|---|---|
| `--window <n>` | 30 | report window in days (1–366); trail stats and the bundle digest cover this window |
| `--catalog <path>` | bundled v0 | evaluate a custom catalog JSON (same schema, validated) |
| `--out <dir>` | `.kya/certify` | output directory (resolved against cwd) |
| `--format json,md,html` | all three | artifact formats to write |
| `--json-stdout` | off | print the full report JSON to stdout (implies nothing else changes) |
| `--open` | off | open `report.html` in the browser (`KYA_NO_BROWSER=1` disables) |
| `--quiet` | off | suppress the summary (files are still written) |
| `--fail-on gap\|never` | gap | exit 1 when any requirement is a gap |
| `--sign` | off | additionally write a signed `evidence-bundle.json` |
| `--attest REQ-ID --text "…"` | — | record a local attestation, then re-run the report |

## Requirement statuses

| status | meaning |
|---|---|
| `pass` | machine check found satisfying evidence |
| `gap` | machine check found contradicting evidence, or an attest requirement has no attestation |
| `insufficient_evidence` | the evidence source is absent (empty trail window, no ORR report) — never counted as pass |
| `attested` | an operator attestation is recorded (unverified statement) |

## The catalog

`catalog/agent-trust-baseline-v0.json` (shipped in the npm package) is the
source of truth: 30 requirements across 6 domains, each with a `severity` and
one machine `check` (12 kinds) or an `attest` escape hatch. Schema:

```json
{
  "id": "agent-trust-baseline",
  "version": "0.1.0",
  "updated": "2026-09-18",
  "domains": ["data-privacy", "security", "safety", "reliability", "accountability", "society"],
  "requirements": [
    { "id": "DP-01", "domain": "data-privacy", "title": "…", "text": "…",
      "severity": "critical|high|medium|low",
      "check": { "kind": "…" } }
  ]
}
```

Check kinds v0: `config_mode` (`not:"observe"`), `hooks_wired` (`min`),
`trail_zero` / `trail_min` / `trail_ratio` (`windowDays`, `match`
{`verdict`, `reasonCode`, `mode`, `neverEvent`}, plus `min` or `maxRatio`),
`orr_overall` / `orr_category` (`max:"green"|"amber"`), `orr_fresh`
(`maxAgeDays`), `sandbox_inventory` (`min`), `receipts_present` (`min`),
`showback_present`, `attest` (`prompt`). Trail checks read the merged trail:
the global `~/.kya/trail.jsonl` merged with the legacy per-project
`.kya/trail.jsonl` (pre-0.3.0 location, still honored on read). An empty
evidence window yields `insufficient_evidence`, never a vacuous pass.

The gate mode for `config_mode` resolves through the **same resolver the
gate itself uses** (`resolveGateMode` in `src/config.ts`), so a certify
"pass" is never a paper claim: flags (`--offline` / `--hold`) > env
(`KYA_OFFLINE=1` → offline, `KYA_HOLD=1` → hold) > `"gateMode"` in
`.kya/config.json` (honored only when exactly `"hold"` or `"offline"` — any
other value is ignored) > `observe` default. Setting
`{"gateMode": "hold"}` in `.kya/config.json` genuinely puts wrap / hook /
eval into hold mode, not just the report.

## Overall result

`overall.result` is fail-closed: `gap` whenever any requirement is a gap;
else `pass` when at least one requirement passed **or is attested**
(attestations count toward the result); else `gap` — a run with zero
certifiable evidence (everything `insufficient_evidence`) never headlines
as pass, so `--fail-on gap` exits `1` for it even with zero gap rows.

## Attestations

```bash
kya certify --attest SOC-01 --text "Acceptable-use policy: https://example.com/aup"
```

Recorded in `.kya/attestations.json` (latest per requirement wins), attached
to subsequent reports, and included in signed bundles. Attestations are
**unverified operator statements** — they are labeled as such in every
artifact. Secret-shaped text is refused.

## Signed evidence bundles (`--sign`)

`kya certify --sign` writes `.kya/certify/evidence-bundle.json`:

```json
{
  "format": "shield-kya-evidence-bundle",
  "version": 1,
  "generatedAt": "ISO-8601 UTC",
  "agent": { "agentId?": "string", "agentName?": "string", "host?": "ide|runtime", "product?": "string" },
  "catalog": { "id": "agent-trust-baseline", "version": "0.1.0" },
  "window": { "days": 30, "since": "ISO", "until": "ISO" },
  "trail": { "eventCount": 0, "digest": "sha256 hex of canonicalJson(events-in-window array)",
             "verdictMix": { "ALLOW": 0, "DENY": 0, "REQUIRE_APPROVE": 0 },
             "modes": { "observe": 0, "hold": 0, "offline": 0 } },
  "requirements": [ { "id": "DP-01", "domain": "data-privacy",
      "status": "pass|gap|insufficient_evidence|attested",
      "evidence": "one line, redacted",
      "attestation?": { "text": "…", "at": "ISO" } } ],
  "overall": { "pass": 0, "gap": 0, "insufficientEvidence": 0, "attested": 0, "result": "pass|gap" },
  "pubkey": "base64url(SPKI DER ed25519)",
  "sig": "base64url( ed25519_sign( canonicalJson(bundle without sig and pubkey fields) ) )"
}
```

canonicalJson semantics: UTF-8, no insignificant whitespace, object keys
sorted recursively in UTF-16 code-unit order (JavaScript's default string
sort — not Unicode codepoint order), arrays in order, shortest round-trip
numbers, minimal string escaping — exactly `canonicalJson` in `src/hash.ts`.

**Key management:** the signing key lives at
`~/.kya/keys/evidence-ed25519.json` (mode 0600), auto-generated on first
`--sign`. Fingerprint = first 16 hex chars of `sha256(SPKI DER)`. Rotate by
deleting the file (old bundles stay verifiable only with the old pubkey).
Every `--sign` run prints the signing key fingerprint; when the key was just
created the CLI flags it (`new key created, continuity resets here`) —
previous bundles remain verifiable only under the old pubkey.

**Trust model — read this before relying on a bundle:** the key is
self-signed and local. A valid signature proves the bundle was produced by
someone holding this key and was not modified (integrity), and repeat
bundles with the same `pubkey` prove continuity of a key across time. It
proves **nothing about identity**: anyone can generate a key and sign a
bundle. Identity binding (this key belongs to this agent/org) is the hosted
verification product; the format above is the open, documented seam for it.
Third parties can verify integrity offline today with the embedded `pubkey`.

**Privacy:** the bundle contains requirement results, counts, and a sha256
digest of the window's trail events — never raw tool arguments, diffs, or
secrets. `baseUrl` is never exported.

## Live report panel

The receipt report (`kya receipt`, and the live daemon from `kya start`) carries a **Certify** panel that recomputes the baseline evaluation on every render — result pill, counts, top-5 gaps. It is the same engine and the same honesty rules as `kya certify` (fail-closed on zero certifiable evidence), evaluated in memory with no files written. Static exports show a snapshot; the live daemon updates it as trail events stream in.

## CI

```yaml
- run: npx @shield-agent/kya certify --quiet        # exit 1 fails the job on gaps
- run: npx @shield-agent/kya certify --fail-on never --json-stdout > certify.json
```
