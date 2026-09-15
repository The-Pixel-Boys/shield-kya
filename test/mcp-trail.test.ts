import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyaHttpClient } from "../src/client.js";
import { computeArgsHash } from "../src/hash.js";
import { handleMcpToolCall, type McpHandlerContext } from "../src/mcp/protocol.js";
import { readTrail, trailPath } from "../src/trail.js";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Client whose plane is unreachable (connection refused). */
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

function mockClient(): KyaHttpClient {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/policy/evaluate")) {
      const body = JSON.parse(String(init?.body));
      const deny = body.toolId === "org.sample.never.event";
      return new Response(
        JSON.stringify({
          verdict: deny ? "DENY" : "ALLOW",
          reasonCode: deny ? "NEVER_EVENT" : "ALLOW",
          toolId: body.toolId,
        }),
        { status: 200 },
      );
    }
    if (String(url).includes("/sessions/ingest")) {
      return new Response(
        JSON.stringify({ id: "id-1", riskLevel: "LOW" }),
        { status: 202 },
      );
    }
    if (String(url).includes("/approvals")) {
      return new Response(JSON.stringify({ id: "ap-1", status: "PENDING" }), {
        status: 201,
      });
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

describe("MCP trail recording", () => {
  let cwd: string;
  let prevSession: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kya-mcp-trail-"));
    prevSession = process.env.KYA_SESSION_ID;
    process.env.KYA_SESSION_ID = "mcp:test";
  });

  afterEach(() => {
    if (prevSession === undefined) delete process.env.KYA_SESSION_ID;
    else process.env.KYA_SESSION_ID = prevSession;
    rmSync(cwd, { recursive: true, force: true });
  });

  function ctx(over: Partial<McpHandlerContext> = {}): McpHandlerContext {
    return {
      client: mockClient(),
      host: "ide",
      agentId: AGENT_ID,
      trail: { cwd, offline: true, holdEnabled: false },
      ...over,
    };
  }

  it("policy_evaluate appends exactly one well-formed trail line", async () => {
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.never.event", args: { target: "x" } },
      ctx(),
    );
    expect(result.isError).toBeFalsy();

    const lines = readFileSync(trailPath(cwd), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const [event] = readTrail(cwd);
    expect(event).toMatchObject({
      sessionId: "mcp:test",
      host: "ide",
      toolId: "org.sample.never.event",
      verdict: "DENY",
      reasonCode: "NEVER_EVENT",
      mode: "offline",
      neverEvent: true,
      argsHash: computeArgsHash({ target: "x" }),
    });
    expect(event!.summary).toBeUndefined();
    expect(Date.parse(event!.ts)).not.toBeNaN();
  });

  it("mode is observe by default and hold when holdEnabled", async () => {
    await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read" },
      ctx({ trail: { cwd, offline: false, holdEnabled: false } }),
    );
    await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read" },
      ctx({ trail: { cwd, offline: false, holdEnabled: true } }),
    );
    const events = readTrail(cwd);
    expect(events.map((e) => e.mode)).toEqual(["observe", "hold"]);
  });

  it("request_approval records a REQUIRE_APPROVE row", async () => {
    await handleMcpToolCall(
      "kya.request_approval",
      { action: "org.sample.data.write", summary: "write" },
      ctx(),
    );
    const events = readTrail(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      toolId: "org.sample.data.write",
      verdict: "REQUIRE_APPROVE",
    });
  });

  it("session_ingest records nothing (metadata would flood the feed)", async () => {
    const result = await handleMcpToolCall(
      "kya.session_ingest",
      { session: { sessionId: "s1", tools: ["org.sample.safe.read"] } },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(trailPath(cwd))).toBe(false);
  });

  it("without a trail context nothing is recorded", async () => {
    const bare: McpHandlerContext = {
      client: mockClient(),
      host: "ide",
      agentId: AGENT_ID,
    };
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read" },
      bare,
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(trailPath(cwd))).toBe(false);
  });

  it("a failing trail write never breaks the tool result", async () => {
    // .kya exists as a regular file — appendTrail cannot mkdir/append.
    writeFileSync(join(cwd, ".kya"), "not a dir", "utf8");
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.never.event", args: { target: "x" } },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.verdict).toBe("DENY");
  });

  it("mkdir failure on read-only parent still returns the verdict", async () => {
    const ro = join(cwd, "ro");
    mkdirSync(ro);
    writeFileSync(join(ro, ".kya"), "block", "utf8");
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read" },
      ctx({ trail: { cwd: ro, offline: true, holdEnabled: false } }),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).verdict).toBe("ALLOW");
  });
});

