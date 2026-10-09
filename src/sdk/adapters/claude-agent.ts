/**
 * Anthropic Agent SDK tool adapter. Structural only - no
 * @anthropic-ai/claude-agent-sdk import. Matches the
 * `{ name, description, inputSchema, handler }` in-process tool shape where
 * handler receives parsed args plus SDK extras; returns the same shape with
 * a governed handler.
 */

import { createGateCheck, type GovernanceOptions } from "../govern.js";

export interface ClaudeAgentToolLike<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly handler: (args: TArgs, extra?: unknown) => Promise<TResult> | TResult;
}

export function governClaudeAgentTool<TArgs, TResult>(
  tool: ClaudeAgentToolLike<TArgs, TResult>,
  options: GovernanceOptions = {},
): ClaudeAgentToolLike<TArgs, TResult> {
  const check = createGateCheck({
    toolId: tool.name,
    server: options.server,
    irreversible: options.irreversible,
    config: options.config,
  });
  return {
    ...tool,
    handler: async (args: TArgs, extra?: unknown): Promise<TResult> => {
      await check(args);
      return tool.handler(args, extra);
    },
  };
}
