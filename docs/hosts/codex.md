# Codex (OpenAI)

Two ways to wire KYA into Codex. Pick one or use both:

- **Codex plugin** (hooks): records every tool call Codex runs through its hook path (shell, `apply_patch`, MCP tools, other local tools) and blocks only the small never-list. Advisory and fails open.
- **MCP server** (below): gives Codex the three kya tools (`kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval`). Allow runs, Deny stops, Hold waits for a person, but only for calls the model routes through MCP.

## Codex plugin

This repo is also a Codex plugin marketplace named `shield-kya` (`.agents/plugins/marketplace.json`) with one plugin, `kya` (the same `plugins/kya` folder as the Claude Code plugin; Codex reads `plugins/kya/.codex-plugin/plugin.json`).

```bash
codex plugin marketplace add The-Pixel-Boys/shield-kya
codex plugin add kya@shield-kya
```

Or open `/plugins` in Codex CLI and install `kya` from the `shield-kya` tab. Plugins are not available in the Codex IDE extension.

**Then trust the hooks.** Codex does not run plugin hooks until you review and trust them: open `/hooks` in Codex CLI and trust the two Shield KYA hooks. Until you do, KYA records nothing and `codex exec` gives no warning. Codex keys trust to the hook definition (command string, matcher, timeout, status message), not to the scripts or the package that command runs. The SessionStart command carries the pinned kya version, so every kya release changes it and Codex asks again; until you re-trust it, the PreToolUse hook keeps using the kya copy already installed. The PreToolUse command carries no version, so its trust carries over. A change to the plugin's scripts that leaves the command strings unchanged runs without a new prompt.

**Trust model.** Codex upgrades Git marketplaces at startup. Anyone who can push to the main branch of The-Pixel-Boys/shield-kya, or who holds the token that syncs it, can therefore change what runs at your next Codex start. That is the trust model of any auto-updating plugin marketplace. Teams that want to choose when updates land can add the marketplace at a pinned release ref, `codex plugin marketplace add The-Pixel-Boys/shield-kya@vX.Y.Z` (Codex accepts `owner/repo@ref`). Checked with Codex CLI 0.162.1: the startup auto-upgrade honours a pinned ref (a pinned install stayed on its tag while an unpinned one followed main), and `codex plugin marketplace upgrade` reports a pinned marketplace as up to date. The price of pinning is that you get no kya updates, including fixes, until you add the marketplace again at the new tag. This was exercised against a local Git server; the GitHub `@tag` form stores the same `ref` field.

What the plugin does, and does not do:

