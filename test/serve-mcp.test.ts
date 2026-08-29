import { describe, expect, it, vi } from "vitest";
import { KyaHttpClient } from "../src/client.js";
import {
  runServeMcp,
  serveMcpOptionsFromArgs,
} from "../src/commands/serve-mcp.js";
import type { ResolvedConfig } from "../src/config.js";
import {
  handleJsonRpc,
  handleMcpToolCall,
  MCP_TOOLS,
} from "../src/mcp/protocol.js";
import { parseArgs } from "../src/parse-args.js";

const baseConfig: ResolvedConfig = {
  baseUrl: "http://127.0.0.1:8090",
  apiKey: "sk_test",
  host: "ide",
  agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  mcpPort: 0, // ephemeral
  tenantHint: undefined,
  cwd: "/tmp",
  configPath: "/tmp/.kya/config.json",
  json: false,
  allowMissingApiKey: false,
  offline: false,
};

function mockClient(): KyaHttpClient {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/policy/evaluate")) {
      const body = JSON.parse(String(init?.body));
      const verdict =
        body.toolId === "org.sample.never.event"
          ? "DENY"
          : body.toolId === "org.sample.data.write"
            ? "REQUIRE_APPROVE"
            : "ALLOW";
      const reasonCode =
        verdict === "DENY"
          ? "NEVER_EVENT"
          : verdict === "REQUIRE_APPROVE"
            ? "HIGH_STAKES_WRITE"
            : "ALLOW";
      return new Response(
        JSON.stringify({
          verdict,
          reasonCode,
          toolId: body.toolId,
          sessionRisk: "LOW",
          host: body.env?.host,
        }),
        { status: 200 },
      );
    }
    if (String(url).includes("/sessions/ingest")) {
      return new Response(
        JSON.stringify({ id: "id-1", riskLevel: "LOW", host: "ide" }),
        { status: 202 },
      );
    }
    if (String(url).includes("/approvals")) {
      return new Response(
        JSON.stringify({ id: "ap-1", status: "PENDING" }),
        { status: 201 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return new KyaHttpClient({
    baseUrl: baseConfig.baseUrl,
    apiKey: baseConfig.apiKey,
    host: "ide",
    agentId: baseConfig.agentId,
    fetch: fetchImpl,
  });
}

describe("serve-mcp args", () => {
  it("defaults to http mode", () => {
    expect(serveMcpOptionsFromArgs(parseArgs(["serve-mcp"])).mode).toBe("http");
  });

  it("selects stdio with --stdio", () => {
    expect(
      serveMcpOptionsFromArgs(parseArgs(["serve-mcp", "--stdio"])).mode,
    ).toBe("stdio");
  });
});

describe("MCP protocol tools", () => {
  it("lists kernel tools under policy path", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "kya.policy_evaluate",
      "kya.session_ingest",
      "kya.request_approval",
    ]);
  });

  it("tools/list via JSON-RPC", async () => {
    const client = mockClient();
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { client, host: "ide", agentId: baseConfig.agentId },
    );
    expect(res?.result).toBeDefined();
    const tools = (res?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("kya.policy_evaluate");
  });

  it("initialize handshake", async () => {
    const client = mockClient();
    const res = await handleJsonRpc(
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      },
      { client, host: "ide" },
    );
    expect(
      (res?.result as { serverInfo: { name: string } }).serverInfo.name,
    ).toBe("shield-kya");
  });

  it("policy_evaluate DENY for never.event", async () => {
    const client = mockClient();
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      {
        toolId: "org.sample.never.event",
        irreversible: true,
        args: { target: "x" },
      },
      { client, host: "ide", agentId: baseConfig.agentId },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.verdict).toBe("DENY");
  });

  it("policy_evaluate REQUIRE_APPROVE for data.write", async () => {
    const client = mockClient();
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      {
        action: "org.sample.data.write",
        irreversible: true,
        args: { key: "greeting", value: "hi" },
      },
      { client, host: "ide" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.verdict).toBe("REQUIRE_APPROVE");
  });

  it("session_ingest proxies to plane", async () => {
    const client = mockClient();
    const result = await handleMcpToolCall(
      "kya.session_ingest",
      { session: { sessionId: "s1", host: "ide", tools: ["org.sample.safe.read"] } },
      { client, host: "ide" },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.riskLevel).toBe("LOW");
  });

  it("request_approval does not execute side effect (returns PENDING only)", async () => {
    const client = mockClient();
    const result = await handleMcpToolCall(
      "kya.request_approval",
      {
        action: "org.sample.data.write",
        agentId: baseConfig.agentId,
        resourceId: "22222222-2222-2222-2222-222222222222",
        summary: "write greeting",
      },
      { client, host: "ide", agentId: baseConfig.agentId },
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.status).toBe("PENDING");
    expect(body.note).toMatch(/no side effect/i);
  });
});

