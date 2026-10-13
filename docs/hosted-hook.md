# Hosted-plane hook (beta)

> **Beta.** Hosted mode is new and its limits are listed below. Read them before you rely on it.
> Any API key you create today has write scope, not just evaluate scope. A key that can only
> evaluate is planned and not available yet.

By default `kya hook` evaluates locally, makes no network calls, and fails open: if kya breaks,
the tool call goes ahead. Hosted mode changes that. Each tool call is evaluated by your Shield KYA
workspace (`POST /api/v1/kya/policy/evaluate`). When the plane cannot answer, the call is denied.

```text
kya hook --host claude --plane-config /Users/you/.kya/hosted.json
```

## What it does

| Plane answer or condition | Hosted (default) | `--strict` | `--plane-shadow` |
|---|---|---|---|
| Local never-list match (for example `mcp__postgres__drop_table`) | deny | deny | deny |
| ALLOW | allow | allow | allow |
| DENY (registered DENY tool, workspace policy, session clearance) | deny | deny | allow, recorded |
| REQUIRE_APPROVE (hold; every unregistered tool such as Read or Bash today) | allow, recorded | deny, with a console link | allow, recorded |
| Agent killed or revoked (`AGENT_NOT_ACTIVE`) | deny | deny | allow, recorded |
| Agent id unknown to the workspace (`AGENT_UNKNOWN`) | deny | deny | allow, recorded |
| Plane unreachable, 5xx, no verdict (`PLANE_UNREACHABLE`) | deny | deny | allow, recorded |
| Key rejected, 401 or 403 (`PLANE_AUTH_REJECTED`) | deny | deny | allow, recorded |
| No answer within the budget (`PLANE_TIMEOUT`) | deny | deny | allow, recorded |
| Rate limited, 429 (`PLANE_RATE_LIMITED`) | deny | deny | allow, recorded |
| Config file missing or unsafe (`PLANE_CONFIG`) | deny | deny | allow, recorded |
| TLS, CA, proxy or code-loading env override (`PLANE_ENV_REFUSED`) | deny | deny | allow, recorded |
| Unreadable hook payload (`FAIL_CLOSED`) | deny | deny | allow, recorded |

- **The local never-list always wins.** It runs on the tool name before any plane answer is used, and a plane ALLOW cannot override it. The plane is still asked, so the attempt shows up in the hosted trail.
- **Hold.** A held call is allowed and recorded unless you pass `--strict`. Under `--strict` it is denied with a link to your console. No approval request is opened in this beta, so tell the agent not to retry until an operator has changed the policy.
- **Shadow** (`--plane-shadow`) is for pilots. It evaluates and records, and never blocks except for the local never-list. Every row it writes carries `"shadow": true`. Shadow can only be set on the command line; no env var or file turns it on.
- A deny exits 2 with Claude Code's `permissionDecision: "deny"` JSON on stdout and the reason on stderr, exactly like the local hook.

## Retries and the latency budget

The plane call has one total budget: 3000 ms by default, set with `--plane-budget-ms` (100 to 4000). That leaves room under Claude Code's 5 s hook timeout for node start and the trail write.

- **Retried:** 429, any 5xx, network errors (refused, reset, DNS) and a stalled attempt. Each attempt is capped at half the budget, so one stall still leaves room for a retry.
- **Backoff:** exponential with jitter. Attempt n waits a random time between d/2 and d, where d is 200 ms times 2 to the power n, capped at 1600 ms.
- **Retry-After:** on a 429 it is honoured (never shorter than the backoff, so `Retry-After: 0` cannot cause a tight loop). If it does not fit in the remaining budget, the hook denies straight away rather than sleeping.
- **Not retried:** 401, 403 and every other 4xx.
- **When the budget runs out:** the call is denied with the code of the last failure.

## The config file

`--plane-config` takes an absolute path to a JSON file:

```json
{
  "baseUrl": "https://shield-agent.com",
  "apiKey": "sk_live_...",
  "agentId": "00000000-0000-0000-0000-000000000000"
}
```

```text
chmod 600 ~/.kya/hosted.json
```

