/**
 * Mastra-style tool adapter. Structural only — no @mastra imports. Matches
 * the `{ id, description, inputSchema, execute }` tool shape; returns the
 * same shape with a governed execute.
 */

import { governed, type GovernanceOptions } from "../govern.js";

export interface MastraToolLike<TArgs = unknown, TResult = unknown> {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly execute: (args: TArgs) => Promise<TResult> | TResult;
}

export function governMastraTool<TArgs, TResult>(
  tool: MastraToolLike<TArgs, TResult>,
  options: GovernanceOptions = {},
): MastraToolLike<TArgs, TResult> {
  return {
    ...tool,
    execute: governed({
      toolId: tool.id,
      server: options.server,
      irreversible: options.irreversible,
      config: options.config,
      fn: tool.execute,
    }),
  };
}
