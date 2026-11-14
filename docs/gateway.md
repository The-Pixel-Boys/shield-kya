# Gate (local MCP gateway)

The local MCP gateway. Moved out of the package README. Back to the [README](../README.md).

## Gate (local MCP gateway)

`kya gate` puts one loopback-only listener (`127.0.0.1`, default port `3930`) in front of any MCP server you already use. Your host talks to the gateway; the gateway fans out to the real servers. Per-tool policy comes from the [top-20 server taxonomy](mcp-servers.md). Destructive names (`drop`/`truncate`/`purge`/`transfer`) and each server's ADMIN-tier tools are denied outright and filtered from `tools/list`. Everything else runs in observe mode: allowed, and recorded. Every call is written to the local record and the live report, and can be forwarded as OTLP to the hosted intake.

**Zero-touch:** `kya start` already does this for you. It scans your detected host configs for third-party MCP servers, imports them into `.kya/gateways.json` (recorded with an `importedFrom` field that says where each server came from), installs the gateway binary, starts the listener, and rewrites each source host so the imported servers route through the gateway. The original host config is kept under `.kya/backups/` before anything is removed. Nothing found → nothing downloaded, no listener. Opt out with `kya start --no-gate` or `KYA_GATE=off`. If the binary download fails (offline, no network), `kya start` warns once and continues without the gateway. Host configs stay untouched. The manual path below is still there when you want full control:

```bash
kya gate init     # scaffold .kya/gateways.json with ready-to-move recipes
# edit gateways.json: move a recipe into "servers", fill its placeholders
kya gate setup    # download the pinned gateway binary into .kya/bin
kya gate run      # generate the gateway config, start the listener detached
kya connect claude --gate   # point the host at the gateway (server key shield-kya-gate)
kya gate doctor   # binary, config, listener health, loopback-only posture
```

If another process already holds a default port (`port` 3930 or `otlpPort` 3931), `kya gate run` stops with `EADDRINUSE`. Set free ports in `.kya/gateways.json` (`port` and `otlpPort`), then run it again.

`kya gate stop` stops the supervisor and the binary with it. Honest notes: `kya gate setup` (and `kya start`'s auto-bootstrap, only when it found servers to govern) downloads the pinned gateway binary from our releases. Nothing else downloads anything by default. The opt-in offers download only after you say yes: the security alerts offer (the local triage model and its runtime, see [docs/alerts.md](alerts.md)) and the plain-language search offer. The only other network use is the opt-in anonymous usage stats in [docs/telemetry.md](telemetry.md), off unless you say yes. `run` never downloads. Observe mode means allowed calls are recorded, not blocked. The deny set above is the only hard stop, and plane enforcement stays with `kya.policy_evaluate`. `kya connect <host> --gate` covers the same hosts as plain `connect`. Grok gets a `[mcp_servers.shield-kya-gate]` url table in its config.toml (Grok supports remote MCP servers over HTTP). Per-server tiers and recipes: [docs/mcp-servers.md](mcp-servers.md).
