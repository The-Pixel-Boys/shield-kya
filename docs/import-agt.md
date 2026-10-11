# Import the AGT audit log

`kya import --from agt` reads the audit log written by the Claude Code plugin of Microsoft's
[Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) (AGT) and
adds it to the KYA trail. AGT enforces; KYA reports and proves. After an import, `kya receipt`,
`kya certify` and `kya investigate` see AGT's allow, review and deny decisions next to everything
else on the trail.

```bash
kya import --from agt                          # ~/.claude/agt/audit-log.json (or $AGT_CLAUDE_AUDIT_PATH)
kya import --from agt --file ./audit-log.json  # a copy, e.g. from another machine or CI
```

## What lands on the trail

AGT logs `{timestamp, agentId, action, decision, previousHash, hash}` per decision and never
records tool arguments, so neither does the import: no args, no `argsHash`, no diff, no target path.

| AGT field | KYA trail field |
|-----------|-----------------|
| `decision: allow` | `verdict: ALLOW`, `reasonCode: IMPORTED_AGT_ALLOW` |
| `decision: deny` | `verdict: DENY`, `reasonCode: IMPORTED_AGT_DENY` |
| `decision: review` (or `ask`) | `verdict: REQUIRE_APPROVE`, `reasonCode: IMPORTED_AGT_REVIEW` |
| `action: tool.Bash` | `toolId: Bash` (the `tool.` prefix is stripped; `prompt.submit` stays as is) |
| `agentId: claude-code:<session>` | `sessionId: <session>` |
| `timestamp` | `ts` |
| recomputed SHA-256 of the entry | `sourceHash` (dedupe key; never the stored `hash` field) |

Every row is `host: import`, `mode: observe`, `summary: "AGT decision for <tool>"`,
`importedFrom: "agt"` and carries `chainVerified`. Text fields have control characters (newlines, ESC, NUL) replaced by spaces and whitespace collapsed.
Entries are skipped and counted in the `errors:` line (the rest import) when they have an unknown
`decision` (only `allow`, `deny`, `review`, `ask` are accepted), an empty tool name or session id,
a `hash` that is not 64 lowercase hex characters, or a timestamp that is not ISO 8601 or falls outside
2000-01-01 .. now + 1 day.

## Hash-chain verification

AGT chains its entries with an unkeyed SHA-256 over `{timestamp, agentId, action, decision,
previousHash}`. The import re-checks that chain exactly as AGT does (bare array anchored to a
zero genesis hash, or `{seamHash, entries}` after AGT rolled over its 10,000-entry cap).

- Chain intact: every row is `chainVerified: true`.
- Chain broken (an edited or reordered entry, a missing middle entry, or a bare-array log with its
  head cut off): the import still runs, prints `warning: hash chain broken at entry index N (0-based): ...`
  on stderr, and every row from that file is `chainVerified: false`. Exit code stays 0. Nothing is
  silently trusted and nothing is refused.
- An entry whose stored `hash` does not match its content is tampered. Rows are always keyed by the
  hash recomputed from the content, so a forged log imported first can never block the genuine one:
  the genuine entry still imports, as `chainVerified: true`, next to the unverified row.
- A file that is not valid JSON, or not an array or `{seamHash, entries}`, imports nothing and exits 1.
  Directories, FIFOs and devices are refused (all importers), as are files over 50MB. The documented
  stdin spellings (`/dev/stdin`, `/proc/self/fd/0`) still work with a pipe; the 50MB cap is enforced on
  the bytes actually read.
- Entries with an empty tool name (`tool.`) or empty session id are kept, labelled `unknown-tool` /
  `unknown-session`, and counted in a warning. Entries with a blank action or agentId are skipped.
- Certify: rows with `importedFrom: "agt"` and `chainVerified` not true are ignored by `kya certify`.
  AGT `review` is the host's permission prompt, not a KYA approval, so imported AGT rows never satisfy
  SEC-03 (approval path exercised), even when verified (this applies to presence checks, `trail_min`;
  `trail_zero` and `trail_ratio` in a custom catalog still count verified AGT rows). A verified import can still evidence SEC-02 (deny path).

The chain is unkeyed, so it detects accidental damage and naive edits, not an attacker who recomputes
every hash. `chainVerified: true` means "internally consistent", not "authentic". Two cases are
undetectable by design of AGT's format: cutting entries off the tail, and cutting the head of a
`{seamHash, entries}` log and setting `seamHash` to the first kept `previousHash`.

## Re-importing

Imports are idempotent. Rows are matched by the AGT entry hash (`sourceHash`), so importing the same
file twice, or a log that has grown since the last import, adds only the new entries. The summary
shows `already imported: N record(s)` for the rest.

## Known limitations

- Sequential only: two imports running at the same time can both pass the duplicate check and write
  duplicate rows. Run one import at a time (re-running afterwards never adds more).
- `readTrail` reads only the newest 1MB of `trail.jsonl`, so a very large import (AGT's 10,000-entry
  log adds roughly 3.5MB) pushes older rows out of the receipt, certify and investigate views. The rows
  stay in the file. This applies to every importer.

- Follow-up: the receipt does not show `chainVerified` or an AGT import card yet (AGT rows use
  `IMPORTED_AGT_*` reason codes, so the import summary card does not count them).

## Notes

- If the KYA hook also gates the same Claude Code session, the same call can appear twice: once as
  the live KYA row and once as the imported AGT row. The AGT row is the one with `importedFrom: "agt"`.
- The importer reads the file only. It never calls AGT, never runs its code and never changes its policy.
- Real-stack check: `AGT_PLUGIN_DIR=<clone>/agent-governance-claude-code node scripts/e2e-import-agt.mjs`
  runs AGT's own pre-tool-use hook to write a genuine audit log, then imports it with the built CLI
  (happy path, tampered chain, garbage file, idempotence).
