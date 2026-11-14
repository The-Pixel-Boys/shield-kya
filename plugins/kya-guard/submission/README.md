# KYA Guard: directory submission pack

Everything a directory reviewer or the owner needs. Nothing here is submitted by a script.

| Item | File |
|---|---|
| Description, 50 characters | [description-50.txt](description-50.txt) |
| Description, 150 characters | [description-150.txt](description-150.txt) |
| Description, 500 characters | [description-500.txt](description-500.txt) |
| Screenshot 1: a deny | [screenshots/01-deny.png](screenshots/01-deny.png) (text: [01-deny.txt](screenshots/01-deny.txt)) |
| Screenshot 2: the status command | [screenshots/02-status.png](screenshots/02-status.png) (text: [02-status.txt](screenshots/02-status.txt)) |
| Screenshot 3: the near-miss card | [screenshots/03-card.png](screenshots/03-card.png) (SVG: [03-card.svg](screenshots/03-card.svg)) |
| Reviewer sheet | [../SECURITY.md](../SECURITY.md) |
| Public scoreboard | https://shield-agent.com/replays |
| Two-minute test | [review-test.sh](review-test.sh) |

The one-line description for every channel: "Stops your coding agent from deleting, leaking or dropping things. No network, one file, fails open."
The texts come from `sdks/kya/channel-copy.json` (`guardListing`). A CI check keeps these files equal to it.

The card is real output: `node scripts/guard-screenshots.mjs` replays the PocketOS case (a reconstruction of the public account, see `replays/`) through the bundle in a temporary HOME, runs `guard.mjs --card` (the `/kya-guard:share` command), and renders the SVG to a 1200 by 630 PNG. The card holds the rule id, the host and the date. A test keeps the file equal to a fresh run.

## Run the test

```bash
bash review-test.sh
```

It needs bash and Node.js 22 or later. It uses a temporary HOME, makes no network call and takes about one second.
It runs the bundle on 3 inputs that must be denied and 3 that must be allowed, and checks the exit codes. It also
checks the ask rule, a payload that is not JSON, and the status command. The last line is `PASS: ...` or the number of failed checks.

## Owner steps (not automated)

1. Claude directory: submit `kya-guard` at claude.ai/directory/manage. Use the 150 or 500 character text and the screenshots above.
2. Codex plugin marketplace: check the submission process first. It has not been verified. The Codex files are in `plugins/kya-guard/.codex-plugin`.
3. Cursor marketplace: submit `plugins/kya-guard-cursor`.
4. Gemini CLI extension listing: `plugins/kya-guard-gemini` is a folder, and Gemini installs an extension from a repository root. Decide whether it needs its own repository.
5. Copilot CLI: `.plugin/marketplace.json` already lists `kya-guard`. No form is known.
