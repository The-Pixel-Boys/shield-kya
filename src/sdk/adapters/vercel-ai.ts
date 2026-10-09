/**
 * Vercel AI SDK tool adapter. Structural only - no `ai` import. Matches the
 * `{ description, parameters, execute }` tool shape; returns the same shape
 * with a governed execute. AI SDK tools are keyed by name in the tools
 * record, so the name is an explicit adapter option.
 */

import { governed, type GovernanceOptions } from "../govern.js";

export interface VercelAiToolLike<TArgs = unknown, TResult = unknown> {
  readonly description?: string;
  readonly parameters: unknown;
  readonly execute: (args: TArgs) => Promise<TResult> | TResult;
}

export interface GovernVercelAiOptions extends GovernanceOptions {
  /** Tool name - the key this definition is registered under. */
  readonly name: string;
}

export function governVercelAiTool<TArgs, TResult>(
  tool: VercelAiToolLike<TArgs, TResult>,
  options: GovernVercelAiOptions,
): VercelAiToolLike<TArgs, TResult> {
  return {
    ...tool,
    execute: governed({
      toolId: options.name,
      server: options.server,
      irreversible: options.irreversible,
      config: options.config,
      fn: tool.execute,
    }),
  };
}
