# Gemini CLI

Wire KYA into [Gemini CLI](https://github.com/google-gemini/gemini-cli) so tool calls routed through MCP pass Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

## Setup

Merge one of the examples into `~/.gemini/settings.json` (global) or `.gemini/settings.json` (project):

- **Stdio (local):** [`gemini/settings.example.json`](../../gemini/settings.example.json) — `npx --no-install … serve-mcp --stdio`, `trust: false`.
- **Hosted:** [`gemini/settings.hosted.example.json`](../../gemini/settings.hosted.example.json) — `httpUrl: "https://shield-agent.com/mcp"` + `Authorization: Bearer ${KYA_API_KEY}`.

Do not enable both at once. Keep `"trust": false` — setting it true tells Gemini to skip its own confirmations for this server, which defeats the checkpoint. Restart Gemini CLI after editing.

## What KYA reports

Three tools: `kya.policy_evaluate` (Allow / Deny / Hold), `kya.session_ingest`, `kya.request_approval`. Every MCP call lands on the receipt with a clipped, redacted change preview: `kya receipt --open`.

## Files written

You edit one file by hand: `~/.gemini/settings.json` or `.gemini/settings.json`. KYA installs nothing else.

## Verify

Verified in CI: the e2e suite installs Gemini CLI headless, wires this config, and asserts `gemini mcp list` shows `shield-kya` with the three kya tools.

By hand:

1. `gemini mcp list` — `shield-kya` connected.
2. Ask Gemini for a small change; watch the trail.
3. Offline smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row.

## Uninstall

Delete the `shield-kya` block from the settings file you merged into and restart.

## Troubleshooting

- **`gemini mcp list` shows it disconnected.** The stdio example needs the package installed (`npm i -g @shield-agent/kya`) — `--no-install` refuses to fetch at startup. Or switch to the hosted example.
- **Both examples merged.** Two servers, duplicate verdicts. Remove one.
- **`${KYA_API_KEY}` literally in requests.** Gemini expands env placeholders at load — export the variable in the shell that starts Gemini, then restart.
- **Trust prompt keeps appearing.** Expected with `trust: false`. Don't silence it by flipping trust to true; that turns off confirmations for the gate itself.

## Honesty note

Gemini's built-in tools only reach KYA when they go through MCP. Calls Gemini executes natively are outside the gate. `trust: false` keeps Gemini's own confirmation layer intact on top.

## Wrap fallback

```bash
kya wrap --offline -- gemini "summarize this repo"
```

Wrap evaluates the command itself before it runs and records a trail row. Exit `0` Allow, `4` Hold, `1` Deny.
