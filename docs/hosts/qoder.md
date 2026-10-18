# Qoder CLI

Qoder is an agentic coding CLI with no documented MCP server support, so there's nothing to wire a config into. KYA still gates it, through `kya wrap`, which evaluates a command before it runs and records the decision in the record (trail).

## Setup

Nothing to install beyond the KYA CLI itself:

```bash
npm i -g @shield-agent/kya
```

Then put wrap in front of however you invoke Qoder: a shell alias, a script, a CI step:

```bash
kya wrap --tool-id qoder.run -- qoder run "Refactor the auth module"
```

Wrap exits `0` on Allow, `4` on Hold (a person must approve), `1` on Deny, so `kya wrap … && ./next-step.sh` can't skip the gate.

## What KYA reports

Every wrapped invocation leaves a record row: tool id, decision, timestamp, duration. `kya receipt --open` shows them; `--offline` rows stay local.

## Files written

None. Wrap writes record rows under `.kya/` in the project where you run it; Qoder's own config is untouched.

## Verify

```bash
kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
```

Expect a `REQUIRE_APPROVE` row. An irreversible write with no policy never auto-allows. Then wrap a trivial Allow-path call and see both rows on the receipt. This exact record-row check runs in CI against the recipe.

## Uninstall

Nothing was wired. Delete the wrap from your scripts/aliases and remove `.kya/` if you don't want the local record.

## Troubleshooting

- **Wrap returns 4 and waits.** That is a Hold working as designed. Decide it with `kya approve --id <id>` / `kya reject --id <id>`, or run `kya dash` and decide there.
- **Command runs but no record row.** You bypassed wrap. The row only exists for invocations that go through `kya wrap`. Check the alias/script actually calls it.
- **`KYA_API_KEY is required`.** Add `--offline` for local sample evaluation, or export a key for the authenticated plane.

## Honesty note

Wrap gates the commands you route through it. Qoder invocations made any other way (an interactive session, an unwrapped script) never touch KYA. Coverage is exactly the set of invocations you wrap, no more.

## If Qoder ships MCP support

This page gets promoted to a `kya connect` recipe when a verified MCP config path exists. The bar for promotion is the checklist in `docs/host-recipe.md`.
