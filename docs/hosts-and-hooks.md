# Hosts and hooks

One command per host, and the PreToolUse hook that `kya start` wires. Moved out of the package README. Back to the [README](../README.md).

## One command per host

`kya start` wires only the hosts it finds on this machine: the project `.mcp.json` when Claude Code is installed, `.cursor/mcp.json` when Cursor is installed, and the user-level config of every other installed host it detects. It no longer writes a generic project `mcp.json` (merge the block from [docs/hosts](hosts) by hand if a host reads that file). It does not write `.env.example` or `.kya/tools.sample.json` (those belong to `kya init`) or `orr-report/` (that belongs to `kya orr run`). In a git repository it adds `.kya/*` and `!.kya/policy.json` to `.gitignore` once (the team policy of `kya team init` stays committable). For the rest, `kya connect` writes the host's own config dialect directly:

```bash
kya connect claude              # ~/.claude.json (merges mcpServers only)
kya connect grok                # ~/.grok/config.toml (appends [mcp_servers.shield-kya])
kya connect opencode            # ~/.config/opencode/opencode.json
kya connect qwen                # ~/.qwen/settings.json
kya connect amp                 # ~/.config/amp/settings.json
kya connect qwen --project      # project scope instead of global
kya connect kiro --force        # overwrite an existing shield-kya entry
```

Connect merges. It never rewrites a host config it cannot parse, and it keeps your other servers and keys. Supported hosts: `claude`, `codex`, `grok`, `opencode`, `kilo`, `kiro`, `qwen`, `kimi`, `mastracode`, `amp`, `copilot`, `cursor`. Each wires `serve-mcp --stdio` with `KYA_OFFLINE=1` so the gate starts keyless (no API key). Set `KYA_API_KEY` in the host env when you point at an authenticated plane.

Hosts without a `connect` target still work: `kya wrap --offline -- <agent command>` puts the same evaluate gate in front of any CLI. Per-host recipes with verify steps and troubleshooting live in [docs/hosts/](hosts/).

## Hook interception

`kya start` also wires a `PreToolUse` hook into every installed hook-capable host it detects: Claude Code (`~/.claude/settings.json`, merge-only), Grok (`~/.grok/hooks/shield-kya.json`, kya-managed file), and Kimi Code (`~/.kimi-code/config.toml`, `[[hooks]]` append). The hook command points at a small launcher, `~/.kya/bin/kya-hook`. It runs the node and cli.js recorded at start, falls back to `node` and `kya` on your `PATH` after a Node version switch, and fails open with one stderr line (it never blocks a tool call) when neither is found. `kya doctor` flags a hook whose path is dead. Every tool call the agent makes then passes through `kya hook` first: it is evaluated locally (offline, sub-second, no network) and written to the global record (trail). (If you opted in to anonymous usage stats, the hook also starts a detached helper at most once a day; see [Anonymous usage stats](hosted-and-develop.md#anonymous-usage-stats-opt-in-off-by-default).)

Decision mapping: a local never-list or guard pack **DENY** blocks the tool call (exit `2` plus `hookSpecificOutput` deny JSON with `permissionDecision: "deny"`). A guard **ask** rule (for example `prisma migrate reset`) exits `0` with `permissionDecision: "ask"`, so Claude Code asks the person; other hosts deny it. **ALLOW** and **REQUIRE_APPROVE** are written to the record as advisory and the call proceeds. Manual wiring can pass `--strict` on the hook command to also block **REQUIRE_APPROVE**. Each record row also carries an `outcome` (`ran`, `blocked`, `held` or `error`) that says what the hook did. The `verdict` stays the policy opinion, so a shell call that ran is `verdict: REQUIRE_APPROVE` with `outcome: ran`. See [Outcome of each call](activity-record.md#outcome-of-each-call).

The never-list also blocks three groups added on 2026-10-30, pending owner review: agent-driven persistence (writes to `~/.ssh/authorized_keys`, cron, LaunchAgents and LaunchDaemons, systemd user units, `at`, `schtasks /create`, shell start files that download, `ssh-copy-id`), reverse tunnels and reverse shells (`ssh -R`, `ssh -L -N` to a raw IP, `nc -e`, bash `/dev/tcp`, `autossh`), and sending environment names or values to a public raw IP address. Loopback and private addresses are allowed. The rows and the known limits are in [docs/never-list.md](never-list.md).

Hooks are fail-open: any hook error or timeout allows the call. They are alerts plus local never-list and guard pack enforcement, not the sole barrier. Plane enforcement stays on the MCP `kya.policy_evaluate` path. Hooks take effect in new sessions; all three hosts load hooks at session start.

```bash
kya connect claude --hooks   # wire the PreToolUse hook by hand
kya connect grok --hooks
kya connect kimi --hooks
```
