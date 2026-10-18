# VS Code, Cursor and Open VSX editors (Shield KYA extension)

The `vscode/` folder of this repo is a VS Code extension, **Shield KYA**. It shows what kya recorded for every coding-agent tool call, inside the editor. It works in VS Code 1.101+ and in forks that install extensions from Open VSX, such as Cursor.

It is a viewer and a launcher, not a gate. Local kya is advisory: it records every tool call, blocks only the never-list and fails open (an error lets the call through). Enforcement (fail-closed hooks, Hold tickets, approvals) is the hosted product.

## Install

The extension is not yet listed on the VS Code Marketplace or Open VSX. Build and install the `.vsix` from source:

```bash
git clone https://github.com/The-Pixel-Boys/shield-kya && cd shield-kya/vscode
pnpm install --frozen-lockfile && pnpm package
code --install-extension dist/shield-kya.vsix      # Cursor: cursor --install-extension dist/shield-kya.vsix
```

It needs an installed kya (`npm i -g @shield-agent/kya`, Node.js 24+). `kya start` wires your agent hooks and starts the record (trail).

## What you get

- **Verdicts** view: a live tail of `~/.kya/trail.jsonl` (or `$KYA_HOME/.kya/trail.jsonl`, or `shieldKya.trailPath`).
  - Rows show ALLOW, REVIEW, HOLD and DENY. Never-list denies are marked.
  - Previews are the redacted, clipped text kya stores, and the extension redacts them again before display.
  - REVIEW means kya recorded `REQUIRE_APPROVE` with no Hold path armed. An advisory hook let the call run; a local `--strict` hook denied it, and its rows look the same.
  - HOLD means `REQUIRE_APPROVE` recorded with a Hold or strict path armed (`mode: hold` in the record, written by a hosted strict hook or `kya wrap --hold`). The call was held or denied pending a human.
- **Status bar**: gate mode plus ALLOW/REVIEW/HOLD/DENY the counts over the last 200 rows (the rows the Verdicts view shows). A never-list deny seen since the extension last loaded the record (activation, Refresh, or a truncated or rotated file) keeps the status bar red. An unreadable record shows "trail unreadable" there and pauses only the feed.
  - The mode comes from the user-level kya hook commands that `kya connect <host> --hooks` writes (`~/.claude/settings.json`, `~/.grok/hooks/shield-kya.json`, `~/.kimi-code/config.toml`), and from the Claude Code plugin enabled in `~/.claude/settings.json` (`kya@shield-kya`, advisory).
  - `advisory` means no `--strict`. `strict` means `--strict`, `--fail-closed` or `--plane-config`.
  - `unknown` means nothing visible is wired but the record has recent rows. The Codex and Gemini plugins and project-level wiring are not inspected.
- **Shield KYA: Connect this workspace**: you pick a host (Cursor, Claude Code, OpenCode, Kilo, Kiro, Qwen, Kimi, MastraCode) and confirm. The extension then runs `kya connect <host> --project` in the folder. Nothing is written without the confirmation.
- **MCP server**: the installed kya (`kya serve-mcp --stdio`, offline evaluate) is offered to the editor's agent. VS Code gets it through its MCP server definition provider API, Cursor through `vscode.cursor.mcp.registerServer`. Setting: `shieldKya.mcp.enabled`.
- **Hosted approvals** (off by default, `shieldKya.hosted.enabled`):
  - Lists your org's pending approvals.
  - Approves or rejects one after a confirmation. That needs a user token with the `kya.approve` scope.
  - The key is stored with "Shield KYA: Set hosted API key" in VS Code SecretStorage, never in settings.json.
  - A machine key (`sk_...`) can only list. The extension opens the approval in the hosted console instead.

## Security model

- **Runs only the installed kya.** It uses `shieldKya.cliPath`, or else the first `kya` on PATH. Relative PATH entries and anything inside the open workspace are skipped, after resolving symlinks. `node` and kya's `dist/cli.js` are started directly, with no shell and no `npx`.
- **No network unless hosted approvals are on.** Then it only talks to `shieldKya.hosted.baseUrl`, which must be https (http only for localhost), with redirects refused. The extension adds no telemetry; kya's own telemetry stays opt-in.
- **Workspace settings are ignored.** The record path, kya path, hosted switch, hosted URL and MCP switch are user-level settings (`application` scope). A repo's `.vscode/settings.json` cannot set them.
- **Restricted Mode and virtual workspaces.** The feed is read-only. Commands refuse, no kya process starts, MCP is not registered and no hosted call is made.
- **Test seam.** The test API exists only when VS Code loads the extension in test mode (`--extensionDevelopmentPath` with `--extensionTestsPath`). An installed copy exposes nothing to other extensions.

## Known limits

- Cursor: the Cursor MCP extension API path and the install from Open VSX are not yet verified on a real Cursor. Cursor hides an extension whose `engines.vscode` is newer than its own VS Code base; this one asks for 1.101.
- Windows: the PATH lookup handles `kya.cmd` from the npm global prefix, but no Windows run has been done.
- Remote (SSH, containers, WSL): the extension runs where the workspace is (`extensionKind: workspace`), so it reads the record on that machine.
- Dev containers: the container definition (for example `remoteEnv` in `devcontainer.json`) can set `KYA_HOME` and PATH. That decides which record and hook files the extension reads and which kya it finds inside the container. The "user settings only" rule covers the editor settings, not the container's environment. Nothing from the workspace is ever executed by the extension.
- A `~/.claude/settings.json` with comments or trailing commas is not read as JSON, so its hooks and plugins are not seen. The status bar then says `unknown` or `no hook`, never `strict`.
- A hosted hook with `--plane-shadow` counts as advisory: shadow mode records hosted decisions and never blocks.
- Hosted approvals have been tested only against a local stub of the hosted approvals API, not against the live hosted plane. Approve/reject only acts on an approval in the list the plane returned, with the plane's own action text in the confirmation.
