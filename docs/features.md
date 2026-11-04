# Features

Generated from `sdks/kya/features.json` by `pnpm sync:features`. Do not edit by hand.
Rows with status `planned` or `flagged` are not listed (not live).

| Feature | What it does | Command or flag | Status | Docs |
|---|---|---|---|---|
| Print version | Prints the installed kya version and exits. | `kya version`, `--version`, `-v`, `-V` | stable | README |
| One-line start | Wires the local MCP gate into your coding host and opens the live report in the background. | `kya start`, `--no-open`, `--force`, `--no-gate` | stable | README |
| Stop report server | Stops the background report server that kya start began. | `kya stop`, `--all` | stable | README |
| Scaffold config | Creates the .kya config folder with sample tools and an env example. | `kya init`, `--force` | stable | README |
| Wire a coding host | Writes the KYA MCP server into the config of one coding host (12 hosts). | `kya connect`, `--project`, `--force` | stable | [docs/hosts/claude.md](hosts/claude.md) |
| Wire PreToolUse hook | Writes the PreToolUse hook for claude, grok or kimi. With --project, the claude hook goes into the project's .claude/settings.json. | `kya connect`, `--hooks` | stable | [docs/hosts/claude.md](hosts/claude.md) |
| Point host at gateway | Points a coding host at the local kya gateway. | `kya connect`, `--gate` | beta | [docs/mcp-servers.md](mcp-servers.md) |
| Self-update and version banner | Updates kya to the latest npm version. kya start warns when a newer release exists. | `kya update`, `--no-update-check`, `KYA_UPDATE_CHECK` | stable | [docs/hosts/codex.md](hosts/codex.md) |
| Node 22 check and handoff | Checks the Node version and hands off to a supported Node 22 or newer. | none | stable | README |
| Homebrew install | Installs kya with Homebrew from The-Pixel-Boys tap. | `brew install The-Pixel-Boys/tap/shield-kya` | stable | README |
| Scoop install | Installs kya on Windows with Scoop. | `scoop install shield-kya` | beta | README |
| Team rollout: commit plugin pin | Adds a tag-pinned plugin marketplace and an enabled plugin to the project settings for everyone who opens the repo. | `kya team init`, `--dry-run` | beta | [docs/team-rollout.md](team-rollout.md) |
| Managed-settings JSON for admins | Prints the managed-settings JSON an administrator deploys. | `kya team managed-settings` | beta | [docs/team-rollout.md](team-rollout.md) |
| Repository policy file | Optional .kya/policy.json committed with the repo. Adds deny and requireApprove tool ids for the local gate; it cannot relax a verdict, and an invalid file is ignored with a note. | `.kya/policy.json` | beta | [docs/team-rollout.md](team-rollout.md) |
| Opt-in usage stats | Anonymous usage stats, off by default. Status, on, off, show and reset. | `kya telemetry`, `--purge` | stable | [docs/telemetry.md](telemetry.md) |
| Global activity record | Keeps a global activity log in the KYA home folder. Reports read the last 1 MB of it. | `KYA_HOME` | stable | README |
| Activity report | Writes the activity report as HTML, JSON or Markdown for the last few days or one session. | `kya receipt`, `--open`, `--days`, `--session`, `--q`, `--json`, `--out` | stable | [docs/report-design.md](report-design.md) |
| Redacted share link | Publishes a redacted summary of the report and prints a public link. | `kya receipt`, `--share`, `--share-url`, `--share-retries`, `KYA_SHARE_URL` | beta | [docs/oss-vs-hosted.md](oss-vs-hosted.md) |
| Natural-language search in report | Search box in the activity report. | none | beta | README |
| Map of agent actions | Graph and heat views of what KYA recorded for agent actions on this machine. Local only. Advisory. | `kya map`, `--days`, `--json`, `--html`, `--session` | beta | [docs/map.md](map.md) |
| Agent-flow export | Writes the local trail as an agent-flow JSONL event log. Classes only, no args. Local only. Advisory. | `kya export`, `--format`, `--days`, `--session`, `--out`, `--force` | beta | [docs/map.md](map.md) |
| Redacted change previews | Shows clipped, redacted change previews on the report. Set KYA_DIFF_PREVIEW=0 to turn them off. | `KYA_DIFF_PREVIEW` | stable | README |
| Terminal desk | Terminal view with free panes. Actions work on a TTY; --once prints one frame for CI. | `kya dash`, `--once`, `--pane` | stable | README |
| IoC check | Scans this machine for known supply-chain indicators. Read-only and offline. Runs once a day in the background from kya hook and shows in kya doctor, kya dash and kya receipt. | `kya doctor`, `kya doctor --iocs`, `--iocs`, `--json`, `KYA_IOC=0`, `ioc.enabled=false` | stable | [docs/ioc-scan.md](ioc-scan.md) |
| Developer posture report (opt-in) | Off by default. kya posture on prints the exact report and asks; a send needs the local toggle, a hosted login and the workspace policy. Minimised fields only; the client refuses any report with an environment name or value, a path, a user or host name, or an IP address. Advisory. | `kya posture`, `status`, `on`, `off`, `send`, `--dry-run`, `--json`, `label`, `--yes` | beta | [docs/posture.md](posture.md) |
| Cost showback | Observe-only cost showback inside the activity report. | none | stable | [docs/certify.md](certify.md) |
| Never-list block | Blocks never-list tools in the PreToolUse hook. kya hook exits 2 on DENY. | `kya hook` | stable | [docs/hosted-hook.md](hosted-hook.md), [docs/never-list.md](never-list.md) |
| Guard pack | Second layer of local denies in the PreToolUse hook, local and hosted (--plane-config): destructive shell commands, credential reads, secret-shaped writes and secret exfiltration. Config and guardAllow come from the user-level ~/.kya/config.json only. | `kya hook` | stable | [docs/guard-pack.md](guard-pack.md), [docs/hosted-hook.md](hosted-hook.md) |
| Advisory hook record | Records ALLOW and REQUIRE_APPROVE decisions in the hook. The call proceeds. | `kya hook` | stable | README |
| Strict hook mode | Strict mode denies advisory decisions in the hook. | `kya hook`, `--strict` | stable | README |
| Local MCP gate server | Serves the local MCP gate over HTTP, or over stdio for hosts. | `kya serve-mcp`, `--stdio`, `--port` | stable | [docs/mcp-servers.md](mcp-servers.md) |
| Local MCP gateway | Governs and audits tool calls to any MCP server through a local gateway. | `kya gate`, `kya gate init`, `kya gate setup`, `kya gate run`, `kya gate stop`, `kya gate status`, `kya gate doctor` | beta | [docs/mcp-servers.md](mcp-servers.md) |
| Destructive names and ADMIN tier denied | Gateway policy denies destructive tool names and the ADMIN tier. | none | beta | [docs/mcp-servers.md](mcp-servers.md) |
| Auto-import of host MCP servers | kya start imports MCP servers found in host configs into the gateway. Turn off with --no-gate or KYA_GATE=off. | `kya start`, `--no-gate`, `KYA_GATE` | beta | README |
| Evaluate and record a command | Evaluates a command and records it in the trail. With --tool-id it never runs anything. With `-- <cmd>` it runs the command only when the verdict allows. | `kya wrap`, `--offline`, `--hold`, `--json`, `--work-item`, `--tool-id`, `--irreversible` | stable | [docs/host-recipe.md](host-recipe.md) |
| Policy evaluate, exit codes | Evaluates a tool call against policy and exits with a code per verdict. | `kya eval-tool`, `--offline`, `--tool-id`, `--irreversible`, `--args`, `--session-risk`, `--risk`, `--approval-status`, `--sandbox-id` | stable | README |
| Read-only ORR board | Builds a read-only ORR board from producers and writes a report. It is not a second policy point. | `kya orr run`, `--path`, `--producer`, `--out`, `--skip-optional-producers`, `--agentshield-json`, `--commit-sha`, `--name`, `--rubric`, `--disable-category`, `--usage`, `--scorecard`, `--quiet`, `--json-stdout`, `--fail-on`, `--format` | stable | [docs/owasp-mcp-governance.md](owasp-mcp-governance.md) |
| Trust baseline gap report | Lists gaps in the Agent Trust Baseline from local evidence. | `kya certify`, `--window`, `--fail-on`, `--open`, `--json-stdout`, `--catalog`, `--out`, `--format`, `--quiet` | stable | [docs/certify.md](certify.md) |
| Local attestation | Records a local attestation for one requirement ID. | `kya certify`, `--attest`, `--text` | stable | [docs/certify.md](certify.md) |
| Self-signed evidence bundle | Writes a self-signed evidence bundle. It shows integrity and key continuity, not identity. | `kya certify`, `--sign` | beta | [docs/certify.md](certify.md) |
| EU AI Act mapping | Maps certify evidence to EU AI Act articles. | none | beta | [docs/certify-eu-ai-act.md](certify-eu-ai-act.md) |
| Import foreign traces | Imports traces from other tools into the local trail so the report and certify can read them. | `kya import`, `--from`, `--file` | stable | [docs/import-agt.md](import-agt.md), [docs/import-adr-sensor.md](import-adr-sensor.md), [docs/import-openshell.md](import-openshell.md) |
| Detections and fix briefs | Finds detections in the trail, groups them into incidents and writes fix briefs for coding agents. | `kya investigate`, `--json` | beta | [docs/import-agt.md](import-agt.md) |
| Endpoint discovery | Scans this endpoint for AI agents, IDEs, runtimes and MCP servers. | `kya discover`, `--json`, `--diff`, `--push`, `--file` | beta | [docs/discovery.md](discovery.md) |
| Opt-in Firecracker wrap | Opt-in sandbox that runs a command inside a Firecracker VM. Not an MCP tool. | `kya sandbox`, `--sandbox`, `--sandbox-id`, `--cmd`, `--path`, `--offline`, `KYA_SANDBOX` | beta | [docs/sandbox.md](sandbox.md) |
| Alert webhooks | Sends decision alerts to webhooks set in the config file. | none | beta | README |
| OTLP export | Exports metrics to an OpenTelemetry collector through the gateway OTLP receiver. | `otlpPort` | beta | [docs/otlp.md](otlp.md) |
| OTLP map attributes | Adds the target class and the hashed device id to decision spans. Opt-in in the user-level config only. Default off. | `otlpExport.mapAttrs` | beta | [docs/otlp.md](otlp.md) |
| In-process SDK shims | Adapters for in-process agent SDKs: Claude Agent SDK, LangGraph, Mastra, OpenAI Agents and Vercel AI. | none | stable | [docs/sdk-integrations.md](sdk-integrations.md) |
| Python framework shim | Python package shield-kya that gives agent frameworks the KYA checks. | `pip install shield-kya` | beta | [docs/sdk-integrations.md](sdk-integrations.md) |
| Claude Code plugin | Claude Code plugin for kya, installed from the shield-kya marketplace. | `/plugin install kya@shield-kya` | stable | [docs/hosts/claude-plugin.md](hosts/claude-plugin.md) |
| Codex plugin | Codex plugin for kya. | `codex plugin add kya@shield-kya` | stable | [docs/hosts/codex.md](hosts/codex.md) |
| Copilot CLI plugin | Copilot CLI plugin for kya. | `copilot plugin install kya@shield-kya` | beta | [docs/hosts/copilot.md](hosts/copilot.md) |
| Gemini CLI extension | Gemini CLI extension for kya. | `gemini extensions install` | stable | [docs/hosts/gemini.md](hosts/gemini.md) |
| Cursor plugin | Cursor plugin manifest for kya. | none | beta | [docs/hosts/cursor.md](hosts/cursor.md) |
| VS Code extension | VS Code extension for kya, published on the Visual Studio Marketplace. | none | beta | [docs/hosts/vscode.md](hosts/vscode.md) |
| GitHub Action kya-certify | GitHub Action that runs kya certify in a workflow. | `uses: The-Pixel-Boys/kya-action` | stable | README |
| Org Hold | Holds a call for an org approval path instead of observing it. | `KYA_HOLD`, `--hold` | stable | [docs/certify.md](certify.md) |
| Plane connection and keys | Connects the CLI to the hosted plane with an API key, a base URL, a host and an agent ID. | `KYA_API_KEY`, `KYA_BASE_URL`, `KYA_HOST`, `--base-url`, `--api-key`, `--host`, `--agent-id` | stable | README |
| Hosted login (device code) | Links this machine to the hosted console with a device code. Saves a full-workspace key with mode 0600 in ~/.kya/hosted-credentials.json. | `kya login`, `--base-url` | beta | [docs/login.md](login.md) |
| Sign out on this machine | Deletes the saved hosted key file on this machine. The key stays active on the server until revoked. | `kya logout` | beta | [docs/login.md](login.md) |
| Hosted calls to action | One line, at most once a day, after kya certify (gaps) and kya receipt. Silent in CI, non-TTY, KYA_QUIET, KYA_CTA=0 and config opt-out. | `KYA_QUIET`, `KYA_CTA` | beta | [docs/login.md](login.md) |
