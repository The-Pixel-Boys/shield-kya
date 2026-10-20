# Threat model: Shield KYA (Know Your Agent)

## What this project does and where untrusted input enters

Shield KYA is a local security gate and audit trail for AI coding agents (Claude Code,
Cursor, Codex, Gemini, Grok, Kimi and others). It sits between the agent and the tools
the agent calls: every tool call is evaluated against a policy, allowed / held / blocked,
and recorded in a signed local trail. A live HTML report renders the trail in the browser.

Untrusted input enters at these points:

- **MCP tool-call payloads.** AI agents send JSON-RPC tool calls through the gate
  (`src/mcp*`, `src/gate*`, gateway code). Tool names, arguments, and descriptions are
  fully attacker-controlled when the agent or its prompt is compromised. Treat every
  field as hostile.
- **The policy engine** (`src/policy*`, `evaluate*`). Rules decide allow / hold / block.
  A bypass here defeats the whole product: a call that should be blocked must never be
  allowed because of a parsing, normalization, or matching bug (case, Unicode, path
  traversal in file arguments, shell quoting, glob overreach).
- **The report server** (`src/receipt/`). It renders event data (tool names, arguments,
  session ids, reason strings) into HTML served on localhost. Any unescaped value is a
  stored XSS in the user's browser, with the report token in the URL. This is a
  high-value target.
- **Importers** (`src/commands/import*`, `--from langsmith|langfuse|phoenix|otel|agt|
  adr-sensor|openshell`). They parse large third-party JSON/JSONL files. Malformed,
  hostile, or huge input must not crash the process, exhaust memory, or smuggle
  script content into the trail that the report later renders.
- **Config and hooks.** `.kya/config.json`, hook scripts, and host wiring files are read
  and sometimes written by the CLI. Path handling must stay inside the intended
  directories; no symlink following outside the workspace, no writing outside the
  documented paths.
- **The notify / webhook and OTel exporters.** They send event data to user-configured
  endpoints. SSRF is accepted (the user configures the target), but secret material
  (API keys, tokens) must never be added to a payload beyond what the user configured.

## Components that matter most / least

- Most: policy evaluation, gate decision paths, report HTML escaping, importer parsing,
  webhook signing/auth, token handling for the report URL.
- Less but in scope: CLI argument parsing, session rollups, gateway proxying.
- Out of scope: `test/`, `fixtures/`, `docs/`, `examples/`, `catalog/` sample data,
  and anything under `node_modules` (dependencies are not the project).

## How to exercise it

- `pnpm run build` compiles to `dist/`; `node dist/cli.js --help` lists commands.
- `pnpm run test` runs the Vitest suite; `test/` holds unit and end-to-end tests,
  including hostile-input cases for the gate and the report renderer.
- A quick manual loop: `node dist/cli.js start` wires a host, then
  `node dist/cli.js receipt --open` serves the report.

## How we rate severity

- **Critical**: policy bypass that lets a blocked or held tool call execute; remote code
  execution; the report token or webhook secrets leaking to an attacker.
- **High**: stored XSS in the report; writes outside the allowed directories; secret
  values (API keys, tokens) persisted or sent where the user did not configure them;
  authentication bypass on the report server or hosted endpoints.
- **Medium**: denial of service of the gate or report (a hostile tool call or import file
  hangs or crashes the process); log/redaction gaps that expose partial secrets.
- **Low**: information disclosure without secret material; incorrect labels or counts.

## Anything to leave alone

- Do not report issues that require the attacker to already control the user's shell or
  the local machine; the threat model starts at the AI agent and its inputs.
- Do not report missing rate limits on the localhost-only report server.
- Findings about dependencies: report only if the vulnerable code path is actually
  reachable from this project's code.
