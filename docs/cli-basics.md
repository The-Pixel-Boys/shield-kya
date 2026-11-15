# CLI basics

How the CLI behaves: version output, Node versions, exit codes and offline mode. Moved out of the package README. Back to the [README](../README.md).

CLI and local MCP gate for Shield’s Know Your Agent path.

An agent that asks Shield first gets Allow, Review, or Deny: you register the agent, wrap the tool (or route it through the MCP gate or the hosted plane), and Review waits for a person. See [Hook interception](hosts-and-hooks.md#hook-interception) for what the local hooks do. This package does not scan your network. Agents that never call evaluate stay invisible on purpose.

Walkthrough: [how you use it](https://shield-agent.com/how-kya-works#using).

```bash
npx @shield-agent/kya@latest --help
npx @shield-agent/kya@latest --version
```

`--version`, `-v`, `-V` and `kya version` print the installed package version on one line and exit `0`. They read the local package only: no network, no banner, no config.

Requires **Node.js 22+** (`engines.node: >=22`); 24 is the recommended line. Node 20 and 21 are unsupported but work: the CLI prints a one-line warning. Node 18 and older are unsupported and some features break there (HTTP `serve-mcp`, the gateway OTLP receiver). Below 22 the CLI offers to install Node 24 for you (via volta / fnm / nvm / brew), reinstall itself, and finish the command. If you decline, it just prints the warning and continues. `kya hook` never warns or prompts.

It works with any host that speaks MCP or OpenAPI. Vertical packs are optional. Shield is the only policy decision point (the one place that decides Allow or Deny). This gate never auto-approves an irreversible side effect (a change you cannot undo).

If `KYA_API_KEY` is empty against an authenticated plane, network commands exit non-zero. `eval-tool`, `wrap`, and `invoke` exit `0` on ALLOW, `4` on REQUIRE_APPROVE, and `1` on DENY or unknown, so a line like `eval-tool && write` cannot skip the gate. `wrap` runs in observe mode by default, so it exits `0` on REQUIRE_APPROVE too. Set `KYA_HOLD=1` or pass `--hold` to get the `4`.

`--offline` runs sample evaluate without a paid cloud (useful for DENY and REQUIRE_APPROVE demos). Creating an agent is itself a tool: offline, `kya.agent.register` comes back REQUIRE_APPROVE. Allow, break-glass, and approve mint modes (the modes that create approvals) live on the control plane.
