# Hosted console, usage stats, OTLP and development

The enterprise tier, how to develop kya, hosted login, anonymous usage stats and OTLP export. Moved out of the package README. Back to the [README](../README.md).

## Enterprise (separate tier)

Pin, private registry, multi-tenant density, ORR board ops, and support are not required for the day-1 `npx` path above.

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

## Hosted console (`kya login`, optional)

`kya login` links this machine to your hosted Shield KYA workspace. It uses the device code flow: the CLI shows a short code, you approve it in the hosted console, and the CLI saves a full-workspace API key with mode 0600 in `~/.kya/hosted-credentials.json`. `kya logout` deletes that file. It does not revoke the key on the server, so revoke it in the console too. The OSS CLI works without an account, and `kya certify` and the hook never read the saved key. Details, failure cases and the one-line calls to action: [docs/login.md](login.md).

## Anonymous usage stats (opt-in, off by default)

The first time you run `kya start`, `kya init` or `kya connect` in a terminal, KYA asks once whether to share anonymous usage stats (`[y/N]`, the default is No). Only an explicit `y` or `yes` turns it on. Nothing is sent in CI, in non-interactive runs, with `--json`, or when `DO_NOT_TRACK=1` / `KYA_TELEMETRY=0` is set. `kya hook` itself never touches the network; when you opted in it starts a detached helper at most once a day that sends one `ping`, so hook-only installs still count as active.

```bash
kya telemetry show        # the exact payload, field by field
kya telemetry status      # on / off / not asked, and what overrides it
kya telemetry off --purge # turn off and erase what the server holds for this install
```

Full details, the payload, retention and how to self-host the endpoint: [docs/telemetry.md](telemetry.md).

## OTLP (optional)

Opt-in. Default off.

**OSS CLI:** set `KYA_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`) to export thin evaluate latency (`kya.client.evaluate.latency`) with tags `verdict` and `host` only. No tool args or API keys.

**Decision span export:** set `KYA_OTLP_EXPORT_ENDPOINT` (or `"otlpExport": { "endpoint": ... }` in `.kya/config.json`) to emit every decision as an OTLP/JSON GenAI span (`gen_ai.tool.name`, `kya.verdict`, `kya.reason_code`, token attributes when known) to any OTLP/HTTP backend. Long-lived processes (MCP gate, gateway) export every decision. Hook/wrap spawns export DENY / REQUIRE_APPROVE via the detached `notify-flush` helper. Plaintext http is accepted for loopback only unless `"insecure": true`. Flush results collect in `~/.kya/otel-stats.json` (endpoint host label, spans sent/failed, last export time), shown as the **OTel export** panel on the report's System tab.

**Map attributes on spans (opt-in, default off):** `"otlpExport": { "endpoint": ..., "mapAttrs": true }` in `.kya/config.json` in your account home folder (not `HOME` or `KYA_HOME`; owned by you, no group or other write (600 recommended), no hard link, not inside the project, symlink checks apply) adds `kya.target.class` (a class, never a path; a project class goes out as `project`) and `kya.device` (hashed device id), and sends `kya.session_id` as the session hash of `kya export`, so dashboards keyed on the raw id work only while it is off. `kya doctor` says on stderr when the file is ignored. Env, `HOME`, `KYA_HOME` and a project `.kya/config.json` cannot turn it on. See [`docs/otlp.md`](otlp.md).

**Hosted plane:** richer Micrometer gauges and timers when `KYA_OTLP_ENABLED=true`.

Full env, Grafana/Datadog notes, forbid list, and a Collector sample: [`docs/otlp.md`](otlp.md).
