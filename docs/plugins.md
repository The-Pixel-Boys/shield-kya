# Host plugins

The Claude Code plugin, the GitHub Copilot CLI plugin, the Codex plugin and the Gemini CLI extension. Moved out of the package README. Back to the [README](../README.md).

## Claude Code plugin

This repo is also a Claude Code plugin marketplace named `shield-kya` with one plugin, `kya`:

```text
/plugin marketplace add The-Pixel-Boys/shield-kya
/plugin install kya@shield-kya
```

The plugin is **advisory and fails open**: it records every tool call on the local record (`~/.kya/trail.jsonl`) and blocks the never-list and the guard pack. If kya is missing, crashes or times out, the tool call proceeds and nothing is recorded. It evaluates offline, so it has no Hold and no approval. Hosted enforcement is the MCP policy path against a hosted workspace.

Team rollout: commit `extraKnownMarketplaces` (the `shield-kya` GitHub source) and `enabledPlugins` (`"kya@shield-kya": true`) to the repository's `.claude/settings.json`, or force it org-wide with managed settings. Details and limits: [docs/hosts/claude-plugin.md](hosts/claude-plugin.md).

## GitHub Copilot CLI plugin

**Check first.** If the public repo has no `plugins/kya-copilot` folder yet (every release before the one that ships it), do not install the plugin in Copilot CLI: Copilot then gets the Claude Code plugin, and Copilot CLI 1.0.98 denies every tool call with it ("Denied by preToolUse hook ... (hook errored)"). If you already did, run `copilot plugin uninstall kya@shield-kya`, and use `kya connect copilot` (MCP server only, see [More hosts](host-integrations.md#more-hosts)) until a release ships the folder.

From that release on:

```bash
copilot plugin marketplace add The-Pixel-Boys/shield-kya
copilot plugin install kya@shield-kya
```

Copilot reads `.plugin/marketplace.json` before `.claude-plugin/marketplace.json`, so `kya@shield-kya` resolves to `plugins/kya-copilot`: an Agent Plugins v1 manifest (`plugin.json`), hooks in `com.github.copilot/hooks/hooks.json` and the MCP server in `mcp.json`. Claude Code and Codex keep loading `plugins/kya` and never see this folder. Same behaviour: advisory, fails open. Copilot denies a tool call when a pre-tool hook exits non-zero. So the hook is a `bash` command that does nothing when `node` is not on Copilot's `PATH`. Otherwise it runs `scripts/copilot-hook.mjs` (which forwards only kya's never-list deny) and turns any exit other than `2` into `0`. Recording needs Node.js 22 or later on that `PATH`. Copilot names MCP tools `<server>-<tool>` (for example `postgres-drop_table`); the never-list does not recognise that form yet, so MCP calls are recorded but not blocked. Rows in the record show the product as `other`. Tested with Copilot CLI 1.0.98 on macOS. **Do not install it on Windows yet**: the pre-tool hook has only a `bash` form and has not been run on Windows; use `kya connect copilot` there. Details: [docs/hosts/copilot.md](hosts/copilot.md#plugin).

## Codex plugin

The same repo is a Codex plugin marketplace (`.agents/plugins/marketplace.json`) with the same `kya` plugin:

```bash
codex plugin marketplace add The-Pixel-Boys/shield-kya
codex plugin add kya@shield-kya
```

Then open `/hooks` in Codex CLI and trust the two Shield KYA hooks: Codex runs no plugin hook until you do. Codex trusts the hook command, not the scripts it runs; the SessionStart command carries the kya version, so each kya release asks again. Codex also auto-upgrades Git marketplaces at startup, so whoever can push to this repo can change what runs next; teams can pin a release ref (see the guide). Same behaviour as the Claude Code plugin: advisory, fails open, records every tool call Codex sends through its hooks (shell, `apply_patch`, MCP and other local tools; not hosted tools such as web search), blocks the never-list and the guard pack. It bundles no MCP server; add one with `kya connect codex`. Details: [docs/hosts/codex.md](hosts/codex.md#codex-plugin).

## Gemini CLI extension

The repo root is also a Gemini CLI extension (`gemini-extension.json` + `hooks/hooks.json`):

```bash
gemini extensions install https://github.com/The-Pixel-Boys/shield-kya
```

Same behaviour as the other plugins: advisory, fails open, records every tool call Gemini sends through its `BeforeTool` hook, blocks the never-list and the guard pack. Gemini runs extension hooks without a separate trust step. The extension pins the kya version it was released with. It bundles no MCP server; see the MCP examples. Details: [docs/hosts/gemini.md](hosts/gemini.md#gemini-cli-extension).
