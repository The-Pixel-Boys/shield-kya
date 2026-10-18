# Roll the Claude Code plugin out to your team

Audit trail and traceability for AI agents. See what every coding agent did, for everyone on the team.

Two ways to spread the `kya` plugin (see [hosts/claude-plugin.md](hosts/claude-plugin.md) for what the plugin does):

- **Per repository:** `kya team init` writes the project's `.claude/settings.json`. A teammate who opens the repository in Claude Code, accepts the folder trust prompt, and has Node.js 22+ and `npm` gets the plugin, provided the pinned release tag exists on the public repository (see below).
- **Per organization:** `kya team managed-settings` prints the managed-settings JSON an admin deploys to every machine.

Requires the first kya release that includes `kya team`. To check yours, run `kya --help`: versions that have it list `team init`; older ones answer `Unknown command: team`.

This is OSS advisory mode. The plugin records every tool call on the local record (trail), blocks only the small never-list, and fails open (if kya is missing or broken, the tool call proceeds unrecorded). Rolling it out does not change that. Hosted enforcement is a separate product and is not configured by these commands.

## Per repository: `kya team init`

Run it at the repository root:

```bash
kya team init --dry-run   # show the change, write nothing
kya team init             # write .claude/settings.json
git add .claude/settings.json && git commit -m "chore: enable the kya Claude Code plugin"
```

It merges two keys into `.claude/settings.json` and keeps every other key and the file's indentation:

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

`vX.Y.Z` is the version of the kya you ran, read from its `package.json` at runtime (the command prints it), so the marketplace is pinned to that release tag, never to a branch. Run `kya team init` again after you upgrade kya to move the pin; it only rewrites the `ref`. If the file already pins a newer tag than your kya, the change list says `downgrade` so you notice before committing.

The command makes no network call, so it cannot check that the tag exists. Do it once before you commit:

```bash
git ls-remote https://github.com/The-Pixel-Boys/shield-kya refs/tags/vX.Y.Z
```

No output means the tag is missing. Public release tags are created per release; `v0.24.0` and `v0.24.2` exist, `v0.24.1` was never published to the public repository and has no tag.

What it does and does not do:

- It writes only `<project>/.claude/settings.json`. It never touches `~/.claude`, `settings.local.json`, permissions or any other file, and makes no network calls.
- It refuses, and writes nothing, when the file is not valid JSON, when `.claude` or `settings.json` is a symlink or not a regular directory or file, when the project `.claude` is your user-level Claude Code directory (for example, run from your home directory), when `shield-kya` already points at a different source, or when someone set `"kya@shield-kya": false` (change that by hand if you want it on).
- It does not require a git work tree. Claude Code's trust prompt is per folder, not per repository, so the settings work the same in any folder.
- A second run with nothing to change leaves the file untouched.

What a teammate sees after pulling the commit:

- **Interactive:** Claude Code shows its folder trust prompt once. After they accept it, the `shield-kya` marketplace is added and `kya@shield-kya` installs at the next session start. Nothing is accepted on their behalf.
- **Untrusted folder:** the marketplace is not added from this file, without a message. (`enabledPlugins` still applies, so a teammate who registered `shield-kya` themselves can still get the plugin.)
- **`claude -p` and CI:** the marketplace entry applies only in a folder whose trust was already accepted interactively (or has `hasTrustDialogAccepted` in `~/.claude.json`). Installs run in the background, so the first turn can miss the plugin; set `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` to wait for it.
- **`Remote branch vX.Y.Z not found`** in `/plugin` or in `claude -p --output-format stream-json --verbose` output: the release tag is not on the public repository. The plugin is skipped, not reported as an error, and the session continues without it (fail open). Pin a kya version whose tag exists, or wait for the tag.
- Each machine still needs Node.js 22+ (24 recommended) and `npm` on the PATH; see [hosts/claude-plugin.md](hosts/claude-plugin.md).

## Per organization: `kya team managed-settings`

