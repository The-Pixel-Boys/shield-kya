# Herdr

[Herdr](https://herdr.dev) is a desktop app that runs coding agents in terminals, grouped in spaces. The Shield KYA mod for Herdr shows what KYA recorded for those agents in a Herdr window: each tool call, its verdict (allow, hold, deny), and never-list hits, grouped by Herdr space. A toast appears when KYA denies a call. One button opens the full KYA report.

The mod never approves, denies or changes a verdict. Local KYA stays advisory and fails open; enforcement is the hosted plane.

## Setup

1. Install KYA and wire your agents: `npm i -g @shield-agent/kya && kya start`.
2. In Herdr, ask your agent to add the mod from `herdr.dev/mods/The-Pixel-Boys/kya-herdr-mod`, or copy its `mods/kya` folder to `~/.config/herdr-app/mods/kya` yourself.
3. Open it with `alt-k` (from the mod's `keys.json`) or `herdr-app do mod.open '{"name":"kya"}'`.

## What it reads

The last 500 lines of the KYA record (`~/.kya/trail.jsonl`, or `$KYA_HOME/.kya/trail.jsonl`). It shows only the `summary` field, which KYA redacts; raw tool arguments are not in the record. A call belongs to a Herdr space when the space folder's last path part equals the call's project.

## Programs it runs

`sh` (to find `kya` and `KYA_HOME`) and `tail`. The mod has no network code of its own. "Open report" runs `kya receipt --open` from your home folder: it writes report files in `~/.kya/receipts`, starts the local KYA report server, and sends anonymous usage stats only if you turned them on. See [telemetry.md](telemetry.md).

## Verify

Make a Herdr space whose folder is named `demo`, then send a never-list call through the hook from that folder:

```bash
echo '{"session_id":"s","tool_name":"Bash","tool_input":{"command":"rm -rf ~"},"cwd":"'"$PWD"'","hook_event_name":"PreToolUse"}' | kya hook
```

The hook does not run the command: it only records it and exits 2. A `never` row appears under `demo` and one toast shows. The row stays in your KYA record. Tested on Herdr 0.1.14 with KYA 0.33.4 on macOS.

## Remove

Delete `~/.config/herdr-app/mods/kya` and the `alt-k` line in `~/.config/herdr-app/keys.json`.
