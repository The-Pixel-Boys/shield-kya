# GitHub Copilot CLI

Wire KYA into [GitHub Copilot CLI](https://docs.github.com/copilot) so every tool call the agent makes passes Shield's evaluate first. Allow runs, Deny stops, Hold waits for a person.

There are two ways in. The plugin records every tool call through Copilot's hooks and also starts the MCP server. `kya connect copilot` wires only the MCP server.

## Plugin

**Check first.** If the public repo has no `plugins/kya-copilot` folder yet (every release before the one that ships it), do not install the plugin in Copilot: `kya@shield-kya` then resolves to the Claude Code plugin, and Copilot CLI 1.0.98 denies every tool call with it ("Denied by preToolUse hook ... (hook errored)"). If you already did, `copilot plugin uninstall kya@shield-kya` and use [Setup (MCP only)](#setup-mcp-only) until a release ships the folder.

From that release on:

```bash
copilot plugin marketplace add The-Pixel-Boys/shield-kya
copilot plugin install kya@shield-kya
```

The plugin is advisory and fails open: it records tool calls in the local record (trail) (`~/.kya/trail.jsonl`) and blocks nothing beyond the never-list. It evaluates offline, with no hosted plane, no key and no Hold.

Which plugin Copilot gets: Copilot looks for the marketplace file in `marketplace.json`, `.plugin/marketplace.json`, `.github/plugin/marketplace.json`, then `.claude-plugin/marketplace.json` (its documented order). This repo ships `.plugin/marketplace.json`, which points `kya` at `plugins/kya-copilot`. Claude Code reads `.claude-plugin/marketplace.json` and Codex `.agents/plugins/marketplace.json`; both keep loading `plugins/kya`, which has no Copilot files.

What Copilot loads from `plugins/kya-copilot/`:

| File | What it does |
|------|--------------|
| `plugin.json` | Agent Plugins v1 manifest (the format the awesome-copilot list checks). |
| `com.github.copilot/hooks/hooks.json` | `SessionStart` runs `scripts/bootstrap.mjs` (a copy of the Claude plugin's, kept identical by a test), which installs the pinned kya once into the plugin data dir (`~/.copilot/plugin-data/shield-kya/kya`). `PreToolUse` (every tool) runs a `bash` command, see below. |
| `mcp.json` | The `shield-kya` MCP server from that same copy, offline, with no hosted-plane URL and no key. |

Copilot denies a tool call whenever a pre-tool command hook exits non-zero (a timeout is the only exception). kya promises the opposite, so:

- The hook command is `command -v node >/dev/null 2>&1 || exit 0; node "$PLUGIN_ROOT/scripts/copilot-hook.mjs"; [ $? -eq 2 ] && exit 2; exit 0`. Without `node` on Copilot's `PATH` it does nothing: calls proceed, nothing is recorded. Any exit other than `2` (a broken `node`, a missing wrapper) becomes `0`. **Recording needs Node.js 22 or later on that `PATH`.**
- `copilot-hook.mjs` runs `kya hook --host copilot` and forwards only a real never-list deny (exit `2` plus a deny decision, with the reason in the top-level `permissionDecisionReason` Copilot reads). It exits `0` when kya is not installed yet, bootstrap failed, kya crashed, printed no deny decision, or ran past 4 s.

Things to know:

- The never-list does not match Copilot's MCP tool names yet. Copilot sends them as `<server>-<tool>` with dots turned into dashes (observed in 1.0.98: `shield-kya-kya-policy_evaluate`; a Postgres `drop_table` would arrive as `postgres-drop_table`). They are recorded, not blocked. Copilot's own tools arrive under Claude names (`bash` as `Bash`, `create` as `Write`).
- First session: the MCP server starts before `SessionStart` has installed kya, so it fails once. From the second session on it starts normally.
- Copilot does not show `SessionStart` messages, so a failed bootstrap is silent: tool calls proceed and nothing is recorded. Check that `~/.copilot/plugin-data/shield-kya/kya/node_modules/@shield-agent/kya/package.json` exists.
- Record rows from the plugin show the product as `other`, not `Copilot`.
- **Do not install it on Windows yet.** The pre-tool hook has only a `bash` form and has not been run on Windows; use `kya connect copilot` there.
- `copilot plugin uninstall kya@shield-kya` removes it (a plugin from a local marketplace path is only turned off). Your record under `~/.kya/` stays.

Trust: the plugin runs scripts from this repo and installs the pinned kya from npm. Copilot 1.0.98 asked no trust question before running plugin hooks (observed). Whether it updates marketplaces on its own is not verified; review changes before `copilot plugin update`.

Observed in Copilot CLI 1.0.98 only, not documented by GitHub: hook `args` expand `${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${COPILOT_PLUGIN_DATA}` but leave `${PLUGIN_DATA}` literal; the hook env has `PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `COPILOT_PLUGIN_DATA`. The plugin relies on these, so a later Copilot release may need changes.

If you also ran `kya connect copilot`, both MCP entries are named `shield-kya`. GitHub documents that a plugin's server takes precedence over one you installed earlier; not tested here. Remove one of them.

## Setup (MCP only)

```bash
kya connect copilot
```

That writes a `shield-kya` entry into `~/.copilot/mcp-config.json` under `mcpServers`. The CLI reads this file for its MCP servers.

There's no project-scope target in the registry, so `kya connect copilot --project` exits with a usage error. Global scope only today.

Restart Copilot CLI after connecting. MCP servers load at startup.

Prefer editing by hand? Copy [`copilot/mcp-config.example.json`](../../copilot/mcp-config.example.json) into place and merge the `mcpServers` section yourself.

## What KYA reports

Every tool call Copilot routes through MCP lands on the receipt: tool id, decision (Allow / Deny / Hold), timestamp, and a clipped, redacted preview of what would change. Open it with `kya receipt --open`.

## Files written

| Scope | Path |
|-------|------|
| Global | `~/.copilot/mcp-config.json` |

Connect merges. Your other MCP servers stay as they were. If the existing file doesn't parse as JSON, connect stops and tells you. It never overwrites a config it cannot read.

## Verify

1. Restart Copilot CLI.
2. Ask the agent to list its MCP tools. `kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval` should appear.
3. Offline smoke, no cloud needed:

   ```bash
   kya wrap --offline --tool-id Write --irreversible --args '{"path":"x.ts","content":"hi"}'
   ```

   Expect a `REQUIRE_APPROVE` row in the record (`--irreversible` without a policy never auto-allows).

## Uninstall

Edit `~/.copilot/mcp-config.json` and delete the `shield-kya` entry under `mcpServers`. Nothing else is installed: no daemon, no background process. (`kya connect copilot --force` rewires the entry if you only want to refresh it.)

## Troubleshooting

- **Server not listed in Copilot.** Restart the CLI. MCP servers load at startup, not hot.
- **`command not found` errors.** Connect wires `node …/cli.js serve-mcp --stdio` from the install you ran it from. If you connected via a temp `npx` cache and later cleared it, rerun `kya connect copilot --force` from a real install (`npm i -g @shield-agent/kya`).
- **`--project` fails.** Expected: no project-scope config is wired for Copilot. Use the global file.
- **Decisions need a key.** The wired env sets `KYA_OFFLINE=1`, so the server starts keyless and sample-evaluates. Against an authenticated control plane, set `KYA_API_KEY` in the entry's `env` block.

## Honesty note

Copilot decides which tools go through MCP. KYA gates the ones that do. A tool Copilot executes outside MCP is outside the gate. Do not treat this setup as full coverage of the agent.

## Wrap fallback

Works with or without MCP:

```bash
kya wrap --offline -- copilot suggest "write the test"
```

Wrap evaluates the command itself before it runs and records a row in the record. Use it for hosts, shells, or scripts that never speak MCP.
