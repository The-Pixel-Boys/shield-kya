import { describe, expect, it, vi } from "vitest";
import { KyaHttpClient } from "../src/client.js";
import {
  evalToolInputFromArgs,
  formatEvalHuman,
  runEvalTool,
} from "../src/commands/eval-tool.js";
import type { ResolvedConfig } from "../src/config.js";
import { parseArgs } from "../src/parse-args.js";
import { UsageError } from "../src/errors.js";

const baseConfig: ResolvedConfig = {
  baseUrl: "http://127.0.0.1:8090",
  apiKey: "sk_test",
  host: "ide",
  agentId: undefined,
  mcpPort: 3920,
  tenantHint: undefined,
  cwd: "/tmp",
  configPath: "/tmp/.kya/config.json",
  json: false,
  allowMissingApiKey: false,
  offline: false,
};

describe("eval-tool", () => {
  it("parses tool-id, args, irreversible", () => {
    const p = parseArgs([
      "eval-tool",
      "--tool-id",
      "org.sample.never.event",
      "--irreversible",
      "--args",
      '{"target":"x"}',
    ]);
    const input = evalToolInputFromArgs(p);
    expect(input.toolId).toBe("org.sample.never.event");
    expect(input.irreversible).toBe(true);
    expect(input.args).toEqual({ target: "x" });
  });

  it("rejects bad JSON args", () => {
    const p = parseArgs(["eval-tool", "--tool-id", "x", "--args", "{"]);
    expect(() => evalToolInputFromArgs(p)).toThrow(UsageError);
  });

  it("requires tool-id", () => {
    expect(() => evalToolInputFromArgs(parseArgs(["eval-tool"]))).toThrow(
      UsageError,
    );
  });

  it("calls evaluate with dry HTTP mock — DENY for never.event", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.toolId).toBe("org.sample.never.event");
      expect(body.irreversible).toBe(true);
      return new Response(
        JSON.stringify({
          verdict: "DENY",
          reasonCode: "NEVER_EVENT",
          toolId: "org.sample.never.event",
          argsHash: body.argsHash,
          localVerdict: "DENY",
          sessionRisk: "LOW",
          host: "ide",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new KyaHttpClient({
      baseUrl: baseConfig.baseUrl,
      apiKey: baseConfig.apiKey,
      host: "ide",
      fetch: fetchImpl,
    });

    const result = await runEvalTool(
      baseConfig,
      {
        toolId: "org.sample.never.event",
        args: { target: "x" },
        irreversible: true,
      },
      client,
    );
    expect(result.response.verdict).toBe("DENY");
    expect(result.response.reasonCode).toBe("NEVER_EVENT");
    const human = formatEvalHuman(result);
    expect(human).toContain("verdict: DENY");
    expect(human).toContain("reasonCode: NEVER_EVENT");
  });

  it("REQUIRE_APPROVE for data.write", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            verdict: "REQUIRE_APPROVE",
            reasonCode: "HIGH_STAKES_WRITE",
            toolId: "org.sample.data.write",
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const client = new KyaHttpClient({
      baseUrl: baseConfig.baseUrl,
      apiKey: baseConfig.apiKey,
      fetch: fetchImpl,
    });

    const result = await runEvalTool(
      baseConfig,
      {
        toolId: "org.sample.data.write",
        args: { key: "greeting", value: "hi" },
        irreversible: true,
      },
      client,
    );
    expect(result.response.verdict).toBe("REQUIRE_APPROVE");
  });

  it("offline DENY for never.event without network", async () => {
    const result = await runEvalTool(
      { ...baseConfig, offline: true, apiKey: "" },
      {
        toolId: "org.sample.never.event",
        irreversible: true,
        offline: true,
      },
    );
    expect(result.offline).toBe(true);
    expect(result.response.verdict).toBe("DENY");
    expect(result.response.reasonCode).toBe("NEVER_EVENT");
  });

  it("offline REQUIRE_APPROVE for data.write", async () => {
    const result = await runEvalTool(
      { ...baseConfig, offline: true, apiKey: "" },
      {
        toolId: "org.sample.data.write",
        irreversible: true,
        offline: true,
      },
    );
    expect(result.offline).toBe(true);
    expect(result.response.verdict).toBe("REQUIRE_APPROVE");
  });

  it("parses --offline flag", () => {
    const p = parseArgs([
      "eval-tool",
      "--tool-id",
      "org.sample.safe.read",
      "--offline",
    ]);
    expect(evalToolInputFromArgs(p).offline).toBe(true);
  });
});
