# Import ADR Sensor events

`kya import --from adr-sensor` reads the unified `AgentEvent` export written by the
ADR Sensor Python package (`adr-sensor` on PyPI) and adds it to the Shield KYA record
(trail). After an import, `kya receipt`, `kya certify` and `kya investigate` see ADR Sensor
tool calls and sessions next to everything else in the record.

```bash
kya import --from adr-sensor ./adr-sensor-events.jsonl
kya import --from adr-sensor ./adr-sensor-events.json   # single event or array
```

## What lands in the record

ADR Sensor exports `AgentEvent` records with `uuid`, `timestamp`, `session_id`,
`chat_history` and optional `token_usage`. The importer maps one `AgentEvent` to one
or more `TrailEvent`s:

| ADR Sensor field | KYA event field |
|------------------|-----------------|
| `timestamp` | `ts` |
| `session_id` | `sessionId` (fallback: `import-adr-sensor-<date>`) |
| `chat_history[].tools[].tool_name` | `toolId` (one event per tool call) |
| `token_usage.prompt_tokens` | `tokensIn` |
| `token_usage.completion_tokens` | `tokensOut` |
| `uuid` | `sourceHash` (used to skip duplicates) |

Every row is `host: import`, `mode: observe`, `importFormat: "adr-sensor"`,
`importedFrom: "adr-sensor"` and `reasonCode: IMPORTED` (or `IMPORTED_ERROR` when the
event or tool result signals an error). Tool summaries contain input argument key
names only (`input: path, target`) and are redacted through `redactTrailText`; raw
argument values never reach the record. Text fields have control characters
(newlines, ESC, NUL) replaced by spaces and whitespace collapsed.

Records are skipped and counted in the `errors:` line (the rest import) when they
are not objects, lack a `uuid`, lack a parseable `timestamp`, or have a timestamp
outside 2000-01-01 .. now + 1 day.

### No tool calls

If an `AgentEvent` has no tool calls but has a valid `uuid` and `timestamp`, the
importer still writes one TrailEvent with `toolId: "adr-sensor:session"` and
`verdict: ALLOW` (or `DENY` if the source record signals an error). This keeps the
import visible in the report and certify even for sessions that only produced chat
messages.

## Error detection

A tool call event becomes `verdict: DENY` / `reasonCode: IMPORTED_ERROR` when any of
the following is true:

- The top-level `AgentEvent` has a non-empty `error` field or `status: "error"`.
- The chat message containing the tool call has a non-empty `error` field or
  `status: "error"`.
- The tool call itself has a non-empty `error` field or `status: "error"`.

Otherwise the event is `ALLOW`.

## Re-importing

Imports are idempotent (no duplicates). Rows are matched by the ADR Sensor `uuid` (`sourceHash`), so
importing the same file twice, or a file that has grown since the last import, adds
only the new events. The summary shows `already imported: N record(s)` for the rest.

## Known limitations

- Sequential only: two imports running at the same time can both pass the duplicate
check and write duplicate rows. Run one import at a time (re-running afterwards never
adds more).
- `readTrail` reads only the newest 1MB of `trail.jsonl`, so a very large import
pushes older rows out of the receipt, certify and investigate views. The rows stay
in the file. This applies to every importer.

## Notes

- The importer reads the file only. It never calls ADR Sensor, never runs its code
and never changes its policy.
- Token usage is attached to every TrailEvent emitted from one `AgentEvent` because
ADR Sensor reports it at the event level, not per tool call.
