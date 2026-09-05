# AgentSeal beside Shield KYA (optional)

[AgentSeal](https://github.com/getagentseal/agentseal) is a separate security scanner for prompts, MCP configs, and skill files. Shield can **ingest** its JSON or SARIF as ORR evidence. AgentSeal never becomes the policy engine.

**Install AgentSeal yourself** (`pip install agentseal` or `npm install -g agentseal`). `@shield-agent/kya` does not vendor it. AgentSeal is licensed **FSL-1.1-Apache-2.0** (not Apache until its change date). Do not redistribute AgentSeal as a Shield product.

## What we use

| AgentSeal command | In Shield |
|-------------------|-----------|
| `guard` | Optional ORR spawn (`agentseal guard --output json`) or ingest a saved report |
| `scan-mcp` | Operator runs it; pass the report with `--agentseal-json` |
| `scan` (prompt probes) | Same: save JSON, ingest. Needs an LLM on your side |
| `shield` (file watcher) | Not integrated. Name collision with Shield Agent; keep it on your laptop only |

## CLI

```bash
# 1) Run AgentSeal (examples)
agentseal guard --output json > agentseal-report.json
agentseal scan-mcp --sse http://127.0.0.1:8787/sse --output json > agentseal-mcp.json

# 2) Ingest as evidence (no AgentSeal binary required for this step)
npx @shield-agent/kya orr run --path . --out ./orr-report \
  --producer harness.agentseal \
  --agentseal-json ./agentseal-report.json
```

If you pass `--producer harness.agentseal` without `--agentseal-json`, the CLI may try `agentseal guard` on `PATH`. Missing binary → coverage gap finding, not a crash, and never ALLOW.

## Rules

- Findings are **evidence only**. Trust scores do not authorize writes.
- High-severity MCP poisoning may raise risk in your process; it must not weaken `DENY` or `REQUIRE_APPROVE`.
- Shield stays the sole PEP (`ALLOW` / `DENY` / `REQUIRE_APPROVE`).

## CI sketch

```yaml
- run: agentseal guard --output json > agentseal-report.json
  continue-on-error: true
- run: npx @shield-agent/kya orr run --path . --out orr-report --producer harness.agentseal --agentseal-json agentseal-report.json --skip-optional-producers
```

Producer id: `harness.agentseal`.

## Demo media

Real Terminal capture (not AI-generated): `docs/media/kya-0.1.24-agentseal-orr-terminal.png` and a short clip derived from that frame: `docs/media/kya-0.1.24-agentseal-orr-demo.mp4`. Transcript: `docs/media/agentseal-orr-demo.txt`.
