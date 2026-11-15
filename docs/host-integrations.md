# Host integrations

The Claude connector and the OpenAI, Gemini, Grok, Cursor and other host setups. Moved out of the package README. Back to the [README](../README.md).

## Claude connector

**Desktop / Claude Code (local stdio):**

```bash
# Prefer a preinstalled package (no registry auto-install):
npx --no-install @shield-agent/kya@0.35.4 serve-mcp --stdio
# Or after npm i -g / local install:
kya serve-mcp --stdio
```

Copy `claude/claude_desktop_config.example.json` into Claude Desktop MCP settings, or use `.mcp.json` for Claude Code. Pack a Desktop extension with `npx @anthropic-ai/mcpb pack` (see `manifest.json`). That pack runs the packed `dist/cli.js`, not `npx -y`.

**Claude.ai / Cowork (hosted):** add a custom connector at `https://shield-agent.com/mcp` with request header `Authorization: Bearer <KYA_API_KEY>` (or `X-API-Key`). It is not Directory-listed yet (API-key auth, no OAuth DCR).

## OpenAI (Codex / Responses)

**Codex CLI plugin (hooks):** see [Codex plugin](plugins.md#codex-plugin). **Codex CLI / IDE (MCP):** copy `openai/codex.config.example.toml` into `~/.codex/config.toml`. Local stdio uses `npx --no-install @shield-agent/kya@0.35.4 serve-mcp --stdio`. Hosted Codex uses `url = "https://shield-agent.com/mcp"` with `bearer_token_env_var = "KYA_API_KEY"`.

**Responses API:** see `openai/responses-mcp.example.json` (`server_url` + `Authorization: Bearer <KYA_API_KEY>`).

**ChatGPT Apps (chatgpt.com):** deferred. Developer Mode wants OAuth. Use Codex until then.

## Gemini CLI

Merge `gemini/settings.example.json` (stdio) or `gemini/settings.hosted.example.json` (`httpUrl` + Bearer) into `~/.gemini/settings.json` or `.gemini/settings.json`. Do not enable both at once.

## Grok

**Grok CLI (local):** `kya connect grok` appends a `[mcp_servers.shield-kya]` table to `~/.grok/config.toml` (`serve-mcp --stdio`, keyless offline sample evaluate). In a running session, press `r` in `/mcps` to refresh.

**grok.com (hosted):** custom connector at `https://shield-agent.com/mcp` (see `grok/README.md`). Grok rejects localhost. Prefer a Bearer machine key when the UI offers a request header.

## More hosts

Each ships a copy-paste example in its own directory; `kya connect <host>` writes the same thing for the starred ones. Full recipes (verify, uninstall, troubleshooting): [docs/hosts/](hosts/).

| Host | Setup | Example |
|------|-------|---------|
| Claude Code | `kya connect claude` (or `kya start`) | - (merges `~/.claude.json` / `.mcp.json`) |
| Grok CLI | `kya connect grok` | - (appends `[mcp_servers.shield-kya]` to `~/.grok/config.toml`) |
| OpenCode | `kya connect opencode` | `opencode/opencode.example.json` |
| Kilo Code | `kya connect kilo` | `kilo/kilo.example.json` |
| Kiro | `kya connect kiro` | `kiro/mcp.example.json` |
| Qwen Code | `kya connect qwen` | `qwen/settings.example.json` (+ `settings.hosted.example.json`) |
| Kimi Code | `kya connect kimi` | `kimi/mcp.example.json` |
| MastraCode | `kya connect mastracode` | `mastracode/mcp.example.json` |
| Amp | `kya connect amp` | `amp/settings.example.json` |
| GitHub Copilot CLI | `kya connect copilot` | `copilot/mcp-config.example.json` |
| Cline | `npm install -g @shield-agent/kya@latest`, then the steps in [`llms-install.md`](../llms-install.md) | `cline/cline_mcp_settings.example.json` |
| Droid | `droid mcp add` (schema unverified) | `droid/mcp.example.json` |
| Pi · OMP · Devin · Hermes · Qoder · Maki · Muse · Antigravity | `kya wrap --offline -- <cmd>` | [docs/hosts/](hosts/) |

## Cursor plugin

The package includes `.cursor-plugin/plugin.json`, `mcp.json`, and a wrap skill. Public listing repo: https://github.com/The-Pixel-Boys/shield-kya
