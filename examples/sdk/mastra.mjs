// Mastra-style tool governed in-process by kya.
// Run: pnpm build && node examples/sdk/mastra.mjs
import { governMastraTool } from "../../dist/sdk/index.js";

const tool = governMastraTool({
  id: "org.sample.safe.read",
  description: "Read a record",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  execute: async (args) => ({ id: args.id, found: true }),
});

console.log(await tool.execute({ id: "rec-9" }));
