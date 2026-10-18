# Claude Code plugin

Audit trail and traceability for AI agents. See what every coding agent did.

This repo is also a Claude Code plugin marketplace named `shield-kya`. It ships one plugin, `kya`.

## What the plugin does, and does not do

- It records every tool call in the local record (trail) (`~/.kya/trail.jsonl`).
- It blocks only the small never-list (for example `mcp__postgres__drop_table`). Everything else is allowed and recorded.
- It is advisory and fails open: if kya is missing, crashes or times out, the tool call proceeds and nothing is recorded.
- The hook evaluates locally. It makes no hosted-plane calls, so it has no Hold tickets and no human sign-off.
- Hosted-plane enforcement today is the MCP/gateway path (`kya.policy_evaluate`, see [claude.md](claude.md)). A separate hosted-plane hook (beta) evaluates each call on your workspace and denies when the plane cannot answer. It is not part of this plugin; see [hosted-hook.md](../hosted-hook.md).

## Install (one user)

```text
/plugin marketplace add The-Pixel-Boys/shield-kya
/plugin install kya@shield-kya
```

Or from a shell: `claude plugin marketplace add The-Pixel-Boys/shield-kya`, then `claude plugin install kya@shield-kya`.

The plugin ships three things:

1. **SessionStart** runs `scripts/bootstrap.mjs`. It installs the pinned `@shield-agent/kya` once into `${CLAUDE_PLUGIN_DATA}` (about 6 s) and checks it on later sessions (files, version, and a load check). It never edits your settings or permissions.
2. **PreToolUse** (every tool) runs `node ${CLAUDE_PLUGIN_DATA}/node_modules/@shield-agent/kya/dist/cli.js hook --host claude`. No npx and no npm or registry traffic at hook time. The hook costs about 0.2 s per tool call.
3. **MCP server** `shield-kya`, started from the same installed copy (`serve-mcp --stdio`).

The MCP server in this plugin sets `KYA_OFFLINE=1`, `KYA_BASE_URL=http://127.0.0.1:1` and an empty `KYA_API_KEY`. What that guarantees: neither the hook nor the server makes hosted-plane calls, because the only control-plane URL they know is an unroutable loopback port and they have no credential. `kya.session_ingest` and the Hold-request tool still try that URL and fail locally; they do not stay offline by themselves (making `--offline` refuse them in `serve-mcp` is a CLI follow-up). What it does not guarantee: no network at all. A notify webhook in the user config or in a project's `.kya/config.json` receives record fields (tool id, decision, reason, session) when a call is denied, from both the hook and the MCP server; OTLP export and opt-in telemetry can also send. Review `.kya/config.json` in repositories you open, and see [telemetry.md](../telemetry.md) and [otlp.md](../otlp.md). For the hosted plane, connect it yourself (see [claude.md](claude.md)).

Every pin and manifest `version` follows `package.json`; `pnpm sync:version` rewrites them and `node scripts/check-version-pins.mjs` checks them.

### Install hardening and limits

The bootstrap runs `npm install` into a staging directory inside the plugin data directory with an exact version pin (strict semver, no ranges), `--registry=https://registry.npmjs.org/`, empty `--userconfig` and `--globalconfig` files (fresh, mode 0600), every `npm_config_*` variable and `NODE_OPTIONS` removed from the npm process, and `--ignore-scripts --omit=optional`. It checks the staged copy (version, `dist/cli.js`, and a `--help` load check) and only then swaps it into place. The swap is a pair of renames, so a hook that starts in that instant fails open once; hooks never see a half-written tree, and a failed upgrade leaves the working copy in place (you get an `update failed, keeping the previous version` notice instead of `NOT recording`). A lock keeps concurrent sessions from installing twice; it is released on exit and on SIGTERM/SIGINT, and a lock older than 150 s is treated as stale.

Known limits: there is no sha512 integrity pin and no `npm-shrinkwrap.json` inside the kya package yet (planned follow-up), so transitive dependency ranges resolve fresh on each machine. `HTTPS_PROXY`, `HTTP_PROXY` and `NODE_EXTRA_CA_CERTS` are honored, because corporate hosts need them, and until the integrity pin lands they are part of the trust you place in the host environment. A corporate registry mirror is not honored (the install goes to the public registry).

### Requirements and what you see when something is wrong

Node.js 22+ (24 recommended) and `npm` on the PATH of the machine that runs Claude Code. Claude Code itself does not need Node, but this plugin does: its hooks run `node` from that PATH. A Claude Code started from a GUI (Dock, Start menu) may not see the PATH your shell gets from nvm or fnm, so check there first. On Node 20 or 21 the plugin installs and the hook runs, with a one-line `unsupported but works` notice at every session start; on Node 18 or older the notice says it is not supported. Node 22 and newer print nothing.

- npm missing, install failing, a partial install, or another session installing at that moment: SessionStart prints `Shield KYA is NOT recording: <reason>` and the session continues. A partial install is replaced by a fresh, verified one.
- `node` itself cannot start (for example a GUI launch without Node on PATH): no script can run, so no KYA message can print. SessionStart is marked `onFailure: "block"`, so Claude Code shows its own hook-failure error for that hook (Claude Code 2.1.295 or later), and PreToolUse tool calls proceed unrecorded.

