# IoC check (supply-chain indicators)

`kya doctor --iocs` checks this machine for known indicators of compromise (IoC). It reads local files. It does not run any tool from the machine, and it makes no network call.

The check is advisory. It tells you what it found. It does not stop or remove anything, and a clean result does not prove that the machine is clean.

## Run it

```bash
kya doctor --iocs          # scan now, store the result, print findings
kya doctor                 # show the last stored result
kya doctor --iocs --json   # machine-readable output
```

The last result is also shown in:

- `kya receipt`: the **IoC check** card is on the System page. When there are findings, a short banner also shows at the top of every page.
- `kya dash`: pane 9 (`ioc`).

## Background scan

`kya hook` starts a detached scan at most once every 24 hours. The hook does not wait for it, and the hook answer does not change. The scan writes `~/.kya/ioc-latest.json`. A stamp file, `~/.kya/ioc-scan-stamp`, holds the time of the last start.

Turn the background scan off with either of these:

```bash
export KYA_IOC=0                 # per shell or per host environment
```

```json
{ "ioc": { "enabled": false } }
```

Put the JSON in `~/.kya/config.json`. `kya doctor --iocs` still runs when you ask for it.

## What the list covers

The list ships in the package as `data/iocs.json` (schema 1). It has one entry today:

| IoC | Severity | What is checked |
|-----|----------|-----------------|
| Trojanized `anthropic.claude-code` 2.1.313 (VS Code extension, reported 2026-10) | critical | An extension directory for that version in `~/.vscode`, `~/.vscode-insiders`, `~/.cursor`, `~/.windsurf` or `~/.vscode-oss` (`extensions` folder). A platform suffix such as `-darwin-arm64` still matches. |
| Trojan SSH key label | critical | A line in `~/.ssh/authorized_keys` whose comment is `svc-telemetry`. The key itself is never shown. |
| Trojan network address | critical | The address `134.209.82.225` in the user crontab, `~/Library/LaunchAgents/*.plist`, `~/.config/systemd/user/*`, `~/.ssh/config`, `~/.zshrc`, `~/.bashrc` or `~/.profile`. |

Check kinds in the list: `extension`, `ssh_authorized_keys_comment`, `net_indicator` and `file_exists` (a path under `~` only).

## Findings

Each finding has a severity, the IoC id, the check kind, an evidence path or label, and a fix hint:

```text
[critical] ioc-2026-claude-vscode-trojan (extension): ~/.cursor/extensions/anthropic.claude-code-2.1.313
    fix: Update the extension to a release that is not listed here, restart the editor, then rotate the credentials it could read.
```

Evidence never contains file contents, except the matched label or address. Paths are shown with `~` for the home folder, so the user name does not appear.

## Limits

- Files that exist but cannot be read are skipped and counted (`skipped` in the result). A missing file is not an error.
- The crontab check runs `crontab -l` for the current user. The binary is started by absolute path from `/usr/bin/crontab`, `/bin/crontab` or `/usr/sbin/crontab` (first regular file that is not writable by group or others). The scan never looks up `crontab` through `PATH`. The check is skipped on Windows, and it is counted as skipped when no such binary exists.
- The scan starts no other program. It reads files only, apart from that one `crontab -l`.
- The list is a snapshot. Run `kya update` to get a newer `kya` with a newer list.
- The scan does not check other editors, other extension folders, or processes that are running now.
- The result is local. Nothing is sent to a server by this feature.

## Result file

`~/.kya/ioc-latest.json`:

```json
{
  "schema": 1,
  "checkedAt": "2026-10-30T10:25:59.243Z",
  "listVersion": "2026-10-30.1",
  "skipped": 0,
  "findings": []
}
```

## Environment and config

| Setting | Meaning |
|---------|---------|
| `KYA_IOC=0` | Turns off the background scan from `kya hook`. |
| `ioc.enabled=false` in `~/.kya/config.json` | Same as `KYA_IOC=0`. |
| `KYA_HOME` | Changes the home folder that the scan reads (used by tests and sandboxes). |
