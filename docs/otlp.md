# OTLP metrics (optional)

Opt-in OpenTelemetry metrics for Shield KYA. Default is **off**. Export never includes tool args, prompts, emails, approval bodies, or API keys.

Two surfaces, deliberately different:

| Surface | What ships | How you turn it on |
|---------|------------|--------------------|
| **OSS CLI** (`@shield-agent/kya`) | Thin: one histogram `kya.client.evaluate.latency` with tags `verdict`, `host` | Set `KYA_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` |
| **Hosted plane** (shield-agent.com / self-hosted Java) | Rich: Micrometer gauges and timers (policy verdicts, evaluate latency, kill SLO, redaction, LLM) | `KYA_OTLP_ENABLED=true` plus an OTLP metrics endpoint |

Prefer an OpenTelemetry Collector (or Grafana Alloy / Datadog Agent) in front of the vendor. Keep auth headers on the Collector, not in the app process or in git.

## OSS CLI

```bash
export KYA_OTLP_ENDPOINT=http://127.0.0.1:4318
# optional explicit metrics URL:
# export KYA_OTLP_METRICS_ENDPOINT=http://127.0.0.1:4318/v1/metrics
# optional headers (comma-separated key=value):
# export KYA_OTLP_HEADERS=Authorization=Bearer <token>
```

Standard OpenTelemetry env names also work (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`).

When enabled, `evaluatePolicy` records `kya.client.evaluate.latency` (ms). Service name is `shield-kya-cli`.

Sample Collector: [`otel-collector-kya.yaml`](./otel-collector-kya.yaml).

## Hosted plane

```bash
export KYA_OTLP_ENABLED=true
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://collector:4318/v1/metrics
# or OTEL_EXPORTER_OTLP_ENDPOINT
export KYA_OTLP_STEP=30s
```

Actuator on the public web port stays `health,info`. Do not expose `/actuator/prometheus` publicly.

### Grafana Cloud

Point the Collector at your Grafana OTLP gateway. Put Basic auth on the Collector.

```bash
export KYA_OTLP_ENABLED=true
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp/v1/metrics
# Prefer Collector headers over app headers in production.
```

### Datadog

Use OTLP into the Datadog Agent or Collector. Do **not** add `dd-trace` into the policy engine classpath for convenience.

```bash
export KYA_OTLP_ENABLED=true
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otlp.datadoghq.com/v1/metrics
# Prefer DD_API_KEY on the Collector/Agent.
```

EU sites use the matching Datadog host (`datadoghq.eu`, etc.).

## Forbidden attributes

Do not tag or export: tool args, prompts/completions, emails, phones, IPs, approval payload bodies, raw `merchant_id` / high-cardinality `tool_id` on metrics.

## Related (hosted monorepo only)

Operators with the private monorepo also have longer runbooks under `docs/ops/kya-otlp-grafana.md`, `docs/ops/kya-otlp-datadog.md`, and `docs/ops/grafana/kya-overview.json`. This package ships the public, self-contained copy above so npm / GitHub OSS readers are not blocked.
