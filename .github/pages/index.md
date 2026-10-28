---
title: Shield KYA docs
---

# Shield KYA docs

Shield Know Your Agent (KYA) puts a gate in front of the tool calls of AI coding agents and keeps a local record of each call.
The client is open source (MIT) and runs on your machine.

- Product site: [shield-agent.com](https://shield-agent.com)
- Install: [`@shield-agent/kya` on npm](https://www.npmjs.com/package/@shield-agent/kya)
- Source and quick start: [README on GitHub](https://github.com/The-Pixel-Boys/shield-kya#readme)

## Start here

- [What is open source and what is hosted](oss-vs-hosted.md): which parts run locally and which parts need the hosted plane.
- [Host recipes](#host-recipes): connect KYA to your editor or agent CLI.
- [Roll the Claude Code plugin out to your team](team-rollout.md): two ways to give the plugin to a team.

## Certify and compliance

- [kya certify: Agent Trust Baseline gap reports](certify.md): which baseline requirements your agent setup meets, from local data.
- [EU AI Act crosswalk](certify-eu-ai-act.md): the baseline requirements mapped to articles of the EU AI Act.
- [OWASP MCP governance](owasp-mcp-governance.md): how KYA aligns with the OWASP MCP framework and Top 10.

## Gate, MCP and sandbox

- [Top-20 MCP servers](mcp-servers.md): how KYA recognizes common MCP servers, with gate recipes.
- [Sandbox backends](sandbox.md): the mock, Firecracker and OpenShell backends of `kya sandbox`.
- [SDK and framework integrations](sdk-integrations.md): in-process shims that send tool calls through KYA.
- [Hosted-plane hook (beta)](hosted-hook.md): use the hosted plane from the hook, and its limits.
- [Hosted operator SSO and SCIM](hosted-operator-sso.md): sign-in for human operators on Shield hosted.

## Imports

- [Import the AGT audit log](import-agt.md): read the Microsoft Agent Governance Toolkit log into the KYA record.
- [Import the AGT audit log into the hosted console](import-agt-hosted.md): the same log on the hosted console.
- [Import ADR Sensor events](import-adr-sensor.md): read ADR Sensor exports into the KYA record.
- [Import OpenShell events](import-openshell.md): read NVIDIA OpenShell OCSF logs into the KYA record.
- [Endpoint discovery](discovery.md): `kya discover` scans the workstation for AI tools.

## Observability and data

- [OTLP metrics](otlp.md): optional OpenTelemetry metrics. They are off by default.
- [Datadog and Grafana dashboards](dashboards.md): community dashboards and monitors for the OTLP data.
- [Works with your observability stack](marketing/observability-stack.md): how KYA fits next to tracing tools.
- [Anonymous usage stats](telemetry.md): what is sent, how to control it, and retention. They are off until you opt in.
- [KYA report design](report-design.md): design rules for the local HTML report.

## Host recipes

- [Add a coding host](host-recipe.md): how to write a recipe for a new editor or CLI.
- [Amp](hosts/amp.md)
- [Antigravity CLI](hosts/antigravity.md)
- [Claude (Code, Desktop, claude.ai)](hosts/claude.md)
- [Claude Code plugin](hosts/claude-plugin.md)
- [Cline](hosts/cline.md)
- [Codex (OpenAI)](hosts/codex.md)
- [GitHub Copilot CLI](hosts/copilot.md)
- [Cursor (IDE and Agent CLI)](hosts/cursor.md)
- [Devin CLI](hosts/devin.md)
- [Droid (Factory)](hosts/droid.md)
- [Gemini CLI](hosts/gemini.md)
- [Grok](hosts/grok.md)
- [Hermes Agent](hosts/hermes.md)
- [Kilo Code CLI](hosts/kilo.md)
- [Kimi Code CLI](hosts/kimi.md)
- [Kiro CLI](hosts/kiro.md)
- [Maki](hosts/maki.md)
- [MastraCode](hosts/mastracode.md)
- [Muse](hosts/muse.md)
- [OMP](hosts/omp.md)
- [OpenCode](hosts/opencode.md)
- [Pi](hosts/pi.md)
- [Qoder CLI](hosts/qoder.md)
- [Qwen Code](hosts/qwen.md)
- [VS Code, Cursor and Open VSX editors](hosts/vscode.md)
