# Shield KYA App

Shield KYA is an open source tool that records what AI coding agents and tool-using agents do, and checks each tool call against a local policy. This app gives Splunk two source types, normalized field names and one dashboard for the KYA verdicts: verdicts over time, top deny reasons, never-list hits, gate failures, tool calls by tool, verdicts by gate host and mode, and verdicts by MCP server.

The app has no scripted inputs, no Python code and stores no credentials. It is a community app from MFR Limited. It is not a Splunk-built app.

- App version: 0.1.0
- Splunk Enterprise: written for 9.x and 10.x (Simple XML dashboard version 1.1). See "Tests" below for what was tested.
- License: MIT (see `LICENSE`)
- Source and issues: https://github.com/The-Pixel-Boys/shield-kya

## What the app contains

| File | Content |
|---|---|
| `default/props.conf` | Source types `shield:kya:trail` and `shield:kya:verdict`, and the normalized fields |
| `default/transforms.conf` | Search-time extractions `kya_mcp_server` and `kya_host` (trail) |
| `default/macros.conf` | `shield_kya_index` (default `index=main`) and `shield_kya_events` |
| `default/data/ui/views/shield_kya_verdicts.xml` | The dashboard |

Normalized fields, the same for both source types: `kya_verdict`, `kya_reason_code`, `kya_tool`, `kya_mode`, `kya_host`, `kya_session_id`, `kya_mcp_server`.

## Install

Use only one of the two ways below for the same machines. If you use both, the dashboard counts each verdict two times.


1. Install the app on the search head (Apps > Manage Apps > Install app from file). On a distributed deployment, install it on the indexers or heavy forwarders too, so the line and time settings of `shield:kya:trail` apply at index time.
2. Send data in one of the two ways below.
3. If your data goes to an index other than `main`, change the `shield_kya_index` macro (Settings > Advanced search > Search macros).

### Way 1: verdict spans through an OpenTelemetry Collector (HEC)

1. Create an HEC token in Splunk Web: Settings > Data inputs > HTTP Event Collector > New Token. Set the source type to `shield:kya:verdict` and the index you use. The app does not contain an HEC input, because Splunk Cloud does not allow `[http://...]` stanzas in apps (AppInspect check `check_inputs_conf_for_http_inputs`).
2. Run an OpenTelemetry Collector with the `splunk_hec` exporter. Keep the token on the Collector, not in the KYA process:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
exporters:
  splunk_hec:
    token: "${env:SPLUNK_HEC_TOKEN}"
    endpoint: "https://splunk.example.com:8088/services/collector"
    sourcetype: "shield:kya:verdict"
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [splunk_hec]
```

3. Point KYA at the Collector: `export KYA_OTLP_EXPORT_ENDPOINT=http://127.0.0.1:4318`.

Each verdict becomes one event. The span attributes are under `attributes` (for example `attributes.kya.verdict`). The resource attributes, such as `service.name`, are indexed fields. The Collector `splunk_hec` exporter marks traces as beta.

### Way 2: the local trail file (Universal Forwarder)

The kya CLI writes every verdict to `~/.kya/trail.jsonl` on the machine where it runs. Monitor that file with a Universal Forwarder. Use the full path of the user's home folder:

```ini
[monitor:///home/<user>/.kya/trail.jsonl]
sourcetype = shield:kya:trail
index = main
```

You can also send trail lines to the HEC raw endpoint (`/services/collector/raw?sourcetype=shield:kya:trail`). Do not use the HEC event endpoint for the trail: that endpoint does not apply the line and time settings.

## Limits

- Hook-based gates (for example Claude Code hooks) export only DENY and REQUIRE_APPROVE spans. Only the long-lived MCP gate or gateway exports ALLOW spans. The trail file records all verdicts.
- The open source CLI is advisory. By default, a hook that hits an internal error lets the call through and records nothing. Only opt-in fail-closed hooks record `FAIL_CLOSED`.
- The hosted Shield KYA webhook cannot send to HEC directly, because HEC by default needs an `Authorization: Splunk <token>` header, and the webhook does not send it. This app does not pull from the hosted API.
- The trail key `host` (`ide` or `runtime`) has the same name as the Splunk `host` field. Use `kya_host` for the gate host class.

## Troubleshooting

- Empty dashboard: run `` `shield_kya_events` | head 5 ``. If nothing comes back, check the index in the `shield_kya_index` macro and the source type of your input.
- Wrong event times for the trail: the data came in through the HEC event endpoint. Use a file monitor or the HEC raw endpoint.
- `kya_mcp_server` is empty: the tool id has no `__` (only MCP tools have the `<server>__<tool>` form).

## Tests

- Splunk AppInspect 4.3.1 (default checks and the `cloud` tag) runs on the package. See `appinspect.sh` next to this folder in the source repository.
- The field extractions in `transforms.conf` and the field names in `props.conf` are checked against a real trail file and real `splunk_hec` exporter events in the KYA test suite.
- Not tested yet: a live Splunk Enterprise or Splunk Cloud instance.

## Support

Community support through GitHub issues: https://github.com/The-Pixel-Boys/shield-kya/issues. Contact: it@shield-agent.com.
