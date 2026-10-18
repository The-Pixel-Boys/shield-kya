# Import the AGT audit log into the hosted console

`kya import --from agt` reads Microsoft Agent Governance Toolkit's audit log into your local
record (trail). The hosted console at https://shield-agent.com accepts the same log, so a team can see AGT's
allow, review and deny decisions next to its other KYA activity without copying files between
machines.

- Console: sign in, open Import traces (`/app/kya/import`), pick source `agt`, upload
  `~/.claude/agt/audit-log.json`.
- API: `POST https://shield-agent.com/api/v1/kya/import?from=agt` with your workspace API key and the
  whole log as the JSON body.
- Guide: https://shield-agent.com/docs/kya/import-agt

The hosted import behaves like the CLI. It recomputes every entry hash to verify AGT's hash chain
(a checksum link between log rows). Rows are keyed by the recomputed hash, so re-imports are
idempotent (they add no duplicates) and a forged log cannot block the genuine one. A broken chain
stores every row with `chainVerified: false`. Certify ignores unverified rows. Imported AGT rows
never satisfy the human-approval control (SEC-03). CLI details: [import-agt.md](./import-agt.md).
