# Import the AGT audit log into the hosted console

`kya import --from agt` reads Microsoft Agent Governance Toolkit's audit log into your local
trail. The hosted console at https://shield-agent.com accepts the same log, so a team can see AGT's
allow, review and deny decisions next to its other KYA activity without copying files between
machines.

- Console: sign in, open Import traces (`/app/kya/import`), pick source `agt`, upload
  `~/.claude/agt/audit-log.json`.
- API: `POST https://shield-agent.com/api/v1/kya/import?from=agt` with your workspace API key and the
  whole log as the JSON body.
- Guide: https://shield-agent.com/docs/kya/import-agt

The hosted import behaves like the CLI: AGT's hash chain is re-verified by recomputing every entry
hash, rows are keyed by the recomputed hash (re-imports are idempotent and a forged log cannot block
the genuine one), a broken chain stores every row with `chainVerified: false`, unverified rows are
ignored by certify, and imported AGT rows never satisfy the human-approval control (SEC-03). CLI
details: [import-agt.md](./import-agt.md).
