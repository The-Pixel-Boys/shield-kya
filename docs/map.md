# Map of agent actions

`kya map` draws what KYA recorded about agent actions on this machine. It shows one graph and two heat views. It reads the local trail only.

```
kya map                      # writes .kya/receipts/map-3d.html and prints the path
kya map --days 7             # last 7 days (default 3)
kya map --json               # graph and heat as one JSON document on stdout
kya map --html out.html      # write the page to a file of your choice
kya map --session <id>       # one session only
```

The live report has a **Map** tab too. Run `kya start` or `kya receipt --open`, then open the tab. It refreshes when new events arrive while the tab is open.

## What it shows

- **Graph.** Four columns, left to right: the device, the agent session, the tool, and the target class. Rows sort by count. A column with more than 21 nodes shows the top 20 and one "+N more" node; click it to see N and the summed count. Two sessions with the same label (for example two `gtm` sessions) get the event count after the label, for example `gtm · 238 events`. Each edge counts how often a step happened. Click a node to see its class, counts per verdict, and first and last time; the rest of the graph fades. Click the background to show all again.
- **Edge colour.** Red means deny. Amber means hold. Grey means observed: recorded, but enforcement is not recorded. Green means allow. An edge with any deny is red. Edge width grows with the count. Deny and hold edges are strong. Allow and observed edges are drawn light until you click a node.
- **When.** Events per hour for the last 7 days. A cell with a deny has a red outline.
- **Where.** Events per target class and verdict.
- **Summary.** Event count, session count, device count, and the top 5 target classes. The list hides the navigation commands `command:cd`, `command:ls` and `command:pwd`. The graph, the heat views and `--json` still count them.

## What it does not show

- **It does not enforce anything.** The map shows what was recorded. It never changes a verdict. The open source check is advisory.
- **Allow rows appear only when KYA records them.** A call that KYA allowed shows as an allow row only when the trail holds that call.
- **The map and the export read the local trail.** The trail holds every verdict that KYA records. OTLP span export is different: the hook and wrap paths send only `DENY` and `REQUIRE_APPROVE` verdicts, and the MCP gate sends every verdict. The optional OTLP map attributes are on only with `otlpExport.mapAttrs` in the user-level config. With them on, the span `kya.session_id` is the same session hash as in the map and the export, so dashboards keyed on the raw session id work only while the option is off. See [otlp.md](otlp.md).
- **No arguments, prompts, file content or full command lines.** The map has no room for them.
- **No raw paths.** Each target is a class, such as `command:git`, `project:app/src/**`, `secret:ssh-key` or `network:example.com`.

## Privacy

- Local only. The map reads your trail file and writes one HTML file. The HTML file makes no network request. Its Content Security Policy blocks network requests from the page.
- The page shows project folder names, tool names and host names for network calls. Check the file before you share it.
- Classes only. A target is a path class, a command name, or a host name for a network call.
- Session ids are hashed with a salt that stays on this machine.
- The device id is a hash. It holds no host name, user name or address.

## Export

`kya export --format agent-flow` writes the local trail as a JSONL event log for agent-flow, a third-party viewer (Apache-2.0, not part of KYA).

```
kya export --format agent-flow                    # JSONL on stdout, last 3 days
kya export --format agent-flow --days 7           # last 7 days
kya export --format agent-flow --session <id>     # one session only
kya export --format agent-flow --out flow.jsonl   # write a new file (mode 0600)
kya export --format agent-flow --out flow.jsonl --force   # replace that file
```

- **Same data as the map.** The command reads the same trail, with the same window and the same session filter as `kya map`. The trail is the one record for every project on this machine, so the export holds the activity of all projects in the window. Project folder names can appear in target classes.
- **Memory.** The command holds the whole window in memory. Keep `--days` short on a large trail.
- **Output file.** `--out` writes a new file with mode 0600 (owner read and write only). It never replaces an existing file or symlink (exclusive create). Add `--force` to replace it with an atomic rename.
- **Line shape.** Each line is `{"time": <seconds since the first event>, "type": <type>, "payload": {...}}`. Each session gets one `agent_spawn` line at its first event. Each event gets one `tool_call_start` and one `tool_call_end` line at the same time.
- **Payload.** Only these keys: `name` or `agent` (the session hash), `sessionId` (the same session hash), `tool`, `verdict`, `reasonCode`, `targetClass`, `deviceId` and `mode`.
- **Not in the payload.** No arguments, no `argsHash`, no paths, no command text, no file content, no working folder and no raw session id.
- **Same session hash as the map.** The session id is hashed with the salt that stays on this machine. The hash is the `sessionHash` that `kya map --json` prints.
- **Stable output.** Lines are in time order, then in file order. The same trail and the same salt give the same bytes.
- **Empty trail.** No output, exit 0, and a note on stderr. An unknown `--format`, a bad `--days` or an existing `--out` file without `--force` exits 2.
- **Line breaks in names.** U+2028 and U+2029 are written as `\u2028` and `\u2029`, so each event is one line for every JSONL reader. A tool name longer than 200 characters is replaced by `tool:` and the first 16 hex characters of its SHA-256 hash.
- **What we checked.** agent-flow reads a line when `type` is a string and `time` is a number (its `event-source.ts`). The payload keys `name`, `agent` and `tool` follow its sample events. We did not open the agent-flow viewer with this output. Unknown payload keys may not show in the viewer.

## Notes

- `kya map --json` prints one JSON document: the graph (`schemaVersion` 1) and the heat views under `heat`.
- The graph uses Cytoscape.js (MIT). The library ships inside the package at `vendor/cytoscape/`, with its licence.
- A trail file can be large. The map reads all of it, one line at a time. Keep the window short for a fast page.