- **SessionStart** runs `node "${PLUGIN_ROOT}/scripts/bootstrap.mjs" @shield-agent/kya@0.30.0`. It installs that exact kya once into the plugin data directory (`~/.codex/plugins/data/kya-shield-kya`, about 5 s on a clean machine) and checks it on later sessions. Same hardened installer as the Claude Code plugin ([claude-plugin.md](claude-plugin.md#install-hardening-and-limits)).
- **PreToolUse** (every tool) runs `node "${PLUGIN_DATA}/node_modules/@shield-agent/kya/dist/cli.js" hook --host codex`. No npx, no registry traffic at hook time. Trail rows carry `product: codex`.
- It evaluates locally, with no hosted-plane calls, so it has no Hold tickets and no human sign-off. Shell commands come back as `REQUIRE_APPROVE` / `SHELL_EXEC` and are recorded, not blocked. Never-list tools (for example `mcp__postgres__drop_table`) are blocked: Codex shows the model `Tool call blocked by PreToolUse hook: KYA denied ...`.
- It fails open. If node, npm or kya is missing, or the hook crashes or times out (5 s), Codex marks the hook failed and runs the tool unrecorded. A SessionStart problem prints `Shield KYA is NOT recording: <reason>` as a hook message; `codex exec` (plain or `--json`) does not show it, so check the data directory if the trail stays empty. Whether the interactive TUI shows it is not verified.
- It needs Node.js 22+ (24 recommended) and `npm` on the PATH that Codex sees. Node 20 and 21 are unsupported but work; the bootstrap then emits a one-line `unsupported but works` hook message (visible only where Codex shows hook messages, see above). Node 18 and older are not supported.
- Codex hooks see shell, `apply_patch`, MCP and other local function tools, not hosted tools such as web search. OpenAI calls hooks "a useful guardrail, not a complete enforcement boundary". `apply_patch` rows have no change preview yet.
- The plugin bundles no MCP server (`"mcpServers": {}`), so it never starts the Claude plugin's server. Add the MCP server below if you want the kya tools too.
- Plugins with hooks cannot be listed in OpenAI's public plugin directory; install from this marketplace.

Uninstall: `codex plugin remove kya@shield-kya`, then delete `~/.codex/plugins/data/kya-shield-kya`.

## MCP server

`kya connect codex` wires the stdio entry into `~/.codex/config.toml` (TOML, merge-only); `--gate` writes a `url`-based `[mcp_servers.shield-kya-gate]` table pointing at the local kya gateway instead. To copy the richer example by hand (environment-inherited keys), see below.

### Setup

1. Open [`openai/codex.config.example.toml`](../../openai/codex.config.example.toml).
2. Merge its `[mcp_servers.shield-kya]` block into `~/.codex/config.toml`. **Global only** - don't drop a live key into a project's `.codex/config.toml`; that file is easy to commit. The example inherits `KYA_API_KEY` from the environment (`env_vars`) instead of storing it.
3. Restart Codex.

Two variants in the one file - pick one, not both:

- **Local stdio (OSS):** `command = "npx"` + `serve-mcp --stdio`. Needs the package installed (`npm i -g @shield-agent/kya`); `--no-install` means no registry fetch at startup.
- **Hosted HTTP:** `url = "https://shield-agent.com/mcp"` + `bearer_token_env_var = "KYA_API_KEY"`. Same three tools, no local process.

**Responses API** (no CLI): see [`openai/responses-mcp.example.json`](../../openai/responses-mcp.example.json) - `server_url` + `Authorization: Bearer ${KYA_API_KEY}`. **ChatGPT Apps:** deferred; Developer Mode wants OAuth. Use Codex until then.

### What KYA reports

Three tools: `kya.policy_evaluate` (Allow / Deny / Hold), `kya.session_ingest`, `kya.request_approval`. Each call lands on the receipt with a clipped, redacted change preview: `kya receipt --open`.

### Files written

For the MCP path you edit one file by hand: `~/.codex/config.toml`. KYA installs nothing else. (The plugin path installs kya into the plugin data directory, see above.)

### Verify

1. Restart Codex, then run `codex mcp list` - `shield-kya` should show.
2. Ask Codex for a small change and watch the trail.
3. Offline smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a Deny row.

### Uninstall

Remove the `[mcp_servers.shield-kya]` block from `~/.codex/config.toml` and restart.

### Troubleshooting

- **Server fails to start.** The example pins `npx --no-install @shield-agent/kya@…`. Install the package globally first, or switch to the hosted variant which needs no local process.
- **`KYA_API_KEY is required`.** `env_vars` only *inherits* the variable - export it in the shell that launches Codex (or your desktop environment), not in the TOML.
- **Both variants enabled.** Codex will run two servers with the same tools and you'll get duplicate verdicts. Comment one out.
- **Connected but empty trail.** On the MCP path only MCP-routed calls reach KYA; shell commands Codex runs natively bypass it. The plugin's hook records those (after you trust it in `/hooks`).

### Honesty note

On the MCP path, Codex decides which tools go through MCP; anything it executes natively is outside that path. The plugin hook sees native tool calls too, but it is advisory: it records them and blocks only the never-list. The config inherits your key from the environment - never paste a live key into the TOML.

### Wrap fallback

```bash
kya wrap --offline -- codex exec "fix the tests"
```

Wrap evaluates the command itself before it runs and records a trail row. Exit `0` Allow, `4` Hold, `1` Deny.
