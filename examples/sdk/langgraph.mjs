// LangGraph.js-style tool governed in-process by kya.
// Run: pnpm build && node examples/sdk/langgraph.mjs
import { governLangGraphTool, KyaDeniedError } from "../../dist/sdk/index.js";

const readRecord = {
  name: "org.sample.safe.read",
  description: "Read a record by id",
  schema: { type: "object", properties: { id: { type: "string" } } },
  func: async (args) => ({ id: args.id, found: true }),
};

const tool = governLangGraphTool(readRecord);
console.log(await tool.func({ id: "rec-1" }));

const adminDelete = governLangGraphTool({
  name: "drop_table",
  description: "Drop a table",
  schema: { type: "object" },
  func: async () => "dropped",
}, { server: "github" });

try {
  await adminDelete.func({});
} catch (err) {
  if (err instanceof KyaDeniedError) {
    console.log(`blocked: ${err.toolId} (${err.reasonCode}) — func never ran`);
  } else {
    throw err;
  }
}
