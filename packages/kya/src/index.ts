/**
 * @shield-agent/kya — light install library surface + CLI helpers.
 * Zero vertical packs required (R8). Provider-agnostic MCP / HTTP path.
 */

export { runCli, type CliIo } from "./cli.js";
export { parseArgs, flagString, flagBool, flagInt, type ParsedArgs } from "./parse-args.js";
export {
  resolveConfig,
  readFileConfig,
  writeFileConfig,
  configDir,
  configFilePath,
  type Host,
  type KyaFileConfig,
  type ResolvedConfig,
  type ResolveOptions,
} from "./config.js";
export {
  KyaHttpClient,
  buildEvaluateFromToolArgs,
  type KyaClientOptions,
  type PolicyEvaluateRequest,
  type PolicyEvaluateResponse,
  type RegisterAgentRequest,
  type AgentResponse,
  type SessionIngestRequest,
  type CreateApprovalRequest,
  type FetchLike,
} from "./client.js";
export { computeArgsHash, canonicalJson } from "./hash.js";
export { SAMPLE_TOOLS, findSampleTool, type SampleToolDescriptor } from "./sample-tools.js";
export { KyaError, AuthRequiredError, HttpError, UsageError } from "./errors.js";
export { runInit, initFromArgs, type InitResult } from "./commands/init.js";
export {
  runRegisterAgent,
  registerAgentInputFromArgs,
  type RegisterAgentResult,
} from "./commands/register-agent.js";
export {
  runEvalTool,
  evalToolInputFromArgs,
  formatEvalHuman,
  type EvalToolResult,
} from "./commands/eval-tool.js";
export {
  runServeMcp,
  serveMcpOptionsFromArgs,
  type ServeMcpOptions,
  type ServeMcpResult,
} from "./commands/serve-mcp.js";
export {
  runOrr,
  orrRunOptionsFromArgs,
  runSaFirstPartyProbes,
  formatOrrMarkdown,
  type OrrReport,
  type OrrRunOptions,
  type OrrRunResult,
} from "./commands/orr.js";
export {
  evaluateOffline,
  applySessionRisk,
  type SessionRisk,
} from "./offline-evaluate.js";
export {
  MCP_TOOLS,
  MCP_SERVER_INFO,
  handleMcpToolCall,
  handleJsonRpc,
  type McpHandlerContext,
  type McpCallResult,
} from "./mcp/protocol.js";
export { startHttpMcp, type HttpMcpServer } from "./mcp/http.js";
export { startStdioMcp } from "./mcp/stdio.js";