- `apiKey` must be 8 to 512 printable ASCII characters (no spaces, accents or control characters).
- `agentId` is the id of an agent registered in your workspace (`kya register-agent`). Every call sends it with `requireRegisteredAgent: true`, so killing the agent in the console (or `kya kill --id`) denies its next tool call.
- The file is refused, and the call denied with `PLANE_CONFIG`, when:
  - the path is relative or the file is a symlink;
  - it is owned by another user, or readable by group or others;
  - it is a FIFO, device or other non-regular file (checked before opening, so it never blocks), or it has other hard links (a hard link inside a repository would dodge the location check);
  - it lies inside the project directory the agent runs in or that directory's git work tree (found by walking up to the nearest `.git`; the home directory itself is exempt, including a repository rooted at the home directory);
  - it is not valid JSON, or `agentId` is not a UUID;
  - `baseUrl` is not a plain `https:` origin: no credentials, query, fragment or port 0, ASCII only, no punycode, written in canonical form (so `0x7f.1` or `2130706433` are refused), and no IP address or `localhost` name. `--plane-allow-http-loopback` (command line only, for local testing) admits exactly `127.0.0.1` and `[::1]`, over http or https.
- Windows is not supported in this beta, because the owner and mode checks need POSIX.
- kya never prints, logs or writes the key to the trail, and error messages never echo the file. Node's own debug output (`NODE_DEBUG`, which would print request headers) is refused, see below. As a best-effort last resort, once the config file is loaded, hosted mode redacts the key from string and Buffer writes to `process.stdout` and `process.stderr`: the exact key, the exact key split across two writes, and its URL-encoded or base64 form only when that whole encoded form lies within one write (base64 only when aligned to the key's start). It does not cover a key it has not loaded yet, `Uint8Array` writes, direct `fs.writeSync` to fd 1 or 2, hex or other encodings, unaligned base64, or any other transformation, and a held-back partial key prefix that never completes is released as written at exit.

## Environment: what is ignored and what is refused

A repository can set environment variables for hooks. Claude Code applies the `env` block of a project's committed `.claude/settings.json` once you trust the folder, and hook processes inherit that environment. A `.env` loaded by your shell or tooling does the same. Hosted mode therefore reads its key, URL and agent from the config file only, and treats the environment as untrusted.

**Ignored** (the hook prints one stderr line and the trail row carries `"configIgnored": true`):

- `KYA_OFFLINE`, `KYA_BASE_URL`, `KYA_API_KEY`, `SHIELD_API_KEY`, `KYA_AGENT_ID`, `KYA_HOST` and `KYA_HOME`;
- the env notify sinks `KYA_NOTIFY_WEBHOOK` and `KYA_OTLP_EXPORT_ENDPOINT`;
- the project's `.kya/config.json`, including its `gateMode`, `baseUrl`, `agentId` and notify sinks.

The trail goes to `$HOME/.kya/trail.jsonl`. User-level notify and OTLP settings in `$HOME/.kya/config.json` still apply. Proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lowercase forms) are removed: the plane call never goes through a proxy, so a plane that is reachable only through a proxy fails closed.

**Refused** (deny `PLANE_ENV_REFUSED`; the message names the variable and never prints its value). These either change who the hook trusts or load code into node before kya starts, and some are read at process start, so they cannot be undone from inside the hook:

