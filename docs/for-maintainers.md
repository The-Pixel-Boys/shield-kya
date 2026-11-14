# For maintainers: guard the agents that work in your repository

This page is for people who run a repository that accepts changes written by coding agents. Back to the [README](../README.md).

## Why a repository wants a guard

A contributor who uses a coding agent gives that agent the shell of their own machine. The agent can run `terraform destroy`,
`DROP TABLE`, `git push --force` or `rm -rf ~`. It can read `~/.aws/credentials`. It can write a key into a file that you then merge.
You do not see these calls in the pull request. You see only the result.

KYA Guard checks each tool call before it runs, on the contributor's machine. It stops these calls and tells the agent why.
It makes no network call, it is one file, and it fails open: if the guard itself breaks, the call goes ahead and the guard writes one error line.
It is advisory. It does not replace review, branch protection or a sandbox.

Public examples of calls it stopped: https://shield-agent.com/replays.

## The one command

Run it at the repository root:

```bash
kya team init --guard --dry-run   # print the diff and the badge, write nothing
kya team init --guard             # write .claude/settings.json
git add .claude/settings.json && git commit -m "chore: enable the kya-guard Claude Code plugin"
```

The command merges two keys into `.claude/settings.json` and keeps every other key. The marketplace is pinned to the release tag of the kya you ran.

```json
{
  "extraKnownMarketplaces": {
    "shield-kya": {
      "source": { "source": "github", "repo": "The-Pixel-Boys/shield-kya", "ref": "vX.Y.Z" }
    }
  },
  "enabledPlugins": { "kya-guard@shield-kya": true }
}
```

- It prints the exact diff of the file, so you review it before you commit.
- It writes no other file, does not touch `~/.claude`, and makes no network call.
- A second run changes nothing. A run after a kya upgrade moves only the `ref`.
- It refuses, and writes nothing, if the file is not valid JSON, if `shield-kya` points to another source, if someone turned `kya-guard@shield-kya` off, or if `kya@shield-kya` is on. The full kya plugin and the guard together would write two rows for every call. Turn one off by hand first.
- The write is recorded in `~/.kya/manifest.json` on your machine. This is what lets `kya uninstall --project` reverse it.
- Check that the tag exists and holds the folder `plugins/kya-guard` before you commit: `git ls-remote https://github.com/The-Pixel-Boys/shield-kya refs/tags/vX.Y.Z`. A tag cut before the guard shipped does not have it, and teammates then see the plugin skipped, not an error.

The command also prints one line for your README. It is a badge that reads "agent-guarded" and links to the public scoreboard:

```markdown
[![agent-guarded](https://img.shields.io/badge/agent--guarded-KYA%20Guard-2ea44f)](https://shield-agent.com/replays)
```

The badge states that the repository asks its Claude Code contributors to run the guard. It does not state that every contributor does.

## What contributors see

- Claude Code shows its folder trust prompt once. After the contributor accepts it, the `shield-kya` marketplace is added and `kya-guard` installs at the next session start. Nothing is accepted for them.
- In a folder that is not trusted, Claude Code does not add the marketplace from this file, and says nothing.
- The contributor needs Node.js 22 or later on `PATH`. Without it the hook cannot start, and calls run unguarded. `/kya-guard:status` says so.
- When the agent tries a stopped call, it gets a short message that names the rule and says what to do instead. A few commands (for example `prisma migrate reset`) ask the contributor first.
- `/kya-guard:status` shows the rules loaded, the calls seen and stopped in the last 7 days, and the last three rules that stopped a call.
- The guard writes one line per call to `~/.kya/trail.jsonl` on the contributor's own machine. It sends nothing to you or to anyone.
- A contributor can allow one rule for themselves in `~/.kya/config.json`. A file inside the repository cannot lift a deny.

Contributors who use Codex, Cursor, Copilot CLI or Gemini CLI install the variant for their host. See [plugins/kya-guard/HOSTS.md](../plugins/kya-guard/HOSTS.md). `kya team init --guard` configures Claude Code only.

## How to remove it

- Reverse the write: `kya uninstall --project` at the repository root. It restores `.claude/settings.json` byte for byte when nobody changed it since, and removes only the two keys when somebody did.
- Or delete the two keys by hand: `extraKnownMarketplaces.shield-kya` and `enabledPlugins["kya-guard@shield-kya"]`. Delete the badge line from the README.
- A contributor who wants it off on their machine runs `/plugin uninstall kya-guard@shield-kya`. The only file left is their own `~/.kya/trail.jsonl`.

Reviewer sheet for the plugin: [plugins/kya-guard/SECURITY.md](../plugins/kya-guard/SECURITY.md). To roll out the full kya plugin instead, see [team-rollout.md](team-rollout.md).
