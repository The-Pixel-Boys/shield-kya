# Anonymous usage stats (opt-in)

KYA can send a small, anonymous heartbeat so the maintainers can see how many installs are in
use, which versions and platforms to support, and how long sessions last. It is **off until you
say yes**, and you can see exactly what it sends before you decide.

## How you are asked

The first time you run `kya start`, `kya init` or `kya connect` **in a terminal**, KYA asks once:

```
Share anonymous usage stats to help improve KYA?
  Sends: a random install ID, KYA version, OS/arch, Node version, which KYA part is running.
  Never: file paths, repo names, prompts, tool arguments, or code.
  See exactly what is sent with `kya telemetry show`; change your mind any time with `kya telemetry off`.
Share anonymous usage stats? [y/N]
```

- The default is **No**. Only an explicit `y` or `yes` turns it on; empty input, anything else, or
  closing the prompt is No.
- It asks **once**. Your answer is saved in `~/.kya/telemetry.json` and never asked again.
- The question goes to **stderr**, so it never mixes into output you pipe.
- It is never asked in CI, in non-interactive runs, with `--json`, or by `kya serve-mcp` (an MCP stdio
  process owns stdout as its protocol channel and never prompts).

## What is sent

While a long-running KYA process is up (the MCP gate over stdio or http, the report daemon, the
gateway supervisor), it sends a `start` event, a `heartbeat` about every 5 minutes, and an `end`
event on a clean shutdown. A killed process simply stops heartbeating.

`kya hook` (the per-tool-call hook) is too short-lived to heartbeat, so installs that only use hooks
would otherwise be invisible. When you opted in, the hook starts a **detached background helper** at
most **once a day** (`kya telemetry ping`) that sends a single `ping` event with `surface` `hook`, and
the hook returns at once: it never waits on the network, and its output, exit code and speed are
unchanged. If the ping fails it is not retried until the next day.

Exactly these fields, nothing else:

| Field | Example | Meaning |
|---|---|---|
| `schema` | `1` | payload version |
| `installId` | random UUID | created only when you opt in; not derived from your machine, user or hardware |
| `sessionId` | random UUID | new for every process |
| `event` | `start` / `heartbeat` / `end` / `ping` | lifecycle (`ping` = one daily message from `kya hook`) |
| `surface` | `mcp-stdio` / `mcp-http` / `report` / `gateway` / `hook` | which KYA part is running |
| `cliVersion` | `0.22.0` | KYA version |
| `os`, `arch` | `darwin`, `arm64` | Node platform and CPU architecture |
| `nodeMajor` | `24` | Node.js major version |
| `hostId` | `claude` | the host integration, taken from the session id `kya connect` writes (`mcp:<host>`), else `unknown` |
| `gateMode` | `observe` / `hold` / `offline` | the gate mode |
| `hostedLinked` | `true` / `false` | whether a hosted API key is configured (the key itself is never sent) |

**Never sent:** file paths, repository or project names, host or user names, environment variables,
command arguments, tool names, prompts, code, audit-trail contents, API keys, or email addresses.
The server does not store your IP address with these records.

See it for yourself: `kya telemetry show` prints the exact payload.

## Controls

| Command | Effect |
|---|---|
| `kya telemetry status` | on, off or not asked; the install ID; what overrides it right now |
| `kya telemetry on` | opt in without waiting for the prompt (also the way to opt in from a non-interactive setup) |
| `kya telemetry off` | stop sending |
| `kya telemetry off --purge` | stop sending **and** erase everything the server holds for this install, then forget the ID locally |
| `kya telemetry reset` | new random install ID; the old one is no longer linked to this machine |
| `kya telemetry show` | the exact payload, with the field list |

Overrides that always win, whatever you answered:

- `DO_NOT_TRACK=1`
- `KYA_TELEMETRY=0` (or `off`, `false`, `no`)
- running in CI (`CI` set, or `GITHUB_ACTIONS=true`)

`KYA_OFFLINE=1` does **not** switch telemetry off: it selects sample evaluation, and `kya connect`
writes it into every MCP host config it generates. If you opted in, your answer is honoured; use
one of the switches above to opt out.

`kya hook` itself never opens a network connection; the daily ping comes from the detached helper
described above, only after you opted in and under the same switches. The in-process SDK
(`src/sdk`) never imports this code.

## Reliability and safety

- Short timeout (3 s), no redirects, errors swallowed: a failed send can never change what KYA does.
- Three consecutive failures stop the beacon for the rest of that process.
- It prints nothing to stdout or stderr while running.

## Retention and erasure

| Data | Kept |
|---|---|
| Session records | 90 days since last seen |
| Install records | deleted after 180 days without activity |
| Hourly aggregate counts (no identifiers) | 400 days |

`kya telemetry off --purge` erases an install immediately. You can also email
privacy@shield-agent.com with your install ID (`kya telemetry status`).

## Self-hosting or pointing it elsewhere

`KYA_TELEMETRY_URL` overrides the endpoint (default `https://shield-agent.com/api/v1/telemetry/kya`).
Only `https://` URLs, or `http://` to a loopback host, are accepted; anything else is ignored. The
erase call goes to the same URL plus `/erase`, with the install ID in the request body.

## Known limits

- Only installs that said yes are counted, so the numbers are a sample, not a census.
- A hook-only install shows up as active (at most once a day) but not as a live session, and the
  ping says nothing about how much the hook was used.
- Anyone can send fake heartbeats to a public endpoint; treat the numbers as indicative.