describe("MCP offline evaluate + fail-closed recording", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kya-mcp-offline-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("offline server evaluates locally and records an offline row (no plane)", async () => {
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.never.event", args: { target: "x" } },
      {
        client: deadClient(),
        host: "ide",
        offline: true,
        trail: { cwd, offline: true, holdEnabled: false },
      },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text);
    expect(body.verdict).toBe("DENY");
    expect(body.reasonCode).toBe("NEVER_EVENT");

    const events = readTrail(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      toolId: "org.sample.never.event",
      verdict: "DENY",
      reasonCode: "NEVER_EVENT",
      mode: "offline",
      neverEvent: true,
    });
  });

  it("offline unknown irreversible tool gets REQUIRE_APPROVE, not an error", async () => {
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "some.unknown.tool", irreversible: true },
      {
        client: deadClient(),
        host: "ide",
        offline: true,
        trail: { cwd, offline: true, holdEnabled: false },
      },
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).verdict).toBe("REQUIRE_APPROVE");
  });

  it("stdio MCP session with KYA_OFFLINE=1 and no plane returns verdicts and records", async () => {
    const { Readable, PassThrough } = await import("node:stream");
    const { startStdioMcp } = await import("../src/mcp/stdio.js");
    const input = new Readable({
      read() {
        /* push below */
      },
    });
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

    const handle = startStdioMcp({
      client: deadClient(),
      kyaHost: "ide",
      offline: true,
      trail: { cwd, offline: true, holdEnabled: false },
      input,
      output,
      bare: true,
    });

    input.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "kya.policy_evaluate",
          arguments: { toolId: "org.sample.data.write", args: { k: "v" } },
        },
      }) + "\n",
    );
    input.push(null);
    await handle.done;
    await new Promise((r) => setTimeout(r, 20));
    handle.close();

    const response = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: number; result?: { isError: boolean; content: { text: string }[] } })
      .find((m) => m.id === 1);
    expect(response?.result?.isError).toBe(false);
    const body = JSON.parse(response!.result!.content[0]!.text);
    expect(body.verdict).toBe("REQUIRE_APPROVE");

    const events = readTrail(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      toolId: "org.sample.data.write",
      verdict: "REQUIRE_APPROVE",
      mode: "offline",
    });
  });

  it("non-offline with unreachable plane errors AND records a fail-closed row", async () => {
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read", args: { path: "a" } },
      {
        client: deadClient(),
        host: "ide",
        trail: { cwd, offline: false, holdEnabled: false },
      },
    );
    expect(result.isError).toBe(true);

    const events = readTrail(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      toolId: "org.sample.safe.read",
      verdict: "DENY",
      reasonCode: "PLANE_UNREACHABLE",
      mode: "observe",
    });
  });

  it("plane reached but rejecting auth records PLANE_AUTH_REJECTED", async () => {
    const rejecting = new KyaHttpClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "sk_bad",
      host: "ide",
      fetch: (async () =>
        new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    });
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read" },
      {
        client: rejecting,
        host: "ide",
        trail: { cwd, offline: false, holdEnabled: false },
      },
    );
    expect(result.isError).toBe(true);

    const events = readTrail(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      toolId: "org.sample.safe.read",
      verdict: "DENY",
      reasonCode: "PLANE_AUTH_REJECTED",
    });
  });

  it("fail-closed recording never changes the error result", async () => {
    writeFileSync(join(cwd, ".kya"), "not a dir", "utf8");
    const result = await handleMcpToolCall(
      "kya.policy_evaluate",
      { toolId: "org.sample.safe.read" },
      {
        client: deadClient(),
        host: "ide",
        trail: { cwd, offline: false, holdEnabled: false },
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toBeTruthy();
  });

  it("offline session_ingest still records nothing", async () => {
    const result = await handleMcpToolCall(
      "kya.session_ingest",
      { session: { sessionId: "s1", tools: ["x"] } },
      {
        client: mockClient(),
        host: "ide",
        offline: true,
        trail: { cwd, offline: true, holdEnabled: false },
      },
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(trailPath(cwd))).toBe(false);
  });
});