describe("HTTP serve-mcp", () => {
  it("starts HTTP gate and serves tools + health", async () => {
    const client = mockClient();
    const result = await runServeMcp(
      { ...baseConfig, mcpPort: 0 },
      { mode: "http", port: 0 },
      client,
    );
    expect(result.http).toBeDefined();
    const base = result.http!.url;

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(result.http!.token.length).toBeGreaterThan(8);

    const auth = { "x-kya-mcp-token": result.http!.token };
    const tools = await fetch(`${base}/mcp/tools`, { headers: auth }).then(
      (r) => r.json(),
    );
    expect(tools.tools.map((t: { name: string }) => t.name)).toContain(
      "kya.policy_evaluate",
    );

    const evalRes = await fetch(`${base}/mcp/tools/kya.policy_evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        toolId: "org.sample.never.event",
        irreversible: true,
        args: { target: "x" },
      }),
    }).then((r) => r.json());
    const verdict = JSON.parse(evalRes.content[0].text).verdict;
    expect(verdict).toBe("DENY");

    const rpc = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "kya.policy_evaluate",
          arguments: { toolId: "org.sample.safe.read" },
        },
      }),
    }).then((r) => r.json());
    expect(rpc.result.content[0].text).toContain("ALLOW");

    await result.http!.close();
  });

  it("does not echo exception text on invalid JSON", async () => {
    const { startHttpMcp } = await import("../src/mcp/http.js");
    const http = await startHttpMcp({
      port: 0,
      client: mockClient(),
      kyaHost: "ide",
    });
    const res = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kya-mcp-token": http.token,
      },
      body: "{not-json",
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).not.toMatch(/Unexpected|SyntaxError|stack/i);
    expect(body.error).toBe("invalid json");
    await http.close();
  });

  it("requires shared secret on tools when configured", async () => {
    const { startHttpMcp } = await import("../src/mcp/http.js");
    const http = await startHttpMcp({
      port: 0,
      client: mockClient(),
      kyaHost: "ide",
      sharedSecret: "s3cret-token",
    });
    const denied = await fetch(`${http.url}/mcp/tools`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`${http.url}/mcp/tools`, {
      headers: { "x-kya-mcp-token": "s3cret-token" },
    });
    expect(ok.status).toBe(200);
    const viaBearer = await fetch(`${http.url}/mcp/tools`, {
      headers: { Authorization: "Bearer s3cret-token" },
    });
    expect(viaBearer.status).toBe(200);
    const health = await fetch(`${http.url}/health`);
    expect(health.status).toBe(200);
    await http.close();
  });

  it("empty sharedSecret option still requires a generated token", async () => {
    const prev = process.env.KYA_MCP_HTTP_TOKEN;
    process.env.KYA_MCP_HTTP_TOKEN = "";
    try {
      const { startHttpMcp } = await import("../src/mcp/http.js");
      const http = await startHttpMcp({
        port: 0,
        client: mockClient(),
        kyaHost: "runtime",
        sharedSecret: "",
      });
      expect(http.token.length).toBeGreaterThan(8);
      const denied = await fetch(`${http.url}/mcp/tools`);
      expect(denied.status).toBe(401);
      const ok = await fetch(`${http.url}/mcp/tools`, {
        headers: { "x-kya-mcp-token": http.token },
      });
      expect(ok.status).toBe(200);
      await http.close();
    } finally {
      if (prev === undefined) delete process.env.KYA_MCP_HTTP_TOKEN;
      else process.env.KYA_MCP_HTTP_TOKEN = prev;
    }
  });
});

describe("MCP host lock", () => {
  it("policy_evaluate ignores tool host and uses operator ctx.host", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.env.host).toBe("runtime");
      return new Response(
        JSON.stringify({
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          toolId: body.toolId,
          host: body.env.host,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new KyaHttpClient({
      baseUrl: baseConfig.baseUrl,
      apiKey: baseConfig.apiKey,
      host: "runtime",
      fetch: fetchImpl,
    });
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read", host: "ide" },
      { client, host: "runtime" },
    );
    expect(result.isError).toBeFalsy();
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("stdio MCP", () => {
  it("answers tools/list over newline JSON-RPC", async () => {
    const { Readable, PassThrough } = await import("node:stream");
    const { startStdioMcp } = await import("../src/mcp/stdio.js");
    const client = mockClient();
    const input = new Readable({
      read() {
        /* push below */
      },
    });
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const handle = startStdioMcp({
      client,
      kyaHost: "ide",
      agentId: baseConfig.agentId,
      input,
      output,
      bare: true,
    });

    input.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }) + "\n",
    );
    input.push(null);

    await handle.done;
    await new Promise((r) => setTimeout(r, 20));
    const joined = chunks.join("");
    expect(joined).toContain("kya.policy_evaluate");
    handle.close();
  });
});
