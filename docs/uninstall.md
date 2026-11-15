# Undo `kya start`: `kya uninstall`

`kya start` is fully reversible with one command.

## What `kya start` shows and asks

1. **Plan.** Before it writes, `kya start` prints each file, whether it is created or merged, and the exact keys, tables or lines it adds.
2. **One question.** In a terminal it asks `Apply? [Y/n]`. `--yes` or `KYA_YES=1` skips the question. Off a terminal (a pipe, a script) or when `CI` is set, it applies only with `--yes`. Without `--yes` it prints the plan, writes nothing and exits 0. `--json` is not interactive: it needs `--yes` too.
3. **Dry run.** `kya start --dry-run` prints the plan and writes nothing (same flag as `kya team init --dry-run`).
4. **Write less.** `kya start` writes config only for hosts found on this machine. It does not write `.cursor/mcp.json` when Cursor is absent. It no longer writes the generic project `mcp.json`. It does not write `.env.example` or `.kya/tools.sample.json` (use `kya init`) or `orr-report/` (use `kya orr run`). The report server that `kya start` spawns does not create `orr-report/` either.
5. **Git.** In a git repository it appends two lines to `.gitignore` once and lists them in the plan: `.kya/*` and `!.kya/policy.json`. The second line keeps the team policy that `kya team init` tells you to commit. If `.gitignore` already hides the folder (`.kya`, `.kya/`, `.kya/*` or `.kya/**`, each with or without a leading slash) it is left as it is.

If every file is already wired, there is nothing to consent to: `kya start` skips the question and only starts the report.

## The manifest

Every write by `kya start` and `kya connect` is recorded in `~/.kya/manifest.json` (mode 0600). The record is written before each file changes, under a lock file (`~/.kya/manifest.lock`), so an interrupted `kya start` or two starts at once still leave a manifest that `kya uninstall` can use. It holds the path, the action (`created` or `merged`), the keys added, the keys and TOML tables removed (gateway routing), and, for merged files, a backup of the original in `~/.kya/undo/`. The backups are copies of your old host config files, so they can hold tokens: they are mode 0600 in a 0700 directory. `kya uninstall` deletes each backup once its file is undone. The record also holds the sha256 of what KYA wrote, so undo can tell "unchanged since" from "edited since". If KYA writes a file again after it was edited (for example `kya start --force`), the entry is marked stale: undo then removes only KYA's keys and never restores the old backup or deletes the file, so your edits are kept. KYA's own data (the trail, report files, telemetry state) is not in the manifest.

## Undo

The manifest decides what is deleted and written, so `kya uninstall` does not trust it blindly. It refuses to run (exit 1) when `manifest.json` is not a regular file, is not mode 0600, is not owned by you, or has the wrong shape. For each entry it accepts only the files `kya start` and `kya connect` write (host configs, hook files, project `.mcp.json` and `.cursor/mcp.json`, `.claude/settings.json`, `.gitignore`, `.kya/config.json`, `~/.kya/bin/kya-hook`, `~/.kya/gateways.json`), a backup only under `~/.kya/undo/`, and it refuses a path that is now a symlink or a hard link, or whose parent directory was replaced by a link. Project files go through the same path guard as `kya start`. A refused or failed entry (for example `EACCES`) is listed under "Left alone" with its backup path, stays in the manifest, and does not stop the other entries; run `kya uninstall` again after you fix it.

```bash
kya uninstall             # everything in the manifest
kya uninstall --project   # only files under the current directory
kya uninstall --dry-run   # show what it would do
```

For each file:

| State | What `kya uninstall` does |
|---|---|
| Merged, unchanged since KYA wrote it | Restores the original from the backup, byte for byte. |
| Merged, edited since (Claude Code rewrites `~/.claude.json` often) | Removes only the keys, hook entries, TOML tables or `.gitignore` lines KYA added. Puts back servers the gateway moved (JSON keys and TOML `[mcp_servers.<id>]` tables) from the backup. If the backup cannot give one back, it keeps the backup and the entry and says so. Your other changes stay. |
| Created, unchanged | Deletes it. Removes directories KYA created if they are empty. |
| Created, edited since | Leaves it and says so. |

It prints what it left alone, with the backup path for each file. It does not delete `.kya/` (your activity trail and report files) or the state in `~/.kya/`. The background report server keeps running until you run `kya stop`. Hooks and MCP entries written by a kya version before the manifest (before 0.35) are not listed: remove the `shield-kya` entries by hand.

## The hook launcher

The OSS hook command is `"<home>/.kya/bin/kya-hook" hook --host <id>`. The launcher (a POSIX shell script) runs the node and `cli.js` recorded at start. If those paths are gone (a Node version switch), it uses `node` and then `kya` from `PATH`. If none works it prints one line to stderr and exits 0, so it never blocks a tool call (the local hook is advisory and fails open). The hosted hook keeps direct paths: it must stay fail-closed. On Windows the hook keeps absolute paths. The launcher only runs a `node` or `kya` found under an absolute `PATH` entry (a relative or empty entry such as `.` is skipped), and `kya start` refuses to write a hook whose home path holds `$`, a backtick or a quote, because the shell would expand it.

`kya doctor` checks the launcher and the hook commands in the host configs. It flags a path that does not exist, because a dead hook fails open with no other notice. To refresh the launcher, run `kya start --force`.

## Scripts and CI

Pass `--yes` (or set `KYA_YES=1`) wherever a script must keep writing config: `kya start --yes --no-open`. Without it, a non-terminal run now prints the plan and writes nothing.
