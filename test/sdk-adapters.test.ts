import { describe, expect, it } from "vitest";
import { governLangGraphTool } from "../src/sdk/adapters/langgraph.js";
import { governVercelAiTool } from "../src/sdk/adapters/vercel-ai.js";
import { governMastraTool } from "../src/sdk/adapters/mastra.js";
import { governOpenAiAgentsTool } from "../src/sdk/adapters/openai-agents.js";
import { governClaudeAgentTool } from "../src/sdk/adapters/claude-agent.js";
import { KyaDeniedError } from "../src/sdk/govern.js";
import type { ResolvedConfig } from "../src/config.js";

const offlineConfig: ResolvedConfig = {
  baseUrl: "http://127.0.0.1:8090",
  apiKey: "",
  host: "ide",
  agentId: undefined,
  mcpPort: 3920,
  tenantHint: undefined,
  cwd: "/tmp",
  configPath: "/tmp/.kya/config.json",
  json: false,
  allowMissingApiKey: true,
  offline: true,
  holdEnabled: false,
};

const opts = { config: offlineConfig };

describe("langgraph adapter", () => {
  const schema = { type: "object" };

  it("preserves shape and governs func", async () => {
    let ran = 0;
    const tool = governLangGraphTool(
      {
        name: "org.sample.safe.read",
        description: "read a record",
        schema,
        func: (args: { id: string }) => {
          ran += 1;
          return { id: args.id };
        },
      },
      opts,
    );
    expect(tool.name).toBe("org.sample.safe.read");
    expect(tool.description).toBe("read a record");
    expect(tool.schema).toBe(schema);
    await expect(tool.func({ id: "1" })).resolves.toEqual({ id: "1" });
    expect(ran).toBe(1);
  });

  it("DENY throws without running func", async () => {
    let ran = 0;
    const tool = governLangGraphTool(
      {
        name: "org.sample.never.event",
        description: "never",
        schema,
        func: () => {
          ran += 1;
        },
      },
      opts,
    );
    await expect(tool.func({})).rejects.toBeInstanceOf(KyaDeniedError);
    expect(ran).toBe(0);
  });
});

describe("vercel-ai adapter", () => {
  const parameters = { type: "object", properties: {} };

  it("preserves shape and governs execute, name from options", async () => {
    const tool = governVercelAiTool(
      {
        description: "read a record",
        parameters,
        execute: (args: { id: string }) => `got ${args.id}`,
      },
      { name: "org.sample.safe.read", ...opts },
    );
    expect(tool.description).toBe("read a record");
    expect(tool.parameters).toBe(parameters);
    await expect(tool.execute({ id: "7" })).resolves.toBe("got 7");
  });

  it("server prefix feeds the taxonomy", async () => {
    let ran = 0;
    const tool = governVercelAiTool(
      {
        description: "drop",
        parameters,
        execute: () => {
          ran += 1;
        },
      },
      { name: "drop_table", server: "github", ...opts },
    );
    const err = await tool.execute({}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(ran).toBe(0);
    expect(err).toBeInstanceOf(KyaDeniedError);
    expect((err as KyaDeniedError).toolId).toBe("github__drop_table");
  });
});

describe("mastra adapter", () => {
  it("preserves shape and governs execute", async () => {
    const inputSchema = { type: "object" };
    const tool = governMastraTool(
      {
        id: "org.sample.safe.read",
        description: "read",
        inputSchema,
        execute: () => "ok",
      },
      opts,
    );
    expect(tool.id).toBe("org.sample.safe.read");
    expect(tool.inputSchema).toBe(inputSchema);
    await expect(tool.execute({})).resolves.toBe("ok");
  });

  it("DENY throws without running execute", async () => {
    let ran = 0;
    const tool = governMastraTool(
      {
        id: "org.sample.never.event",
        description: "never",
        inputSchema: {},
        execute: () => {
          ran += 1;
        },
      },
      opts,
    );
    await expect(tool.execute({})).rejects.toBeInstanceOf(KyaDeniedError);
    expect(ran).toBe(0);
  });
});

describe("openai-agents adapter", () => {
  const parameters = { type: "object", properties: { q: { type: "string" } } };

  it("preserves shape and governs invoke with JSON-string input", async () => {
    let received: string | undefined;
    const tool = governOpenAiAgentsTool(
      {
        name: "org.sample.safe.read",
        description: "read",
        parameters,
        invoke: (_ctx: unknown, input: string) => {
          received = input;
          return "result";
        },
      },
      opts,
    );
    expect(tool.name).toBe("org.sample.safe.read");
    expect(tool.parameters).toBe(parameters);
    await expect(tool.invoke({ run: 1 }, JSON.stringify({ q: "x" }))).resolves.toBe("result");
    expect(received).toBe(JSON.stringify({ q: "x" }));
  });

  it("DENY throws without running invoke", async () => {
    let ran = 0;
    const tool = governOpenAiAgentsTool(
      {
        name: "org.sample.never.event",
        description: "never",
        parameters,
        invoke: () => {
          ran += 1;
        },
      },
      opts,
    );
    await expect(tool.invoke({}, "{}")).rejects.toBeInstanceOf(KyaDeniedError);
    expect(ran).toBe(0);
  });

  it("governs every call through one hoisted check", async () => {
    let ran = 0;
    const tool = governOpenAiAgentsTool(
      {
        name: "org.sample.safe.read",
        description: "read",
        parameters,
        invoke: (_ctx: unknown, input: string) => {
          ran += 1;
          return input;
        },
      },
      opts,
    );
    await expect(tool.invoke({}, JSON.stringify({ q: "a" }))).resolves.toBe(
      JSON.stringify({ q: "a" }),
    );
    await expect(tool.invoke({}, JSON.stringify({ q: "b" }))).resolves.toBe(
      JSON.stringify({ q: "b" }),
    );
    expect(ran).toBe(2);
  });
});

describe("claude-agent adapter", () => {
  const inputSchema = { type: "object" };

  it("preserves shape and governs handler, passing extras through", async () => {
    let extraSeen: unknown;
    const tool = governClaudeAgentTool(
      {
        name: "org.sample.safe.read",
        description: "read",
        inputSchema,
        handler: (args: { id: string }, extra?: unknown) => {
          extraSeen = extra;
          return { content: [{ type: "text", text: args.id }] };
        },
      },
      opts,
    );
    expect(tool.name).toBe("org.sample.safe.read");
    expect(tool.inputSchema).toBe(inputSchema);
    const out = await tool.handler({ id: "3" }, { signal: undefined });
    expect(out).toEqual({ content: [{ type: "text", text: "3" }] });
    expect(extraSeen).toEqual({ signal: undefined });
  });

  it("DENY throws without running handler", async () => {
    let ran = 0;
    const tool = governClaudeAgentTool(
      {
        name: "org.sample.never.event",
        description: "never",
        inputSchema,
        handler: () => {
          ran += 1;
        },
      },
      opts,
    );
    await expect(tool.handler({})).rejects.toBeInstanceOf(KyaDeniedError);
    expect(ran).toBe(0);
  });

  it("denies on every call, not just the first", async () => {
    let ran = 0;
    const tool = governClaudeAgentTool(
      {
        name: "org.sample.never.event",
        description: "never",
        inputSchema,
        handler: () => {
          ran += 1;
        },
      },
      opts,
    );
    await expect(tool.handler({})).rejects.toBeInstanceOf(KyaDeniedError);
    await expect(tool.handler({})).rejects.toBeInstanceOf(KyaDeniedError);
    expect(ran).toBe(0);
  });
});
