# Endpoint checks

Endpoint discovery, the IoC check and the developer posture report. Moved out of the package README. Back to the [README](../README.md).

## Endpoint discovery

`kya discover` lists AI agents, IDE extensions, desktop apps, model runtimes, and MCP servers on the current workstation. The scanner only inspects paths and config files; it never executes discovered binaries and never connects to runtime ports. Snapshots are written to `~/.kya/discovery/<iso-ts>.json` with a `latest.json` copy, and the live report shows a **Discovery** card with totals, sanctioned/review counts, and top categories.

```bash
kya discover                              # scan, save snapshot, print summary
kya discover --json                       # print snapshot JSON to stdout
kya discover --diff ~/.kya/discovery/latest.json  # compare current scan to saved snapshot
kya discover --push                       # scan and push to hosted console
```

Push requires `KYA_BASE_URL` and `KYA_API_KEY`:

```bash
export KYA_BASE_URL=https://shield-agent.com
export KYA_API_KEY=your-token
kya discover --push
```

Home-directory prefixes are redacted from evidence paths (replaced with `~`). The snapshot includes a stable `endpointUid` derived from the OS, a hostname hash, and a user hash. No raw hostname or username leaves the machine. See [docs/discovery.md](discovery.md) for the full scan list and privacy notes.

## IoC check (supply-chain indicators)

`kya doctor --iocs` checks this machine for known indicators of compromise, for example the trojanized `anthropic.claude-code` 2.1.313 extension. It reads local files only and makes no network call. The check is advisory: it reports findings and does not change anything. A clean result does not prove the machine is clean.

```bash
kya doctor --iocs     # scan now and print findings
kya doctor            # show the last result
```

`kya hook` also runs the check in the background, at most once a day. Turn that off with `KYA_IOC=0` or `{"ioc":{"enabled":false}}` in `~/.kya/config.json`. The last result shows in `kya receipt` and in `kya dash` (pane 9). See [docs/ioc-scan.md](ioc-scan.md).

## Developer posture report (opt-in, off by default)

`kya posture` can send a short report about this machine to your hosted workspace: agent hosts, agent-related extensions, MCP server names, the IoC result and the never-list status. Nothing is sent until you run `kya posture on` (it prints the exact report first) and the workspace allows it. `kya posture off` stops at once, and with the toggle off the client makes no network call. The client refuses any report that holds an environment name or value, a path, a user or host name, or an IP address. The check is advisory. See [docs/posture.md](posture.md).

```bash
kya posture status
kya posture on            # shows the exact report, then asks (or --yes in scripts)
kya posture send --dry-run
kya posture off
```
