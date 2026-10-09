/**
 * @shield-agent/kya/sdk - in-process governance shims for agent frameworks.
 * Importing this surface starts no daemons, telemetry, or network clients;
 * evaluation defaults to the offline sample path.
 */

export {
  governed,
  deriveSdkToolId,
  KyaDeniedError,
  type GovernedOptions,
  type GovernanceOptions,
} from "./govern.js";
export {
  governA2aSend,
  type GovernA2aSendOptions,
  type A2aGateResult,
} from "./a2a.js";
export { governLangGraphTool, type LangGraphToolLike } from "./adapters/langgraph.js";
export {
  governVercelAiTool,
  type VercelAiToolLike,
  type GovernVercelAiOptions,
} from "./adapters/vercel-ai.js";
export { governMastraTool, type MastraToolLike } from "./adapters/mastra.js";
export {
  governOpenAiAgentsTool,
  type OpenAiAgentsToolLike,
} from "./adapters/openai-agents.js";
export {
  governClaudeAgentTool,
  type ClaudeAgentToolLike,
} from "./adapters/claude-agent.js";
export type { ResolvedConfig } from "../config.js";
