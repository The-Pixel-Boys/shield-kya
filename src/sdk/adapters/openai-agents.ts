/**
 * OpenAI Agents TS function-tool adapter. Structural only — no
 * @openai/agents import. Matches the `{ name, description, parameters,
 * invoke }` function-tool shape where invoke receives the run context and a
 * JSON string input; returns the same shape with a governed invoke. The
 * parsed input is what gets evaluated; the original string is what the tool
 * receives.
 */

import { createGateCheck, type GovernanceOptions } from "../govern.js";

export interface OpenAiAgentsToolLike<TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly invoke: (runContext: unknown, input: string) => Promise<TResult> | TResult;
}

export function governOpenAiAgentsTool<TResult>(
  tool: OpenAiAgentsToolLike<TResult>,
  options: GovernanceOptions = {},
): OpenAiAgentsToolLike<TResult> {
  const check = createGateCheck({
    toolId: tool.name,
    server: options.server,
    irreversible: options.irreversible,
    config: options.config,
  });
  return {
    ...tool,
    invoke: async (runContext: unknown, input: string): Promise<TResult> => {
      let args: unknown = input;
      try {
        args = JSON.parse(input);
      } catch {
        /* evaluate the raw string when input is not JSON */
      }
      await check(args);
      return tool.invoke(runContext, input);
    },
  };
}