Host trust assumption: the hook and bootstrap run under whatever `node` and environment Claude Code gives them. `NODE_OPTIONS` or a PATH shim in that environment acts on node itself, before any plugin script runs, so no command hook can defend against it. Keep the process environment under your control.

## Roll out to a team (project settings)

Run `kya team init` at the repository root and commit the `.claude/settings.json` it writes. It merges these two keys and keeps the rest of the file (`--dry-run` shows the change first):

```json
{
  "extraKnownMarketplaces": {
    "shield-kya": {
      "source": { "source": "github", "repo": "The-Pixel-Boys/shield-kya", "ref": "vX.Y.Z" }
    }
  },
  "enabledPlugins": { "kya@shield-kya": true }
}
```

`vX.Y.Z` is the release tag that matches the kya you ran (needs the first kya release that includes `kya team`; `kya --help` lists `team init` when yours has it). Write a tag here, never a branch: this file decides what runs on every teammate's machine. A tag is still not fixed: anyone with write access to the public repository can move it, Claude Code's GitHub marketplace source has no commit `sha` pin, and the public repository has no tag protection rule today (a `v*` tag ruleset is recommended). The command makes no network call; check the tag exists with `git ls-remote https://github.com/The-Pixel-Boys/shield-kya refs/tags/vX.Y.Z` (if it does not, the plugin is skipped, not reported as an error).

What a teammate sees:

- **Interactive:** after they accept the workspace trust dialog for the folder, Claude Code registers the marketplace and installs and enables the plugin at the next session start.
- **Untrusted folder:** the `extraKnownMarketplaces` entry is ignored silently: the marketplace is not added from this file, and there is no message.
- **`claude -p` and CI:** the entry applies only in a folder whose trust was already accepted interactively (or `hasTrustDialogAccepted` is set in `~/.claude.json`). Installs run in the background, so the first turn can miss the plugin; set `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` to wait for it.

Full guide (refusals, pin upgrades, supply-chain notes, undo): [team-rollout.md](../team-rollout.md).

## Roll out to an organization (managed settings)

`kya team managed-settings` prints the same two keys with the same tag pin. Admins deploy them on every machine with `managed-settings.json` (macOS `/Library/Application Support/ClaudeCode/`, Linux and WSL `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`), MDM, or server-managed settings. Users cannot disable a managed plugin.

To restrict users to your marketplace, pair this with `strictKnownMarketplaces`, copying the exact source including its `ref`; see [team-rollout.md](../team-rollout.md) and the [organization guide](https://code.claude.com/docs/en/plugins/org). This rollout is advisory like the plugin itself.

## Hosted-plane hook for a fleet (beta, managed settings)

The plugin hook above is local only. For the hosted-plane hook, wire it per user with `kya connect claude --hooks --hosted --plane-config <absolute path>`, or deploy it in managed settings. A repository's `.claude/settings.json` can set `"disableAllHooks": true`, which turns off user and plugin hooks but not managed ones. `allowManagedHooksOnly` (managed settings only) blocks every hook that managed settings did not deploy, including this plugin's hooks unless the plugin is force-enabled there.

```json
{
  "allowManagedHooksOnly": true,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"/usr/local/bin/node\" \"/usr/local/lib/node_modules/@shield-agent/kya/dist/cli.js\" hook --host claude --plane-config \"/Users/you/.kya/hosted.json\"",
            "timeout": 5,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

`onFailure` needs Claude Code 2.1.295 or later. The config file format, the beta limits and the full behaviour table are in [hosted-hook.md](../hosted-hook.md).

## Already ran `kya start`?

`kya start` writes a user-level hook. With the plugin enabled too, Claude Code runs both copies for each tool call. kya 0.23.2 and later write one record row per `tool_use_id` (a marker under `~/.kya/hook-seen/`), so you get one row. Known limit: a global kya at 0.23.1 or older never creates the marker, so you get two rows per call until you update it (`npm i -g @shield-agent/kya`). Decisions are identical, so a deny is never lost.

## GitHub Copilot CLI

Do not install this plugin in Copilot CLI. Copilot CLI 1.0.98 runs its hooks in a way that fails, and then denies every tool call ("hook errored"). In every release before the one that ships `plugins/kya-copilot`, that is what `copilot plugin install kya@shield-kya` gives you, because Copilot reads `.claude-plugin/marketplace.json` when nothing else is there. Releases that ship `plugins/kya-copilot` add `.plugin/marketplace.json`, which Copilot reads first, so the same command gives a Copilot-specific plugin. See [copilot.md](copilot.md#plugin). Until then, use `kya connect copilot`.

## Uninstall

```text
/plugin uninstall kya@shield-kya
/plugin marketplace remove shield-kya
```

Uninstalling from the last scope deletes `${CLAUDE_PLUGIN_DATA}` (the installed kya copy). Your local record under `~/.kya/` stays; delete it if you want it gone. A repository that lists the plugin in `.claude/settings.json` re-enables it for teammates until the entry is removed there.

## Troubleshooting

- `/plugin` shows the plugin enabled but nothing is recorded: look for the `Shield KYA is NOT recording` message at session start; check `node --version` (22+) and that `npm` is on PATH, then restart the session.
- First session after install: bootstrap runs at session start. If the MCP server shows as failed in that very first session, run `/reload-plugins` or start a new session.
- Check the record: `kya receipt --q Read --json`, or open `~/.kya/trail.jsonl`.
