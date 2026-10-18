# Gemini CLI

Two ways to wire KYA into [Gemini CLI](https://github.com/google-gemini/gemini-cli). Pick one or use both:

- **Gemini CLI extension** (hooks): records every tool call Gemini runs through its `BeforeTool` hook (built-in tools and MCP tools) and blocks only the small never-list. Advisory and fails open.
- **MCP server** (below): gives Gemini the three kya tools. Allow runs, Deny stops, Hold waits for a person, but only for calls the model routes through MCP.

## Gemini CLI extension

The repo root is also a Gemini CLI extension named `shield-kya` (`gemini-extension.json` plus `hooks/hooks.json`):

```bash
gemini extensions install https://github.com/The-Pixel-Boys/shield-kya
```

Gemini asks you to confirm the install (`--consent` skips the prompt) and then runs the extension's hooks with no further trust step. Restart Gemini CLI afterwards. The extension pins the kya version it was released with; a hand-wired hook needs a kya that understands Gemini's `BeforeTool` event (released together with this extension).

What it does, and does not do:

- **SessionStart** runs `scripts/bootstrap.mjs` from the extension, which installs the pinned `@shield-agent/kya` once into `<extension>/.kya-runtime` (same hardened installer as the Claude Code plugin, see [claude-plugin.md](claude-plugin.md#install-hardening-and-limits)). `gemini extensions update` replaces the extension folder, so the next session installs kya again.
- **BeforeTool** (every tool) runs `node "<extension>/.kya-runtime/.../dist/cli.js" hook --host gemini; exit 0`. Record (trail) rows carry `product: gemini`. MCP calls are recorded under the `mcp__<server>__<tool>` id that kya uses for every host (Gemini's own name is `mcp_<server>_<tool>`).
- It evaluates locally, with no hosted-plane calls, so it has no Hold tickets and no human sign-off. Shell commands (`run_shell_command`) come back as `REQUIRE_APPROVE` / `SHELL_EXEC` and are recorded, not blocked. Never-list tools (for example a `drop_table` on a known Postgres server) are blocked: kya answers `{"decision":"deny"}` and the model gets the reason as a tool error.
- It fails open. The trailing `; exit 0` is deliberate: Gemini treats any exit code other than 0 or 1 as a block, so a missing `node` (exit 127) would otherwise block every tool call. If kya is missing or broken, Gemini shows the error text as a warning on each call and runs the tool unrecorded. A hook that exceeds its 5 s timeout is also skipped, so the call runs.
- It needs Node.js 22+ (24 recommended) and `npm` on the PATH that Gemini CLI sees. Node 20 and 21 work with a one-line `unsupported but works` notice at session start; Node 18 and older are not supported.
- MCP calls are matched against the never-list through the `mcp_context` Gemini sends with them. If Gemini sends an MCP call without it (it omits it when it cannot look up the server config), the call is recorded under Gemini's own `mcp_<server>_<tool>` name and is not matched against the never-list. Known limit.
- Gemini sends no tool-call id, so if you also wire a kya hook by hand, both copies record the call.
- The hosted-plane hook (beta, [hosted-hook.md](../hosted-hook.md)) supports Claude Code only. Do not wire `kya hook --plane-config` into Gemini CLI: its deny body is Claude Code's, which Gemini does not treat as a block.
- The extension bundles no MCP server; add one with the examples below. Gemini also loads the repo's `skills/kya-wrap` skill from the extension; the skill tells the model it applies only when the kya MCP tools are connected, so without them the model does not wait for approvals.
- `gemini extensions install <github url>` installs from the repo's Latest GitHub Release, not a clone. It takes a release asset when one is named for the platform (`darwin.*`, `linux.*`, `win32.*`, optionally with the architecture) whatever the number of assets, or the only asset when there is exactly one; otherwise it uses the source archive of that release's tag. The kya releases carry no assets, so the source archive is used, and it contains the extension only from the kya release that ships it. The kya gateway binary releases (`gate-v*`) must stay off Latest (they are published with `--latest=false` once shield-kya #116 is merged, which has to happen before the next `gate-v` release); otherwise Gemini would install from a gateway tag that has no extension.
- The SessionStart hook passes its data folder through the hook `env` field. That field exists in Gemini CLI's source (v0.63.0, `packages/core/src/hooks/types.ts`) but is not in its hooks documentation, so a future Gemini release could drop it; the bootstrap then reports `Shield KYA is NOT recording`.
- Windows is not yet verified: Gemini runs hooks through PowerShell there, and `; exit 0` is valid PowerShell, but no Windows run has been done.

Uninstall: `gemini extensions uninstall shield-kya`.

## MCP server

### Setup

Merge one of the examples into `~/.gemini/settings.json` (global) or `.gemini/settings.json` (project):

- **Stdio (local):** [`gemini/settings.example.json`](../../gemini/settings.example.json): `npx --no-install … serve-mcp --stdio`, `trust: false`.
- **Hosted:** [`gemini/settings.hosted.example.json`](../../gemini/settings.hosted.example.json): `httpUrl: "https://shield-agent.com/mcp"` + `Authorization: Bearer ${KYA_API_KEY}`.

Do not enable both at once. Keep `"trust": false`. Setting it true tells Gemini to skip its own confirmations for this server, which defeats the checkpoint. Restart Gemini CLI after editing.

### What KYA reports

Three tools: `kya.policy_evaluate` (Allow / Deny / Hold), `kya.session_ingest`, `kya.request_approval`. Every MCP call lands on the receipt with a clipped, redacted change preview: `kya receipt --open`.

### Files written

For the MCP path you edit one file by hand: `~/.gemini/settings.json` or `.gemini/settings.json`. KYA installs nothing else. (The extension installs kya into its own folder, see above.)

### Verify

Verified in CI: the e2e suite installs Gemini CLI headless, wires this config, and asserts `gemini mcp list` shows `shield-kya` with the three kya tools.

By hand:

1. `gemini mcp list`: `shield-kya` connected.
2. Ask Gemini for a small change; watch the record.
3. Offline smoke:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a `REQUIRE_APPROVE` row in the record.

### Uninstall

Delete the `shield-kya` block from the settings file you merged into and restart.

### Troubleshooting

- **`gemini mcp list` shows it disconnected.** The stdio example needs the package installed (`npm i -g @shield-agent/kya`); `--no-install` refuses to fetch at startup. Or switch to the hosted example.
- **Both examples merged.** Two servers, duplicate decisions. Remove one.
- **`${KYA_API_KEY}` literally in requests.** Gemini expands env placeholders at load. Export the variable in the shell that starts Gemini, then restart.
- **Trust prompt keeps appearing.** Expected with `trust: false`. Don't silence it by flipping trust to true; that turns off confirmations for the gate itself.

### Honesty note

On the MCP path, Gemini's built-in tools only reach KYA when they go through MCP. The extension's hook also sees native tool calls, but it is advisory: it records them and blocks only the never-list. `trust: false` keeps Gemini's own confirmation layer intact on top.

### Wrap fallback

```bash
kya wrap --offline -- gemini "summarize this repo"
```

Wrap evaluates the command itself before it runs and records a row in the record. Exit `0` Allow, `4` Hold, `1` Deny.