- `NODE_TLS_REJECT_UNAUTHORIZED` (any value), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`;
- `NODE_USE_ENV_PROXY`;
- `NODE_PATH` and `OPENSSL_CONF`;
- `DYLD_*` and `LD_*` (for example `DYLD_INSERT_LIBRARIES`, `LD_PRELOAD`, `LD_LIBRARY_PATH`);
- any other `NODE_*`, `SSL_*`, `OPENSSL_*` or `UV_*` variable, for example `NODE_DEBUG`, `NODE_USE_SYSTEM_CA`, `NODE_COMPILE_CACHE`, `NODE_V8_COVERAGE` or `UV_THREADPOOL_SIZE`. The only ones allowed are `NODE_ENV`, `NODE_NO_WARNINGS`, `NODE_DISABLE_COLORS`, `NODE_VERSION`, and `NODE_OPTIONS` as below;
- `NODE_OPTIONS` with anything outside this allowlist: `--max-old-space-size=N`, `--max-semi-space-size=N`, `--stack-trace-limit=N`, `--no-warnings`, `--no-deprecation`, `--enable-source-maps`, `--disable-warning=NAME`. It is split close to node's own rules (quotes, escapes, underscores) but more strictly, and anything it does not understand is refused.

**What the refusal cannot do.** A `NODE_OPTIONS` preload (`--require`, `--import`), `NODE_PATH`/`OPENSSL_CONF` code, or a loader-level injection (`DYLD_INSERT_LIBRARIES`, `LD_PRELOAD`) has already run before the hook's own check, before any JavaScript, so the check can only refuse to send the key and deny the call afterwards; it cannot stop that code from running. This is the same class as anyone who controls the process environment. Do not let repositories or users set env overrides for agent sessions (prefer managed settings).

A corporate setup that needs a custom CA or a proxy cannot use hosted mode in this beta. Managed settings can also set `env` for every session; if an administrator puts one of the refused variables there, every hosted hook call is denied. That is the administrator's responsibility to avoid.

Privacy opt-outs are still honoured, because they can only send less. `KYA_SEND_PREVIEWS=0` keeps `summary`, `diffPreview` and `targetPath` off the wire.

## Transport

The plane call uses its own HTTPS client: certificates are always verified, SNI comes from the configured host, there is no keep-alive and no proxy, and redirects are never followed (a 3xx is `PLANE_UNREACHABLE`, so the key is never sent to a second URL). The answer is capped at 64 KiB (a larger or endless body fails closed),. The plane's reason code must be an upper-case identifier (`[A-Z0-9_]`, at most 64 characters); anything else is shown as `PLANE_BAD_RESPONSE`. The hold console link is always built from your configured `baseUrl`, never from the plane's answer. An uncaught error never lowers a decision: the local never-list is evaluated before any plane code and still denies (exit 2) after a crash, even in shadow; a crash before the payload is understood also denies in shadow; otherwise a crash denies (exit 2), except in shadow for a tool known to be off the never-list (exit 0).

**`onFailure: "block"` is required.** Some failures kill node before kya runs at all: an invalid `NODE_OPTIONS` value, a heap too small to start, or a signal. Those exit with node's own code (for example 9, or SIGABRT), not 2. Only the host's `onFailure: "block"` turns them into a block, so hosted mode depends on it; `kya connect --hosted` and the managed snippet below set it. After the answer is written the hook exits at once, so a lingering socket cannot hold it past the host timeout.

## What leaves your machine

The same fields connected mode sends, plus four trail fields:

- **Same as connected mode:** the tool name, a sha256 hash of the arguments, the sample-tool risk fields, the agent id, and the redacted change fields (a summary of at most 80 characters, a redacted target path, and at most 8 lines or 480 characters of a redacted edit preview, never for shell commands). Raw arguments never leave the machine.
- **Added:** `env.correlationId` (a sha256 of the session and tool_use id), `mode`, and `product`. The host's session id is not sent.

## Wire it

**One user, Claude Code:**

```text
kya connect claude --hooks --hosted --plane-config /Users/you/.kya/hosted.json
```

This validates the file first, then writes the PreToolUse hook into `~/.claude/settings.json` with `"onFailure": "block"` (Claude Code 2.1.295 or later), so a crash or a host timeout also blocks. It replaces an existing kya hook instead of adding a second copy. `--plane-config` without `--hosted` is refused rather than silently wiring the local hook. The reverse is also refused: `kya connect claude --hooks` without `--hosted` (even with `--force`) will not swap a hosted hook back to the local one; remove the entry by hand if that is what you want. Add `--strict` or `--plane-shadow` to put that flag on the hook command. The key is never written to the settings file. Only Claude Code is supported for hosted wiring in this beta.

**A fleet (managed settings):** a user-level hook can be removed by the user. Worse, a repository's committed `.claude/settings.json` can set `"disableAllHooks": true`, which turns off user, project and plugin hooks; only managed hooks keep running. For enforcement that a repository or the agent cannot switch off, deploy the hook in Claude Code managed settings. The file goes at `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux and WSL, or through MDM or server-managed settings. Add `allowManagedHooksOnly` so that only managed hooks run:

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

Adjust the node and kya paths for your machines (`which node`, `npm root -g`). With `allowManagedHooksOnly`, the kya plugin's own hooks are blocked unless your managed settings force-enable the plugin. See the Claude Code [settings reference](https://code.claude.com/docs/en/settings-reference#allowmanagedhooksonly) and [managed settings](https://code.claude.com/docs/en/managed-settings).

## Honest limits

- **The governed agent runs as you.** An agent with a shell can read the config file and the key, edit `~/.claude/settings.json`, or kill the hook. Managed settings stop the settings edits but not the key read. Until evaluate-only keys ship, a leaked key can also change workspace policy. Run agents under a separate OS user if that matters to you.
- **Removal is detected, not prevented.** If the hook is removed, evaluate traffic for that agent stops. Watch the agent's last activity in the console.
- **Responses are not signed.** A man in the middle with a CA your machine trusts could forge an ALLOW.
- **Duplicate rows.** Two hook copies, for example the plugin plus a user hook, each call the plane, so the hosted trail gets two rows. The local trail records once per tool_use_id.
- **Only Claude Code has `onFailure: "block"`.** Without it, a host-side timeout or crash lets the call through.
- **Unregistered tools are held.** Every tool the workspace has not registered comes back as REQUIRE_APPROVE (`UNKNOWN_TOOL`). That is why hold does not block by default.
