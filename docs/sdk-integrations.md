# SDK & framework integrations

Drop-in shims route an agent's tool calls through kya evaluation
**in-process** (inside the agent's own process): no gateway, no daemon, no
network required. Evaluation uses
the same path as `kya wrap` (offline sample evaluate by default; an explicit
`ResolvedConfig` with a hosted plane is honored when passed). Every call
(allowed, reviewed, or denied) lands on the local record (trail): see
`kya receipt`. The
SDK shims also honor `KYA_SEND_PREVIEWS=0` for those local record fields
(summary/targetPath/diffPreview are omitted). That is slightly stricter than
`kya wrap`'s local record today, which records them regardless.

Decision semantics at the boundary:

| Decision | Behavior |
|---|---|
| `ALLOW` | function runs, the record stores the call |
| `REQUIRE_APPROVE` | observe semantics: function runs, the record stores the review (no Hold ticket in-process) |
| `DENY` | function **never runs**: TS throws `KyaDeniedError`, Python raises `KyaDenied` |

## Tier 1: shipped adapters and shims

### TypeScript (`import { ... } from "@shield-agent/kya/sdk"`)

All adapters are structural: they take the framework's tool shape and return
the same shape with a gated execution path. No framework packages are
imported; pass the tool object you already built. With `server: "<id>"`, the
evaluated toolId becomes `<server>__<toolName>` so the top-20 MCP taxonomy and
the receipt's server facet apply.

| Framework | Adapter | Tool shape |
|---|---|---|
| LangGraph.js | `governLangGraphTool(tool, { server?, irreversible?, config? })` | `{ name, description, schema, func }` |
| Vercel AI SDK | `governVercelAiTool(tool, { name, server?, ... })` | `{ description, parameters, execute }` |
| Mastra | `governMastraTool(tool, { server?, ... })` | `{ id, description, inputSchema, execute }` |
| OpenAI Agents TS | `governOpenAiAgentsTool(tool, { server?, ... })` | `{ name, description, parameters, invoke }` |
| Claude Agent SDK | `governClaudeAgentTool(tool, { server?, ... })` | `{ name, description, inputSchema, handler }` |

Anything not matching one of these shapes can use the core directly:

```ts
import { governed, KyaDeniedError } from "@shield-agent/kya/sdk";

const run = governed({
  toolId: "write_file",
  server: "filesystem",
  fn: (args) => fs.writeFile(args.path, args.content),
});
await run({ path: "out.txt", content: "hi" }); // throws KyaDeniedError on DENY
```

Runnable scripts per adapter live in `examples/sdk/`.

### Python (in development)

A fail-open Python shim with agent-wide hooks for LangChain / LangGraph,
Pydantic AI, CrewAI, Google ADK and Microsoft Agent Framework is in development and not yet released. It follows the same rules as `kya hook`:
advisory, fails open on errors (an error lets the call through), and the never-list still blocks. This page
will carry install and usage steps once it ships.

## Tier 2: recipes (no shipped adapter)

The pattern is always the same: wrap the callable the framework invokes for a
tool with `governed()` (TS) or the `@governed` decorator (Python) at the tool
boundary, and let the framework see the same-shaped callable.

- **Agno**: wrap each function in the agent's `tools=[...]` list with
  `governed()` (TS) or `@governed` (Python) before registering; Agno calls
  plain functions, so the governed wrapper drops in unchanged.
- **LlamaIndex**: build your `FunctionTool`/`QueryEngineTool` from a governed
  `fn`: `FunctionTool.from_defaults(fn=governed({ toolId, fn }))` (or decorate
  the Python function before `FunctionTool.from_defaults`). Metadata stays put.
- **Haystack**: Haystack components call tools through a `Tool`/`ToolInvoker`
  with a plain function; pass the governed function as the tool's `function`
  and keep the name/description identical.
- **Strands Agents**: decorate the body of each `@tool` function with
  `@governed(tool_id)` (stacked decorators, `@governed` innermost) so every
  invocation is evaluated before the side effect runs.
- **BeeAI Framework**: wrap the tool's `run`/execute callable with
  `governed()` and keep the input schema untouched; DENY surfaces as a thrown
  `KyaDeniedError`, which the agent loop treats as a tool error.
- **LiveKit Agents**: govern the function inside each `function_tool` /
  `@llm.function_tool`: the governed callable runs inside the realtime
  session, DENY throws before the side effect (e.g. a SIP transfer) fires.
- **CAMEL**: wrap each `FunctionTool`'s callable with `governed()` /
  `@governed` before adding it to the toolkit; CAMEL passes kwargs through, so
  the governed signature stays compatible.
- **LangChain core**: for `StructuredTool`/`@tool`, govern the underlying
  `func`/`coroutine` rather than the tool object: `tool.func = governed({...})`
  (or decorate the Python function before `@tool`). Chains then get the same
  checks with no graph changes.
- **n8n**: in Code nodes / custom nodes, call out to the kya CLI
  (`kya wrap --offline --tool-id <id> --json`, non-zero exit = blocked) before
  executing the node's side effect; treat exit 1 as "do not run".
- **Vercel AI SDK (UI-only apps)**: if you only use the AI SDK for UI
  streaming and execute tools server-side, govern the server-side handler with
  `governed()` at the route/action boundary; the UI layer needs no change.
- **Microsoft Agent Framework (AF)**: a fail-open Python shim for Agent Framework is in development, not yet released; for C#, shell out to `kya wrap --offline --json` before the function body runs (DENY must prevent the side effect, not just annotate it).

## Agent-to-agent (A2A)

Two levels, complementary:

- **In-process (`governA2aSend`)**: for frameworks that send A2A messages
  from inside the agent process (ADK-style peer calls, BeeAI, CrewAI
  delegations). It evaluates `a2a__<peerId>__<action>` (a registry-unknown
  server, so offline evaluate lands on the safe `REQUIRE_APPROVE`/UNKNOWN path
  unless the send is declared `irreversible`), records the event, and
  returns `{ allow, verdict, reasonCode }`. **The caller still performs (or
  skips) the send**; this is a boundary check, not a transport. Offline,
  destructive-name sends (drop/truncate/purge/transfer) also land on
  observe/`REQUIRE_APPROVE`: never `ALLOW` and never `DENY`. The gateway is
  the deny path for destructive cross-agent actions.
- **Gateway-level (kya gateway)**: fleet-wide A2A checks between
  runtimes (machine identity, org policy, cross-agent hold/approve) belong to
  the kya gateway/MCP gate, which sees every call regardless of which
  framework emitted it. Use `governA2aSend` for fast local feedback inside one
  process; use the gateway when peers are separate services.

```ts
import { governA2aSend } from "@shield-agent/kya/sdk";

const gate = await governA2aSend({
  peerId: "payments-agent",
  peerUrl: "https://a2a.example/payments",
  action: "refund",
  payloadSummary: "refund $42 to customer 9182",
  irreversible: true,
});
if (!gate.allow) throw new Error(`A2A blocked: ${gate.verdict}`);
// … perform the send
```
