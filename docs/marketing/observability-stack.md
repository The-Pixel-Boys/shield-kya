# Works with your observability stack

Neatlogs, Langfuse, LangSmith and friends explain what happened after the
fact. KYA decides what may happen before a tool call runs, and proves it
afterwards. Different job, same agents. Keep your tracing stack; add a gate.

## Next to observability, not instead of it

Observability tooling answers "what did the agent do?" KYA answers "what is
the agent allowed to do?" and "can you prove it?" The gate sits in front of
every tool call with a decision (Allow, Review, Deny, with human approval
where policy asks for it), and the record (trail) stores what the decision
was. Your tracing backend still gets its spans; nothing about your dashboards
changes.

## What KYA records locally

Every gated call lands as one event in the local record, which is
tamper-evident (it shows if someone changed it):

- `toolId`: which tool was called (for MCP: `<target>__<tool>`)
- `verdict`: ALLOW / DENY, with REVIEW flows for human approval
- `reasonCode`: why (for example `POLICY_DENY`, `TOOL_ERROR`)
- `mode`: `observe`, `hold`, or `offline`
- `summary`: one line, human-readable
- `targetPath` and `diffPreview`: what a file-writing call would touch
- `sessionId`: groups events into sessions
- `product`, `host`: which agent product on which host made the call

Tool arguments, prompts, and secrets never reach the record. Stored fields
pass through a secret scanner first.

## OTLP: spans in, telemetry out

The kya gateway runs a local OTLP/HTTP traces receiver
(`src/gate/otlp-receiver.ts`). Gate spans export to
`http://127.0.0.1:<port>/v1/traces`; each MCP `tools/call` span becomes one
record event in `observe` mode. Only approved span attributes are read
(method, target, tool name, session id), and the receiver listens on loopback
only, so there is no remote injection surface.

In the other direction, KYA speaks standard OTLP to your existing backends.
Set `KYA_OTLP_ENDPOINT` (or the standard `OTEL_EXPORTER_OTLP_ENDPOINT`) and
metrics flow through an OpenTelemetry Collector, Grafana Alloy, or the
Datadog Agent into whatever you already run. Auth headers live on the
Collector, not in the app or in git. Full setup, including Grafana Cloud
and Datadog recipes and a sample Collector config:
[`docs/otlp.md`](../otlp.md).

## See it live, prove it later

- `kya receipt --open`: the live local report: sessions, decisions, servers
  facet, rendered from the record on your machine.
- `kya certify`: gap report against the Agent Trust Baseline: which
  requirements your setup meets, which have gaps, evidence-only. HTML, JSON,
  and Markdown artifacts under `.kya/certify/`.

## FAQ

**Does KYA replace Langfuse (or LangSmith, or Neatlogs)?**
No. Those tools observe and explain agent behavior after the fact. KYA
checks it in front of the tool call and keeps the proof. Run both.

**Does it need an account?**
No. The CLI is local-first: install, gate, record, report, certify: all on
your machine. The hosted console at shield-agent.com is optional.

**Does it work offline?**
Yes. Offline is the default mode; policy, approvals, and the record keep
working with no network at all.
