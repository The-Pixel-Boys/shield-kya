# Pi

[Pi](https://inflection.ai) has no documented MCP server support, so there's nothing to wire a config into. KYA still gates it — through `kya wrap`, which evaluates a command before it runs and records the verdict on the trail.

## Setup

Nothing to install beyond the KYA CLI itself:

```bash
npm i -g @shield-agent/kya
```

Then put wrap in front of however you invoke Pi — an API script, a shell alias, a cron job:

```bash
kya wrap --tool-id pi.chat.send -- python scripts/ask_pi.py "Summarize this diff"
```

Wrap exits `0` on Allow, `4` on Hold (a person must approve), `1` on Deny — so `kya wrap … && ./next-step.sh` can't skip the gate.

## What KYA reports

Every wrapped invocation leaves a trail row: tool id, verdict, timestamp, duration. `kya receipt --open` shows them; `--offline` rows stay local.

## Files written

None. Wrap writes trail rows under `.kya/` in the project where you run it; Pi's own config is untouched.

## Verify

```bash
kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
```

Expect a Deny row — an irreversible write with no policy never auto-allows. Then wrap a trivial Allow-path call and see both rows on the receipt.

## Uninstall

Nothing was wired. Delete the wrap from your scripts/aliases and remove `.kya/` if you don't want the local trail.

## Troubleshooting

- **Wrap returns 4 and waits.** That's a Hold working as designed — decide it with `kya approve --id <id>` / `kya reject --id <id>`, or run `kya dash` and decide there.
- **Command runs but no trail row.** You bypassed wrap — the row only exists for invocations that go through `kya wrap`. Check the alias/script actually calls it.
- **`KYA_API_KEY is required`.** Add `--offline` for local sample evaluation, or export a key for the authenticated plane.

## Honesty note

Wrap gates the commands you route through it. Pi calls made any other way — a browser tab, an unwrapped script, a mobile app — never touch KYA. Coverage is exactly the set of invocations you wrap, no more.

## If Pi ships MCP support

This page gets promoted to a `kya connect` recipe when a verified MCP config path exists. The bar for promotion is the checklist in `docs/host-recipe.md`.
