import { describe, expect, it, vi } from "vitest";
import {
  buildEvaluateFromToolArgs,
  KyaHttpClient,
} from "../src/client.js";
import { AuthRequiredError, HttpError } from "../src/errors.js";
import { computeArgsHash } from "../src/hash.js";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("KyaHttpClient", () => {
  it("refuses empty api key", () => {
    expect(
      () =>
        new KyaHttpClient({
          baseUrl: "http://127.0.0.1:8090",
          apiKey: "",
        }),
    ).toThrow(AuthRequiredError);
  });

  it("POSTs register agent with bearer auth", async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:8090/api/v1/kya/agents");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk_test");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "solo-builder",
        versionHash: "dev-local",
      });
      return new Response(
        JSON.stringify({
          id: "11111111-1111-1111-1111-111111111111",
          name: "solo-builder",
          status: "ACTIVE",
          versionHash: "dev-local",
        }),
        { status: 201 },
      );
    });

    const client = new KyaHttpClient({
      baseUrl: "http://127.0.0.1:8090",
      apiKey: "sk_test",
      fetch: fetchImpl,
    });
    const agent = await client.registerAgent({
      name: "solo-builder",
      versionHash: "dev-local",
    });
    expect(agent.id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("POSTs policy evaluate with sample tool metadata", async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      expect(url).toContain("/api/v1/kya/policy/evaluate");
      const body = JSON.parse(String(init?.body));
      expect(body.toolId).toBe("org.sample.never.event");
      expect(body.irreversible).toBe(true);
      expect(body.actionClass).toBe("EXTERNAL_SIDE_EFFECT");
      expect(body.env.host).toBe("ide");
      return new Response(
        JSON.stringify({
          verdict: "DENY",
          reasonCode: "NEVER_EVENT",
          toolId: "org.sample.never.event",
          localVerdict: "DENY",
          sessionRisk: "LOW",
        }),
        { status: 200 },
      );
    });

    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      host: "ide",
      fetch: fetchImpl,
    });
    const res = await client.evaluatePolicy({
      toolId: "org.sample.never.event",
      irreversible: true,
      argsHash: computeArgsHash({ target: "x" }),
    });
    expect(res.verdict).toBe("DENY");
    expect(res.reasonCode).toBe("NEVER_EVENT");
  });

  it("maps 401 to AuthRequiredError", async () => {
    const fetchImpl = mockFetch(async () => new Response("nope", { status: 401 }));
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "bad",
      fetch: fetchImpl,
    });
    await expect(
      client.evaluatePolicy({ toolId: "org.sample.safe.read" }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("maps other errors to HttpError", async () => {
    const fetchImpl = mockFetch(
      async () =>
        new Response(JSON.stringify({ message: "rate limited" }), { status: 429 }),
    );
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      fetch: fetchImpl,
    });
    await expect(
      client.evaluatePolicy({ toolId: "org.sample.safe.read" }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("ingests session and requests approval", async () => {
    const calls: string[] = [];
    const fetchImpl = mockFetch(async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (url.includes("/sessions/ingest")) {
        return new Response(
          JSON.stringify({ id: "sess-1", riskLevel: "LOW", host: "ide" }),
          { status: 202 },
        );
      }
      return new Response(
        JSON.stringify({ id: "appr-1", status: "PENDING" }),
        { status: 201 },
      );
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      host: "ide",
      fetch: fetchImpl,
    });
    const ing = await client.ingestSession({ sessionId: "s1", host: "ide" });
    expect(ing.riskLevel).toBe("LOW");
    const ap = await client.requestApproval({
      agentId: "11111111-1111-1111-1111-111111111111",
      disputeId: "22222222-2222-2222-2222-222222222222",
      toolId: "org.sample.data.write",
    });
    expect(ap.status).toBe("PENDING");
    expect(calls).toHaveLength(2);
  });
});

describe("buildEvaluateFromToolArgs", () => {
  it("hashes args canonically", () => {
    const req = buildEvaluateFromToolArgs({
      toolId: "org.sample.data.write",
      args: { key: "greeting", value: "hi" },
      irreversible: true,
      host: "runtime",
    });
    expect(req.argsHash).toBe(
      computeArgsHash({ key: "greeting", value: "hi" }),
    );
    expect(req.env?.host).toBe("runtime");
  });
});
