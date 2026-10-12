# Datadog and Grafana dashboards (community)

Two importable dashboards and three Datadog monitor templates for the OTLP data Shield KYA already exports. They are community dashboards kept in this repo. They are **not** an official Datadog integration, Marketplace tile, or Grafana plugin.

| File | What it is |
|------|------------|
| [`integrations/datadog/kya-dashboard.json`](../integrations/datadog/kya-dashboard.json) | Datadog dashboard (ordered layout, template variables `service`, `env`, `hosted_service`) |
| [`integrations/datadog/monitors.json`](../integrations/datadog/monitors.json) | Three monitor bodies: DENY spike, never-list hit, no verdict spans for 30 minutes |
| [`integrations/grafana/kya-dashboard.json`](../integrations/grafana/kya-dashboard.json) | Grafana dashboard (`schemaVersion` 42, Grafana 12.3 or newer) with `${DS_TEMPO}` and `${DS_PROMETHEUS}` import inputs |
| [`integrations/otlp-fields.json`](../integrations/otlp-fields.json) | Every span attribute and metric name the dashboards may use, read from the emitting code |

The files are not in the npm package. Take them from the GitHub repo; they are in the public repo from the first release that includes them.

## What the panels read

The verdict-span and connected-mode names below were captured from a real `kya` run (see [How the field list is checked](#how-the-field-list-is-checked)). The hosted-only names were not captured: they are read from the hosted plane source.

**Verdict spans** (`service.name=shield-kya-cli`, one span per verdict, see [otlp.md](./otlp.md#exporting-kya-verdicts-as-spans)):

- DENY, REQUIRE_APPROVE, never-list hits (`kya.reason_code=NEVER_EVENT`)
- Gate failures: `PLANE_UNREACHABLE` and `PLANE_AUTH_REJECTED` (MCP gate could not reach or authenticate to the hosted plane; recorded as DENY) and `FAIL_CLOSED` (opt-in fail-closed hook hit an internal error)
- Verdicts over time by `kya.verdict`
- Top deny reasons by `kya.reason_code`
- Tool calls by tool (`gen_ai.tool.name`, top 10)
- Verdicts by gate host (`kya.host`: `ide` or `runtime`) and mode (`kya.mode`: `observe`, `hold`, `offline`)

**Connected mode only**: the `kya.client.evaluate.latency` histogram, tagged `verdict` and `host`. Panels: verdict mix and evaluate latency p50 / p95. It is recorded only when the CLI calls the hosted plane evaluate API with `KYA_OTLP_ENDPOINT` set, and the CLI exports metrics every 15 seconds without a flush on exit. In practice that means a connected, long-lived MCP gate or gateway. Hooks always evaluate offline and never emit it; offline and keyless gates never emit it either.

**Hosted only** (hosted plane with `KYA_OTLP_ENABLED=true`): verdict counters (`kya.policy.deny`, `kya.policy.require_approve`, `kya.policy.approve_granted`, `kya.evaluate.count`), evaluate latency (`kya.evaluate.latency`, `kya.evaluate.max_ms`), kill latency against its SLO (`kya.kill.last_ms`, `kya.kill.slo_ms`), and PII redaction hits (`kya.redaction.hits`). These names come from the hosted plane source. They are not in the captured fixture.

## Send KYA data to Datadog

Run a Datadog Agent with OTLP ingest, or an OpenTelemetry Collector with the `datadog` exporter, on the same host. Keep `DD_API_KEY` on the Agent or Collector, not in the KYA process. The sample Collector config is [`otel-collector-kya.yaml`](./otel-collector-kya.yaml).

```bash
# Verdict spans (OSS CLI). Long-lived MCP gate / gateway exports every verdict.
export KYA_OTLP_EXPORT_ENDPOINT=http://127.0.0.1:4318
# Evaluate-latency metric (OSS CLI, connected mode only).
export KYA_OTLP_ENDPOINT=http://127.0.0.1:4318
```

`.kya/config.json` works too: `{ "otlpExport": { "endpoint": "http://127.0.0.1:4318" } }`. For the hosted plane, see [otlp.md, Hosted plane](./otlp.md#hosted-plane).

Import the dashboard with `POST /api/v1/dashboard` and the file as the body, or create an empty dashboard and use **Configure > Import dashboard JSON** (this overwrites that dashboard). Create each entry of `monitors.json` with `POST /api/v1/monitor`, one body per call. Add your notification handle to each `message` first.

Datadog setup the dashboard needs:

1. **A custom APM retention filter on `service:shield-kya-cli`.** Span widgets and `trace-analytics` monitors only see indexed spans. Datadog states that Analytics monitors evaluate only spans kept by custom retention filters, not the intelligent retention filter.
2. **Facets** for `@kya.verdict`, `@kya.reason_code`, `@kya.host`, `@kya.mode` and `@gen_ai.tool.name` are recommended so they show in the Trace Explorer facet panel and group-by pickers (Datadog facets doc below).
3. **Delta temporality is not available from the CLI.** The CLI histogram is cumulative. Datadog converts cumulative histograms to distributions from the second point onward and recommends delta, so the first export after a CLI start is not counted.
4. **Percentiles on the distribution** `kya.client.evaluate.latency` must be enabled in the metric settings for the p50 / p95 panel.
5. The `env` template variable only filters when your Agent or Collector adds an `env` tag (KYA does not set `deployment.environment`).

## Send KYA data to Grafana

The Grafana dashboard reads spans from **Tempo** with TraceQL and metrics from **Prometheus** (or Mimir / Grafana Cloud) with PromQL. Point the same env vars at an OpenTelemetry Collector or Grafana Alloy that forwards traces to Tempo and metrics to Prometheus:

```bash
export KYA_OTLP_EXPORT_ENDPOINT=http://127.0.0.1:4318   # spans -> Tempo
export KYA_OTLP_ENDPOINT=http://127.0.0.1:4318          # metric -> Prometheus (connected mode only)
```

Import: **Dashboards > New > Import**, upload `grafana/kya-dashboard.json`, then pick your Tempo and Prometheus data sources for the `DS_TEMPO` and `DS_PROMETHEUS` inputs. The `service` variable defaults to `shield-kya-cli`, and `hosted_job` defaults to `shield-agent` (the hosted plane's `spring.application.name`).

Grafana setup the dashboard needs:

1. **Tempo 2.8 or newer with TraceQL metrics enabled** (the `local-blocks` processor). Every span panel uses `count_over_time()`, and the top-N panels use `topk(10)`, which older Tempo versions reject.
2. **Prometheus naming.** The PromQL assumes the Prometheus OTLP receiver default, `UnderscoreEscapingWithSuffixes`: dots become underscores, unit `ms` adds `_milliseconds`, histograms get `_bucket` / `_sum` / `_count`, and `service.name` becomes the `job` label. So `kya.client.evaluate.latency` is queried as `kya_client_evaluate_latency_milliseconds_bucket{job="shield-kya-cli"}`. Grafana Cloud and the Collector / Alloy Prometheus exporters add these suffixes. Self-hosted Mimir's OTLP endpoint drops unit suffixes by default (`otel_metric_suffixes_enabled` is false), so the latency and evaluate-count panels come back empty there: route OTLP through a Collector or Alloy, enable `otel_metric_suffixes_enabled`, or remove `_milliseconds` from those queries. If your pipeline keeps UTF-8 names, adjust the queries too.

## Honest limits

- **ALLOW is undercounted from hook-based gates.** Hook and wrap gates (for example Claude Code hooks) export only DENY and REQUIRE_APPROVE spans. Only the long-lived MCP gate or gateway exports ALLOW. A hook-only setup will look close to 100% deny or review. The connected-mode metric does not fix this: it also needs a long-lived connected gate.
- **No hold or approval latency panel.** KYA does not export approval wait time over OTLP today. Verdict spans have zero duration.
- **No export-failure or fail-open panel.** Failed exports are counted only in local `~/.kya/otel-stats.json`, not sent anywhere. A default hook that fails open lets the call through without a span, so fail-open events are invisible here; only opt-in fail-closed hooks emit `FAIL_CLOSED`.
- **Do not group `kya.client.evaluate.latency` or the hosted `kya.evaluate.latency` by `host` in Datadog.** Both carry a `host` attribute (`ide` / `runtime`) that becomes a tag on Datadog's reserved `host` key, which normally names the reporting machine. The dashboard never groups by it, and the validator rejects a Datadog metric query that does.
- **The silence monitor** only makes sense with the MCP gate or gateway. With hooks only, 30 quiet minutes can just mean no denies.
- **Not tested in a live Datadog or Grafana instance.** The files follow the vendors' published JSON schemas and are checked by `scripts/validate-dashboards.mjs`. Import has not been tried against a real Datadog org or Grafana server.

## How the field list is checked

`pnpm test` runs `test/dashboards.test.ts`, which:

1. parses every file and checks the required top-level keys for each format;
2. rejects unscoped TraceQL attributes (`.kya.verdict`), Datadog span facets without `@`, and hard-coded values (verdicts, modes, hosts, the reason codes the panels filter on) that KYA does not emit;
3. extracts every span attribute and metric name from the Datadog, TraceQL and PromQL queries and fails if one is not in `integrations/otlp-fields.json`;
4. checks that `otlp-fields.json` matches the attribute keys in `src/otel/exporter.ts` and the histogram in `src/otel.ts`;
5. checks that every OSS name a dashboard uses appears in `test/fixtures/otlp-capture.json`. That fixture holds the OTLP/JSON bodies a real `kya serve-mcp --stdio` run sent to a local receiver: ALLOW, REQUIRE_APPROVE, a never-list DENY for `postgres__drop_table`, a `PLANE_UNREACHABLE` DENY, and the evaluate-latency metric.

Run it alone with `node scripts/validate-dashboards.mjs`.

## Sources

- Datadog dashboard JSON: https://docs.datadoghq.com/api/latest/dashboards/create-a-new-dashboard
- Datadog monitor JSON and types: https://docs.datadoghq.com/api/latest/monitors/create-a-monitor
- Datadog APM monitors and retention filters: https://docs.datadoghq.com/monitors/types/apm
- Datadog dashboard JSON import (Configure menu): https://docs.datadoghq.com/dashboards/configure
- Datadog span facets: https://docs.datadoghq.com/tracing/trace_explorer/facets
- Datadog OTLP metric mapping: https://docs.datadoghq.com/metrics/open_telemetry/otlp_metric_types
- Grafana dashboard JSON model: https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/view-dashboard-json-model/
- Tempo TraceQL metrics: https://grafana.com/docs/tempo/latest/metrics-from-traces/metrics-queries/
- Prometheus OTLP naming: https://prometheus.io/docs/guides/opentelemetry/
