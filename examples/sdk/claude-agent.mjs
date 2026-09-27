// Anthropic Agent SDK style tool handler governed in-process by kya.
// Run: pnpm build && node examples/sdk/claude-agent.mjs
import { governClaudeAgentTool } from "../../dist/sdk/index.js";

const tool = governClaudeAgentTool({
  name: "org.sample.safe.read",
  description: "Read a record",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  handler: async (args) => ({
    content: [{ type: "text", text: `record ${args.id}` }],
  }),
});

console.log(await tool.handler({ id: "rec-4" }));
