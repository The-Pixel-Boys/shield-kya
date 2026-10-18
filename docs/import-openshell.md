# Import OpenShell events

`kya import --from openshell` reads the structured OCSF JSON logs emitted by
NVIDIA OpenShell (github.com/NVIDIA/OpenShell), a sandboxed agent runtime, and
adds them to the Shield KYA record (trail). After an import, `kya receipt`, `kya certify`
and `kya investigate` see OpenShell policy decisions next to everything else in
the record.

```bash
kya import --from openshell ./openshell-events.jsonl
kya import --from openshell ./openshell-events.json   # single event or array
cat ./openshell-export.txt | kya import --from openshell /dev/stdin
```

## Input shapes

An export is raw JSONL (one OCSF record per line), a whole-file JSON array, a
single JSON object, or text lines prefixed with `[ocsf]` (for example
`[ocsf] NET:OPEN ... DENIED ...`); on those lines the JSON document starts at
the first `{`. Bad lines and broken records are skipped and counted in the
`errors:` line, the rest still import.

## What lands in the record

OpenShell emits one OCSF record per decision. The importer maps one record to
one `TrailEvent`:

| OCSF field | KYA event field |
|------------|-----------------|
| `time_dt` (or `time`, epoch ms) | `ts` |
| `session_id` (or `metadata.session_id`) | `sessionId` (fallback: `import-openshell-<date>`) |
| class / category | `toolId`: `openshell.http` for HTTP (L7) events, else `openshell.network` |
| `disposition` / `status` | `verdict`: `DENY` when it signals a denial, else `ALLOW` (audit mode) |
| `dst_endpoint` / `src_endpoint` | `summary` (`dst: host:port`, redacted key names only) |
| `uid` | `sourceHash` (used to skip duplicates) |

Every row is `host: import`, `mode: observe`, `importFormat: "openshell"`,
`importedFrom: "openshell"` and `reasonCode: OPENSHELL_POLICY`. Endpoint
summaries are redacted through `redactTrailText`; raw request or response
payloads never reach the record. Text fields have control characters (newlines,
ESC, NUL) replaced by spaces and whitespace collapsed.

Records are skipped and counted in the `errors:` line (the rest import) when
they are not objects, lack a `uid`, lack a parseable timestamp, or have a
timestamp outside 2000-01-01 .. now + 1 day.

## Network vs HTTP events

`toolId` is `openshell.network` for network-level events (NET:OPEN and
friends) and `openshell.http` for HTTP events. The importer treats a record as
HTTP when the `[ocsf]` line tag mentions HTTP, when the record carries an
`http_request` or `http_response` block, or when its class or category name
mentions HTTP.

## Report panel

Imported OpenShell events feed the dedicated OpenShell panel in the live
report (`kya receipt`, or `kya start` for the auto-refreshing dashboard): the
total policy decisions with DENY vs ALLOW pills, a `openshell.network` vs
`openshell.http` split, the top five destinations parsed from the redacted
`dst: host:port` summaries, and the time of the last event. The panel renders
only when at least one OpenShell signal exists (imported events, openshell-backend
sandboxes, or a detected `openshell` CLI / `openshell-prover`);
fresh installs do not see it. See `docs/sandbox.md` for the runtime probes.

## Re-importing

Imports are idempotent (no duplicates). Rows are matched by the OCSF `uid` (`sourceHash`), so
importing the same file twice, or a file that has grown since the last import,
adds only the new events. The summary shows `already imported: N record(s)`
for the rest.

## Known limitations

- Sequential only: two imports running at the same time can both pass the
duplicate check and write duplicate rows. Run one import at a time (re-running
afterwards never adds more).
- `readTrail` reads only the newest 1MB of `trail.jsonl`, so a very large
import pushes older rows out of the receipt, certify and investigate views.
The rows stay in the file. This applies to every importer.

## Notes

- The importer reads the file only. It never calls OpenShell, never runs its
code and never changes its policy.
- Files over 50MB are refused before reading; the stdin spellings
(`/dev/stdin`, `/proc/self/fd/0`) are read under the same cap.
