# Link this machine to the hosted console (`kya login`)

`kya login` links the CLI on this machine to your hosted Shield KYA workspace. It uses the device
code flow (RFC 8628): the CLI shows a short code, you approve the code in the hosted console while
you are signed in, and the CLI saves a full-workspace API key on this machine.

The OSS CLI does not need an account. Run `kya login` only when you want the hosted console.

## Steps

```
kya login
```

1. The CLI prints a verification address and a code, such as `WDJB-MJHT`. It opens the address in
   your browser when you are at a terminal (not when `KYA_NO_BROWSER=1`).
2. Sign in to the hosted console. Open the address, or **Approve a kya login** in the sidebar.
   Type the code.
3. The console shows who is asking: the network address, the client string and the time. **Only approve
   if you started this login yourself.** If you did not, choose **Deny**. Deny is the default button.
4. To approve, choose **Approve a full-workspace key** on the confirm step. The key can do anything an API
   key of that workspace can do. Only an owner or an admin can approve. A read-only user or an operator
   cannot.
5. The CLI saves the key and prints its display prefix, for example `sk_live_1a2b3c4d...`.

The code expires after about 10 minutes. The approval is good for 5 minutes: the terminal must collect the key
within that time. If it expires, run `kya login` again.

Each review or decision in the console counts as an attempt. After ten attempts in 15 minutes, the approver must wait.
A terminal that starts logins too fast from one network address gets "too many requests" and waits a minute.

## Where the key is stored

| File | Mode | Content |
|------|------|---------|
| `~/.kya/hosted-credentials.json` (or `$KYA_HOME/.kya/`) | 0600 | The console origin, the API key, its display prefix and the time it was saved |

The CLI never prints the full key. Do not paste this file into a ticket or a chat.

## Options

| Option or variable | Effect |
|--------------------|--------|
| `--base-url <url>` | The hosted console to use. Default `https://shield-agent.com`. |
| `KYA_BASE_URL` | Same as `--base-url`, read from the environment. |
| `KYA_NO_BROWSER=1` | Do not open a browser. The CLI still prints the address and the code. |

A console URL must use `https`. The only exception is a loopback address (`127.0.0.1`, `::1` or
`localhost`) for local development. A URL with a user name, password, query or fragment is refused.

## Sign out on this machine

```
kya logout
```

`kya logout` deletes the saved file on this machine. It does not revoke the key on the server.
The key stays active until you revoke it in the hosted console: **Settings, API keys**.

## What happens when something fails

`kya login` is an explicit command. On any failure it exits with code 1, prints one line and saves
nothing:

| Case | Message (short form) |
|------|----------------------|
| The user denies the request in the console | the request was denied |
| The code expires | the code expired before it was approved |
| The console does not answer, or answers in an unknown way | the console sent an unexpected answer or lost the connection |
| The console does not offer hosted login | hosted login is not available on this server |
| The address is not allowed (not https, not loopback) | the console URL is refused |
| The workspace has the maximum number of API keys | revoke an unused key in the console, then run `kya login` again |

Hosted login never changes a verdict, an exit code of `kya certify`, or the OSS hook. Those
commands do not read the saved key.

## Calls to action (one line)

Some commands print one line that points to `kya login`:

| Command | When the line appears |
|---------|-----------------------|
| `kya certify` | The report has gaps. |
| `kya receipt` | When the trail is too large to read in full, the line says the report shows only the newest part. Otherwise the line suggests `kya receipt --share`. |

A line appears at most once every 24 hours on this machine. It never appears when:

- the output is JSON (`--json`), or `certify --quiet` is used;
- the `CI` or `GITHUB_ACTIONS` variable is set to a true value;
- the output is not a terminal (for example a pipe or a file);
- `KYA_QUIET` is set to a true value;
- `KYA_CTA=0` (or `off`, `false`, `no`) is set;
- `.kya/config.json` in the project contains `"ctaOptOut": true`;
- `~/.kya/cta.json` contains `"optOut": true`.

The line makes no network call and sends no telemetry.

## Known limits

- The key is a **full-workspace key**. There is no narrower scope yet. A scoped key type is a follow-up. The
  owner decides on it, and the feature flag stays off until then.
- If the console approves and the terminal does not get the key (the response is lost, or the terminal stops),
  the key exists on the server but the terminal does not save it. The next poll is refused. Find the key in
  **API keys** (its name starts with `kya login`) and revoke it.
- The approver check and the key creation run in one database transaction, but the approver row is not locked. A
  change to the approver made at the same moment can still pass the check. Rate limits are kept in memory per server
  process. With several servers, each one counts on its own.
- `kya logout` does not revoke the key on the server yet. Revoke it in the console.
- A second `kya login` on the same machine saves a new key. The old key stays active until you revoke it.
- The saved file is not the `--plane-config` file used by `kya connect --hooks --hosted`. That file
  also needs a registered agent id, which `kya login` does not create.