```bash
kya team managed-settings > kya.json
```

It prints the same two keys with the same tag pin. Recommended for file-based policy: drop the output into the `managed-settings.d/` directory next to `managed-settings.json` (macOS `/Library/Application Support/ClaudeCode/`, Linux and WSL `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`), for example as `managed-settings.d/kya.json`, instead of editing a shared `managed-settings.json`. A managed or drop-in file that is not valid JSON makes Claude Code refuse to start, so validate it. Server-managed settings and MDM work too; when server-managed settings deliver any policy key, file and MDM plugin keys are ignored unless `managedSourcesBehavior` is `"merge"` (see [managed settings](https://code.claude.com/docs/en/managed-settings)). Users cannot turn off a plugin that managed settings enable.

Not in the output, on purpose:

- `strictKnownMarketplaces` (allowlist of marketplace sources). An entry must match the `ref` exactly, so an entry without the tag does not cover this pinned marketplace, and any allowlist also shuts out the official marketplace and skills-directory plugins unless you list them. If you use it, copy the exact source from the output, for example `{ "source": "github", "repo": "The-Pixel-Boys/shield-kya", "ref": "vX.Y.Z" }`, and update it with each pin.
- `allowManagedHooksOnly`. It changes which hooks run for everyone and is a policy decision for your organization, not something a plugin install should set.

See the [organization guide](https://code.claude.com/docs/en/plugins/org) for both.

## Supply chain: what the pin protects and what it does not

A committed settings file that enables a plugin decides what code runs on every teammate's machine. Treat it like a dependency.

- The pin is a release tag, which is safer than a branch, but **it is not fixed**: anyone with write access to the repository can move or delete a git tag. Claude Code's GitHub marketplace source accepts a `ref` (branch or tag) and no commit `sha`, so there is no stronger pin today.
- Today the public repository `The-Pixel-Boys/shield-kya` has no tag protection rule (its only ruleset protects the `main` branch). We recommend a `v*` tag ruleset that blocks updates and deletion. Until then, a moved tag would change what runs on your machines at the next marketplace refresh.
- If you need a pin nobody else can move, mirror the repository into your own organization, tag it there, and point `repo` and `ref` at your mirror.
- The plugin's SessionStart step installs the exact `@shield-agent/kya` version named in that release from the public npm registry; see "Install hardening and limits" in [hosts/claude-plugin.md](hosts/claude-plugin.md) for what is and is not verified.
- No secrets go into either file. Keep API keys in the environment, never in `.claude/settings.json`.
- Review changes to `.claude/settings.json` and to `.kya/config.json` in pull requests like any other code: a changed `ref` or `repo` changes what runs. A `.kya/config.json` notify webhook receives record fields on denied calls.

## No `.kya/config.json` is written

The OSS baseline is observe mode, which is what kya does when `.kya/config.json` has no `gateMode`. The only gate key that file supports is `gateMode` (`hold` or `offline`), and neither is an advisory baseline, so `kya team init` leaves it alone.

## Undo

Remove the `shield-kya` entry and the `kya@shield-kya` line from `.claude/settings.json` and commit. Each teammate can then run `/plugin uninstall kya@shield-kya`.

## For contributors: the manual end-to-end check

CI runs the unit and integration tests. The end-to-end check against a real Claude Code is opt-in, because it needs the `claude` CLI and reaches GitHub and npm for the plugin bootstrap. It makes no model call (the API base URL is a dead loopback port) and uses temporary HOME directories only:

```bash
pnpm build && KYA_CLAUDE_E2E=1 npx vitest run test/team.test.ts
```

A team lead runs `kya team init` and commits; a second user with a clean HOME and a fresh clone starts `claude -p`. It checks that the plugin loads from the pinned tag and that an untrusted folder adds no marketplace. It does not automate the folder trust prompt (trust is seeded through `hasTrustDialogAccepted`) and it serves the marketplace from a local git copy at the tag rather than from GitHub.
