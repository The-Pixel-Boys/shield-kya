# Codex (OpenAI)

Wire KYA into Codex CLI / IDE so tool calls routed through MCP pass Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

There's no `kya connect codex` — Codex config is TOML with its own conventions, so copy the example by hand.

## Setup

1. Open [`openai/codex.config.example.toml`](../../openai/codex.config.example.toml).
2. Merge its `[mcp_servers.shield-kya]` block into `~/.codex/config.toml`. **Global only** — don't drop a live key into a project's `.codex/config.toml`; that file is easy to commit. The example inherits `KYA_API_KEY` from the environment (`env_vars`) instead of storing it.
3. Restart Codex.

Two variants in the one file — pick one, not both:

- **Local stdio (OSS):** `command = "npx"` + `serve-mcp --stdio`. Needs the package installed (`npm i -g @shield-agent/kya`); `--no-install` means no registry fetch at startup.
- **Hosted HTTP:** `url = "https://shield-agent.com/mcp"` + `bearer_token_env_var = "KYA_API_KEY"`. Same three tools, no local process.

**Responses API** (no CLI): see [`openai/responses-mcp.example.json`](../../openai/responses-mcp.example.json) — `server_url` + `Authorization: Bearer ${KYA_API_KEY}`. **ChatGPT Apps:** deferred; Developer Mode wants OAuth. Use Codex until then.

## What KYA reports

Three tools: `kya.policy_evaluate` (Allow / Deny / Hold), `kya.session_ingest`, `kya.request_approval`. Each call lands on the receipt with a clipped, redacted change preview: `kya receipt --open`.

## Files written

You edit one file by hand: `~/.codex/config.toml`. KYA installs nothing else.

## Verify

1. Restart Codex, then run `codex mcp list` — `shield-kya` should show.
2. Ask Codex for a small change and watch the trail.
3. Offline smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row.

## Uninstall

Remove the `[mcp_servers.shield-kya]` block from `~/.codex/config.toml` and restart.

## Troubleshooting

- **Server fails to start.** The example pins `npx --no-install @shield-agent/kya@…`. Install the package globally first, or switch to the hosted variant which needs no local process.
- **`KYA_API_KEY is required`.** `env_vars` only *inherits* the variable — export it in the shell that launches Codex (or your desktop environment), not in the TOML.
- **Both variants enabled.** Codex will run two servers with the same tools and you'll get duplicate verdicts. Comment one out.
- **Connected but empty trail.** Only MCP-routed calls reach KYA. Shell commands Codex runs natively bypass the gate — see the honesty note.

## Honesty note

Codex decides which tools go through MCP. KYA governs that path; anything Codex executes natively is outside it. The config inherits your key from the environment — never paste a live key into the TOML.

## Wrap fallback

```bash
kya wrap --offline -- codex exec "fix the tests"
```

Wrap evaluates the command itself before it runs and records a trail row. Exit `0` Allow, `4` Hold, `1` Deny.
