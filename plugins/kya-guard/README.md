# KYA Guard (Claude Code plugin)

KYA Guard checks every tool call before it runs. It stops destructive commands (`terraform destroy`, `DROP TABLE`, `git push --force`, `rm -rf ~`), reads of credential files, secrets written into files, and secrets sent over the network. For a few commands that are fine on a local database and bad on a remote one (`prisma migrate reset`, `DELETE FROM` with no `WHERE`, `rm -rf .`) it asks you first, even in auto-accept mode.

The check is local and offline. If the guard itself fails (bad input, a crash, a broken file), the tool call goes ahead and the guard writes one line with `outcome: error` to the trail. It never blocks work because it is broken.

```text
/plugin marketplace add The-Pixel-Boys/shield-kya
/plugin install kya-guard@shield-kya
```

## What you get

- One file: `dist/guard.mjs`. No dependencies. No install step. No network call, ever.
- One hook: `PreToolUse`, matcher `*`, timeout 5 s. No `SessionStart` hook.
- Two commands. `/kya-guard:status` shows the rules loaded, the calls seen and blocked in 7 days, the last three blocked rules (with a plain label for each), and how to allow one. `/kya-guard:share` makes a card (a 1200 by 630 SVG with the rule id, the host and the date, nothing private) about the last call the guard denied, saves it in `~/.kya/cards/`, and prints a two-line caption to post. Nothing is uploaded.
- One write while it guards: a line per call appended to `~/.kya/trail.jsonl`. It never edits Claude Code settings. `/kya-guard:share`, run by you, also writes the card file in `~/.kya/cards/`.

## Requirement: Node.js 22 or later on PATH

The hook runs `node`. Claude Code does not include Node.js: the native installer, Homebrew and WinGet install a single binary. If Claude Code came through npm, Node.js is already there. Otherwise install Node.js 22 or later from nodejs.org.

If `node` is missing, Claude Code cannot start the hook. A hook that does not start does not block the call, so the call runs unguarded. Check with `node --version` in the shell that starts Claude Code. `/kya-guard:status` says so when `node` is missing.

## Allow a rule

Edit `~/.kya/config.json` yourself, in your own editor. The agent cannot change that file. Add an entry with the rule id and one exact path or command:

```json
{ "guardAllow": [ { "rule": "secret-write-aws", "path": "/abs/path/to/docs/aws-example.md" } ] }
```

A file inside a project cannot lift a deny. A broken `config.json` is ignored and the defaults apply. `/kya-guard:status` shows the problem. Rule ids and options: [guard pack](../../docs/guard-pack.md).

## Read the trail

The trail is the same file the full CLI reads. For the full report run `npx @shield-agent/kya receipt --open`.

Do not install `kya` and `kya-guard` together. Both would write a row for every call.

## Remove

`/plugin uninstall kya-guard@shield-kya`. The plugin leaves no file behind except `~/.kya/trail.jsonl`, which is your record. Delete it if you do not want it.

Reviewer sheet: [SECURITY.md](SECURITY.md). Licence: MIT.

Other coding agents (Codex, Cursor, Copilot CLI, Gemini CLI): [HOSTS.md](HOSTS.md). Directory submission pack: [submission/](submission/README.md).
