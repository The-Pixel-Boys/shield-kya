import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyaHttpClient } from "../src/client.js";
import { handleMcpToolCall, type McpHandlerContext } from "../src/mcp/protocol.js";
import { readTrail } from "../src/trail.js";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function mockClient(): KyaHttpClient {
  const fetchImpl = vi.fn(async (url: string) => {
    if (String(url).includes("/policy/evaluate")) {
      return new Response(
        JSON.stringify({ verdict: "ALLOW", reasonCode: "ALLOW" }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return new KyaHttpClient({
    baseUrl: "http://127.0.0.1:8090",
    apiKey: "sk_test",
    host: "ide",
    agentId: AGENT_ID,
    fetch: fetchImpl,
  });
}

function deadClient(): KyaHttpClient {
  const fetchImpl = vi.fn(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:1");
  }) as unknown as typeof fetch;
  return new KyaHttpClient({
    baseUrl: "http://127.0.0.1:1",
    apiKey: "",
    host: "ide",
    fetch: fetchImpl,
    requireApiKey: false,
  });
}

describe("MCP evaluate latency capture", () => {
  let cwd: string;
  let prevSession: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kya-mcp-latency-"));
    prevSession = process.env.KYA_SESSION_ID;
    process.env.KYA_SESSION_ID = "mcp:latency";
  });

  afterEach(() => {
    if (prevSession === undefined) delete process.env.KYA_SESSION_ID;
    else process.env.KYA_SESSION_ID = prevSession;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("online evaluate row carries latencyMs > 0", async () => {
    const ctx: McpHandlerContext = {
      client: mockClient(),
      host: "ide",
      agentId: AGENT_ID,
      trail: { cwd, offline: false, holdEnabled: false },
    };
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const [event] = readTrail(cwd);
    expect(typeof event!.latencyMs).toBe("number");
    expect(event!.latencyMs).toBeGreaterThan(0);
  });

  it("offline evaluator row carries latencyMs > 0", async () => {
    const ctx: McpHandlerContext = {
      client: deadClient(),
      host: "ide",
      offline: true,
      trail: { cwd, offline: true, holdEnabled: false },
    };
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.never.event" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const [event] = readTrail(cwd);
    expect(event!.mode).toBe("offline");
    expect(typeof event!.latencyMs).toBe("number");
    expect(event!.latencyMs).toBeGreaterThan(0);
  });

  it("fail-closed DENY row (unreachable plane) also carries latencyMs > 0", async () => {
    const ctx: McpHandlerContext = {
      client: deadClient(),
      host: "ide",
      trail: { cwd, offline: false, holdEnabled: false },
    };
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read" },
      ctx,
    );
    expect(result.isError).toBe(true);
    const [event] = readTrail(cwd);
    expect(event!.verdict).toBe("DENY");
    expect(typeof event!.latencyMs).toBe("number");
    expect(event!.latencyMs).toBeGreaterThan(0);
  });
});
