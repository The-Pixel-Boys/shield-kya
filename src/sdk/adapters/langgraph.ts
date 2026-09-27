/**
 * LangGraph.js-style tool adapter. Structural only — no @langgraph imports.
 * Matches the `{ name, description, schema, func }` tool shape; returns the
 * same shape with a governed func.
 */

import { governed, type GovernanceOptions } from "../govern.js";

export interface LangGraphToolLike<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
  readonly func: (args: TArgs) => Promise<TResult> | TResult;
}

export function governLangGraphTool<TArgs, TResult>(
  tool: LangGraphToolLike<TArgs, TResult>,
  options: GovernanceOptions = {},
): LangGraphToolLike<TArgs, TResult> {
  return {
    ...tool,
    func: governed({
      toolId: tool.name,
      server: options.server,
      irreversible: options.irreversible,
      config: options.config,
      fn: tool.func,
    }),
  };
}
