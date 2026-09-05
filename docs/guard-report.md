# Optional guard report ingest

Power-user / CI only. Not listed in `kya --help`. The public command surface stays `kya`.

You can attach a JSON or SARIF guard report to an ORR run as **evidence**. Findings never ALLOW a write. Trust scores (if present) are observe-only.

```bash
npx @shield-agent/kya orr run --path . --out ./orr-report \
  --producer harness.guard_report \
  --guard-json ./guard-report.json
```

Accepted shapes: `{ "findings": [ ... ] }`, `{ "issues": [ ... ] }`, or SARIF 2.1 `runs[].results[]`.

Producer id: `harness.guard_report`.
