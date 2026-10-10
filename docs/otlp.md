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

## Exporting KYA verdicts as spans

The OSS CLI can also **export** each gate verdict as one OTLP/JSON span (POST to `{endpoint}/v1/traces`), so verdicts show up in Langfuse, Datadog, Honeycomb, or any OTel Collector next to your agent's own GenAI traces. Default is **off**: no endpoint configured means a pure no-op. Export is fire-and-forget: it never blocks, delays, or changes a verdict, and every failure is swallowed (counted in-memory via `otlpExportStats` and persisted to `~/.kya/otel-stats.json`, which powers the report's OTel export panel).

Configure in `.kya/config.json` under the `otlpExport` key:

```json
{
  "otlpExport": {
    "endpoint": "http://127.0.0.1:4318",
    "headers": { "Authorization": "Bearer <token>" },
    "insecure": false
  }
}
```

- `endpoint` - OTLP/HTTP base URL (`/v1/traces` is appended if missing). Env override: `KYA_OTLP_EXPORT_ENDPOINT`.
- `headers` - optional auth headers. Prefer putting secrets on the Collector, not in the file.
- `insecure` - plaintext `http://` is accepted for loopback only; set `true` to allow http to a remote host. `https://` always works.

Span shape: one span per verdict, `service.name=shield-kya-cli`, name `kya.verdict <toolId>`, attributes following the OTel GenAI semantic conventions:

| Attribute | Value |
|-----------|-------|
| `gen_ai.tool.name` | gated tool id (`<target>__<tool>`) |
| `kya.verdict` | `ALLOW` / `REQUIRE_APPROVE` / `DENY` |
| `kya.reason_code` | e.g. `ALLOW`, `POLICY_DENY` |
| `kya.mode` | `observe` / `hold` / `offline` |
| `kya.host` | `ide` / `runtime` |
| `kya.session_id` | gate session id |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | only when the caller knows them |

`DENY` spans carry OTLP status `ERROR` with the reason code as the message; other verdicts are `OK`.

Collector snippet: add a traces pipeline to [`otel-collector-kya.yaml`](./otel-collector-kya.yaml):

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/grafana, datadog]
```

## Forbidden attributes

Do not tag or export: tool args, prompts/completions, emails, phones, IPs, approval payload bodies, raw `merchant_id` / high-cardinality `tool_id` on metrics. The verdict exporter ships only the attributes in the table above.

## Related (hosted monorepo only)

Operators with the private monorepo also have longer runbooks under `docs/ops/kya-otlp-grafana.md`, `docs/ops/kya-otlp-datadog.md`, and `docs/ops/grafana/kya-overview.json`. This package ships the public, self-contained copy above so npm / GitHub OSS readers are not blocked.
