// OpenAI Agents TS function tool governed in-process by kya.
// invoke receives (runContext, inputJson); kya evaluates the parsed input.
// Run: pnpm build && node examples/sdk/openai-agents.mjs
import { governOpenAiAgentsTool } from "../../dist/sdk/index.js";

const tool = governOpenAiAgentsTool({
  name: "org.sample.safe.read",
  description: "Read a record",
  parameters: { type: "object", properties: { id: { type: "string" } } },
  invoke: async (_runContext, input) => {
    const { id } = JSON.parse(input);
    return JSON.stringify({ id, found: true });
  },
});

console.log(await tool.invoke({}, JSON.stringify({ id: "rec-2" })));
