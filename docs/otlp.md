# OTLP metrics (optional)

Opt-in OpenTelemetry metrics for Shield KYA. Default is **off**. Export never includes tool args, prompts, emails, approval bodies, or API keys.

Two surfaces, deliberately different:

| Surface | What ships | How you turn it on |
|---------|------------|--------------------|
| **OSS CLI** (`@shield-agent/kya`) | Thin: one histogram `kya.client.evaluate.latency` with tags `verdict`, `host` | Set `KYA_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` |
| **Hosted plane** (shield-agent.com / self-hosted Java) | Rich: Micrometer gauges and timers (policy decisions, evaluate latency, kill SLO, redaction, LLM) | `KYA_OTLP_ENABLED=true` plus an OTLP metrics endpoint |

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

## Exporting KYA decisions as spans

The OSS CLI can also **export** each gate decision as one OTLP/JSON span (POST to `{endpoint}/v1/traces`), so decisions show up in Langfuse, Datadog, Honeycomb, or any OTel Collector next to your agent's own GenAI traces. Default is **off**: no endpoint configured means a pure no-op. Export is fire-and-forget (send and do not wait): it never blocks, delays, or changes a decision. Every failure is swallowed (counted in memory via `otlpExportStats` and saved to `~/.kya/otel-stats.json`, which powers the report's OTel export panel).

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

- `endpoint`: OTLP/HTTP base URL (`/v1/traces` is appended if missing). Env override: `KYA_OTLP_EXPORT_ENDPOINT`.
- `headers`: optional auth headers. Prefer putting secrets on the Collector, not in the file.
- `insecure`: plaintext `http://` is accepted for loopback only; set `true` to allow http to a remote host. `https://` always works.

Span shape: one span per decision, `service.name=shield-kya-cli`, name `kya.verdict <toolId>`, attributes following the OTel GenAI semantic conventions:

| Attribute | Value |
|-----------|-------|
| `gen_ai.tool.name` | gated tool id (`<target>__<tool>`) |
| `kya.verdict` | `ALLOW` / `REQUIRE_APPROVE` / `DENY` |
| `kya.reason_code` | e.g. `ALLOW`, `POLICY_DENY` |
| `kya.mode` | `observe` / `hold` / `offline` |
| `kya.host` | `ide` / `runtime` |
| `kya.session_id` | gate session id; with map attributes on, the salted session hash (see below) |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | only when the caller knows them |
| `kya.target.class` | only with map attributes on: the target class, such as `command:git` or `secret:ssh-key` |
| `kya.device` | only with map attributes on: the hashed device id (16 hex characters) |

`DENY` spans carry OTLP status `ERROR` with the reason code as the message; other decisions are `OK`.

Which decisions are sent: the hook and wrap paths send only `DENY` and `REQUIRE_APPROVE` spans. The MCP gate (`kya serve-mcp`, stdio or HTTP) sends every decision. The map (`kya map`) and the agent-flow export (`kya export`) read the local trail, which holds every recorded decision. They send nothing.

### Map attributes (optional)

Default is **off**. When off, the span is the same, byte for byte, as without this option. To turn it on, put `"mapAttrs": true` and the endpoint under `otlpExport` in `.kya/config.json` in your account home folder:

```json
{ "otlpExport": { "endpoint": "https://collector.example.com", "mapAttrs": true } }
```

Only that file turns it on. A cloned repo can set env (in `.claude/settings.json` or `.mcp.json`) and commit a project `.kya/config.json`. So KYA finds and checks the file like this:

- The home folder comes from the operating system account (`os.userInfo().homedir`). `HOME`, `KYA_HOME` and `XDG_*` do not change it. `KYA_HOME` still moves the trail and the other config, but not this opt-in.
- The file must not be inside the project folder of the call, also not through a symlink. This stops a repo that is checked out in your home folder (a dotfiles repo) from committing the file. The working folder does not matter, so the hosted hook, which runs from your home folder, can use the opt-in.
- When KYA does not know the project folder of the call, the opt-in is off.
- The file must not be a hard link (its link count must be 1), so no file in a project can share it.
- The file must belong to you, and the group and other users must not have write permission (for example mode 600 or 644). We recommend mode 600: run `chmod 600 ~/.kya/config.json`. When a group or other user can write to the file, KYA ignores the opt-in and prints nothing at export time. `kya doctor` prints one line on stderr that says why the opt-in is ignored. On Windows the mode and owner checks do not run.
- KYA opens the file one time, without following a symlink at that step, and does the owner, mode and link checks again on the open file. A file that is changed after the checks is not read.
- A dotfiles repo that tracks `~/.kya/config.json` gives you your own file. KYA accepts it when the owner, mode and link checks pass and the project folder of the call does not contain it. When the agent works in the dotfiles repo checked out at your home folder, the file is inside the project, so KYA refuses it.
- When the file is a symlink, it must point to a file inside your home folder.
- The endpoint, headers and `insecure` flag for these spans come from that same file. When `KYA_OTLP_EXPORT_ENDPOINT` is set, or a project `.kya/config.json` sets another endpoint, the attributes are off.
- `mapAttrs` in a project `.kya/config.json` is ignored. No env variable turns it on.

If one check fails, spans go out without the map attributes, as before. When your project folder is your home folder, the file is inside the project, so the attributes are off.

Each span then also carries:

- `kya.target.class`: the target class from the trail row. It is a class, such as `command:git`, `secret:ssh-key` or `network:example.com`. A project class goes out as `project` only: the project folder name stays on this machine. It is never a raw path, an argument, command text, a URL path or a query string. A class with an unexpected shape, or longer than 128 characters, is not sent.
- `kya.device`: the first 16 hex characters of a salted hash. The salt stays on this machine and is never sent. The id holds no host name, user name or address.
- `kya.session_id` changes: it is the session hash that `kya map` and `kya export` use (16 hex characters, salted with the salt that stays on this machine), not the raw host session id. When the salt cannot be read, the span has no `kya.session_id`.

Dashboards and alerts keyed on the raw `kya.session_id` keep working only while the opt-in is off. When you turn it on, the same session gets a different value. Use the hash from `kya export` or `kya map --json` to join spans to the map.

A class can name a network host name or a command name. Turn the option on only when your collector may store those names. The self-test span (`otlpExportSelfTest`) never carries the map attributes. Older trail rows have no class, so their spans have no `kya.target.class`.

Collector snippet: add a traces pipeline to [`otel-collector-kya.yaml`](./otel-collector-kya.yaml):

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/grafana, datadog]
```

Ready-made community dashboards for these spans and metrics (Datadog dashboard and monitors, Grafana dashboard): [dashboards.md](./dashboards.md).

For Splunk, a community app (source types, field names and a dashboard, no inputs and no credentials) reads the verdict spans from the Collector `splunk_hec` exporter or the local trail file: [integrations/splunk](../integrations/splunk/shield_kya/README.md).

## Forbidden attributes

Do not tag or export: tool args, prompts/completions, emails, phones, IPs, approval payload bodies, raw `merchant_id` / high-cardinality `tool_id` on metrics. The decision exporter ships only the attributes in the table above. `kya.session_id` is the session id as the host gives it, not a hash, unless the map attributes are on.

## Related (hosted monorepo only)

Operators with the private monorepo also have longer runbooks under `docs/ops/kya-otlp-grafana.md`, `docs/ops/kya-otlp-datadog.md`, and `docs/ops/grafana/kya-overview.json`. This package ships the public, self-contained copy above so npm / GitHub OSS readers are not blocked.
