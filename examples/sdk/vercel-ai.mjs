// Vercel AI SDK tool definition governed in-process by kya.
// AI SDK tools are keyed by name in the tools record, so pass the name in.
// Run: pnpm build && node examples/sdk/vercel-ai.mjs
import { governVercelAiTool } from "../../dist/sdk/index.js";

const weather = governVercelAiTool(
  {
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    execute: async ({ city }) => ({ city, forecast: "sunny" }),
  },
  { name: "org.sample.safe.read" },
);

// const tools = { weather }; — pass to generateText/streamText as usual.
console.log(await weather.execute({ city: "Berlin" }));
