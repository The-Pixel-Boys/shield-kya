# Developer posture report (opt-in)

`kya posture` can send a short report about this developer machine to your workspace in the hosted console. The report lists the agent tools found on the machine, the agent-related editor extensions, the MCP server names, the result of the IoC check, and the status of the never-list. The workspace console shows these reports in its "Developer setup" view.

**Off by default.** Nothing is sent until you turn it on here, and the workspace admin also turns it on in the console. Both switches must be on. The report is advisory. It shows what is there. It does not prevent anything.

## Commands

```bash
kya posture status              # toggle, label, login, cached workspace policy. No network.
kya posture on                  # prints the exact report, then asks (needs a terminal, or --yes)
kya posture off                 # stops sending at once. No network.
kya posture send --dry-run      # prints the report a send would post. Sends nothing.
kya posture send                # one send now (still needs both switches on)
kya posture label NAME          # the name shown in the console (default: 8 hex characters)
```

`kya posture on` never switches on a report that fails the local check. In scripts, use `kya posture on --yes`.

The same switch is in the receipt report and in `kya dash` (press `P`). In the report, the "Developer setup" card is on the System page. The button shows on the live report only. A static report shows the commands. The card preview omits the device id and the label. A real send adds them. The dashboard shows the preview first. A second `P` turns sharing on.

## What is sent

One JSON object, schema 1, at most 64 KB. Example fields:

| Field | Content |
|---|---|
| `deviceId` | Random UUID stored in `~/.kya/device-id` (mode 0600). Not based on hardware. |
| `deviceLabel` | Your label, or the first 8 hex characters of sha256(hostname + deviceId). |
| `os`, `arch`, `kyaVersion` | Platform facts. |
| `hosts` | Agent CLIs found on the PATH (for example `claude-code`, `codex`), with `kyaHook` for Claude Code only. Version is `null`. |
| `extensions` | Agent-related editor extensions from a short allowlist, plus any id an IoC check names: id, version, editor. |
| `mcpServers` | Server name, transport (`stdio` or `http`), and the program name of the command. No arguments, no environment, no URLs. |
| `ioc` | Result of the local IoC check: list version, time, unreadable files skipped, findings. |
| `never` | Whether the never-list is active, and its mode (`advisory`, or `hosted` when a hosted login exists). |

## What is never sent

The client refuses to send a report that contains any of these. The check runs on every report, in the client, before the request is made:

- environment variable names or values (only long values with a digit are checked as values),
- file contents, arguments, or any absolute path (`/Users/...`, `/home/...`, `C:\...`, `file://`),
- your user name, your host name, or your home directory,
- IP addresses and e-mail addresses,
- API keys and tokens.

A violation stops the send. The message names the field path only, never the value.

## When a send happens

A send runs only when all of these are true:

1. The local toggle is on (`~/.kya/config.json`, key `posture.share` is `true`).
2. This machine has a hosted login (`kya login`). A plain `http` console address is refused unless it is loopback.
3. The workspace policy says enabled. The client reads the policy at most once a day.

The send runs in the daily background step that `kya hook` starts, detached, and the hook never waits for it. Each request has a 5 second timeout and does not follow redirects. A 403 from the report endpoint stops sending until the next daily policy check. Every failure fails open: the agent is never blocked.

With the toggle off, the client makes no network call at all.

## Files

| File | Content |
|---|---|
| `~/.kya/config.json` | `posture.share`, `posture.label` (other keys are kept) |
| `~/.kya/device-id` | Random device id, mode 0600 |
| `~/.kya/posture-state.json` | Cached workspace policy and the last send time |
| `~/.kya/posture-send-stamp` | Daily slot for the background send |

## Known limits

- Host versions are not read. Reading them would mean running the tools, which the client does not do.
- The IoC check is advisory and reads local files only. A clean result does not prove the machine is clean.
- A short user name (under 4 characters) is matched as a whole word. A name that is also an English word can block a send. Use `kya posture send --dry-run` to see the reason.
- The console side (storage, the workspace toggle, the table) is a separate change to the hosted product.
