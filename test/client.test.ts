import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEvaluateFromToolArgs,
  KyaHttpClient,
} from "../src/client.js";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { AuthRequiredError, clientSafeError, HttpError, KyaError } from "../src/errors.js";
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

  it("POSTs register agent with X-API-Key for sk_ tokens", async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:8090/api/v1/kya/agents");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-API-Key"]).toBe("sk_test");
      expect(headers.Authorization).toBeUndefined();
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

  it("lists agents via GET /api/v1/kya/agents", async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      expect(url).toBe("http://plane/api/v1/kya/agents");
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(
        JSON.stringify([{ id: "a1", name: "solo", status: "ACTIVE" }]),
        { status: 200 },
      );
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk_live_x",
      fetch: fetchImpl,
    });
    const rows = await client.listAgents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("solo");
  });

  it("shrinks a session", async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      expect(url).toBe("http://plane/api/v1/kya/sessions/sess-1/shrink");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ to: "BUILD" });
      return new Response(
        JSON.stringify({ id: "sess-1", from: "DEPLOY", to: "BUILD" }),
        { status: 200 },
      );
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk_live_x",
      fetch: fetchImpl,
    });
    const out = await client.shrinkSession("sess-1", "BUILD");
    expect(out.to).toBe("BUILD");
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

  it("evaluatePolicy serializes change fields and omits them when absent", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = mockFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ verdict: "ALLOW", reasonCode: "OK" }),
        { status: 200 },
      );
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      host: "ide",
      fetch: fetchImpl,
    });

    await client.evaluatePolicy({
      toolId: "Write",
      summary: "write src/app.ts (12 chars)",
      diffPreview: "  const a = 1;",
      targetPath: "src/app.ts",
    });
    expect(bodies[0]?.summary).toBe("write src/app.ts (12 chars)");
    expect(bodies[0]?.diffPreview).toBe("  const a = 1;");
    expect(bodies[0]?.targetPath).toBe("src/app.ts");

    await client.evaluatePolicy({ toolId: "org.sample.safe.read" });
    expect("summary" in (bodies[1] ?? {})).toBe(false);
    expect("diffPreview" in (bodies[1] ?? {})).toBe(false);
    expect("targetPath" in (bodies[1] ?? {})).toBe(false);
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

  it("POSTs human approve and reject on the decide path", async () => {
    const fetchImpl = mockFetch(async (url, init) => {
      expect(init?.method).toBe("POST");
      if (url.endsWith("/approvals/appr-1/approve")) {
        return new Response(
          JSON.stringify({ id: "appr-1", status: "APPROVED" }),
          { status: 200 },
        );
      }
      if (url.endsWith("/approvals/appr-1/reject")) {
        return new Response(
          JSON.stringify({ id: "appr-1", status: "REJECTED" }),
          { status: 200 },
        );
      }
      return new Response("no", { status: 404 });
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: "sk",
      fetch: fetchImpl,
    });
    const ok = await client.decideApproval("appr-1", "approve");
    expect(ok.status).toBe("APPROVED");
    const no = await client.decideApproval("appr-1", "reject");
    expect(no.status).toBe("REJECTED");
  });

  it("sends Bearer for JWT-shaped keys", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.e30.sig";
    const fetchImpl = mockFetch(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${jwt}`);
      expect(headers["X-API-Key"]).toBeUndefined();
      return new Response(
        JSON.stringify({ verdict: "ALLOW", reasonCode: "ALLOW" }),
        { status: 200 },
      );
    });
    const client = new KyaHttpClient({
      baseUrl: "http://plane",
      apiKey: jwt,
      fetch: fetchImpl,
    });
    await client.evaluatePolicy({ toolId: "org.sample.safe.read" });
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

describe("KyaHttpClient default timeout message", () => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  let controller: AbortController;

  beforeEach(() => {
    // The default signal is our controller, so a test can make it fire at once.
    controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Fake fetch: the default signal fires, then fetch rejects with a DOMException of this name. */
  const fireAndReject = (name: string) =>
    mockFetch(async (_url, init) => {
      const reason = new DOMException("The operation was aborted due to timeout", name);
      controller.abort(reason);
      expect(init?.signal?.aborted).toBe(true);
      throw reason;
    });

  for (const name of ["TimeoutError", "AbortError"]) {
    it(`maps ${name} from the default signal to a clear KyaError`, async () => {
      const client = new KyaHttpClient({
        baseUrl: "http://user:pw@127.0.0.1:8090/",
        apiKey: "sk_secret_value",
        fetch: fireAndReject(name),
      });
      const err = await client
        .request("/api/v1/kya/agents?token=s3cret#frag", { method: "POST", body: {} })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KyaError);
      expect(err).not.toBeInstanceOf(HttpError);
      const e = err as KyaError;
      expect(e.code).toBe("PLANE_HTTP_TIMEOUT");
      expect(e.exitCode).toBe(1);
      expect(e.message).toContain("POST http://127.0.0.1:8090/api/v1/kya/agents within 15 seconds");
      expect(e.message).toMatch(/base URL.*network.*try again/);
      expect(e.message).toContain("Hosted hooks are not affected");
      for (const secret of ["sk_secret_value", "s3cret", "frag", "user", "pw@"]) {
        expect(e.message).not.toContain(secret);
      }
      // The original error stays readable for SDK users.
      expect((e.cause as Error).name).toBe(name);
    });
  }

  it("adds the leading slash to a path without one, as the request URL does", async () => {
    let requested = "";
    const client = new KyaHttpClient({
      baseUrl: "https://plane.example/prefix",
      apiKey: "sk_test",
      fetch: mockFetch(async (url, init) => {
        requested = String(url);
        return fireAndReject("TimeoutError")(url, init);
      }),
    });
    await expect(client.request("api/v1/kya/agents")).rejects.toMatchObject({
      code: "PLANE_HTTP_TIMEOUT",
      message: expect.stringContaining("GET https://plane.example/prefix/api/v1/kya/agents within"),
    });
    expect(requested).toBe("https://plane.example/prefix/api/v1/kya/agents");
  });

  it("keeps the base URL path prefix in the message", async () => {
    const client = new KyaHttpClient({
      baseUrl: "https://plane.example:8443/prefix/?q=1#f",
      apiKey: "sk_test",
      fetch: fireAndReject("TimeoutError"),
    });
    await expect(client.listAgents()).rejects.toMatchObject({
      code: "PLANE_HTTP_TIMEOUT",
      message: expect.stringContaining(
        "GET https://plane.example:8443/prefix/api/v1/kya/agents within",
      ),
    });
  });

  it("maps a timeout during the body read", async () => {
    const client = new KyaHttpClient({
      baseUrl: "http://127.0.0.1:8090",
      apiKey: "sk_test",
      fetch: mockFetch(async () => ({
        ok: true,
        status: 200,
        text: async () => {
          const reason = new DOMException("timeout", "TimeoutError");
          controller.abort(reason);
          throw reason;
        },
      }) as unknown as Response),
    });
    await expect(client.listAgents()).rejects.toMatchObject({
      code: "PLANE_HTTP_TIMEOUT",
      message: expect.stringContaining("GET http://127.0.0.1:8090/api/v1/kya/agents"),
    });
  });

  it("keeps an AbortError from the fetch itself when the default signal did not fire", async () => {
    const original = new DOMException("aborted by an injected fetch", "AbortError");
    const client = new KyaHttpClient({
      baseUrl: "http://127.0.0.1:8090",
      apiKey: "sk_test",
      fetch: mockFetch(async () => {
        throw original;
      }),
    });
    await expect(client.listAgents()).rejects.toBe(original);
  });

  it("keeps the caller's own abort error when the caller passes a signal", async () => {
    const caller = new AbortController();
    const original = new DOMException("caller aborted", "AbortError");
    caller.abort(original);
    const client = new KyaHttpClient({
      baseUrl: "http://127.0.0.1:8090",
      apiKey: "sk_test",
      fetch: mockFetch(async (_url, init) => {
        expect(init?.signal).toBe(caller.signal);
        throw original;
      }),
    });
    const err = await client
      .request("/api/v1/kya/agents", { signal: caller.signal })
      .catch((e: unknown) => e);
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(KyaError);
  });

  it("does not remap other network errors", async () => {
    const original = new TypeError("fetch failed");
    const client = new KyaHttpClient({
      baseUrl: "http://127.0.0.1:8090",
      apiKey: "sk_test",
      fetch: mockFetch(async () => {
        throw original;
      }),
    });
    await expect(client.listAgents()).rejects.toBe(original);
  });

  it("gives MCP clients only a short text: no host, no path", () => {
    const err = new KyaError(
      "control plane did not answer POST https://kya-plane.corp.internal:8443/tenant-acme/api/v1/kya/policy/evaluate",
      "PLANE_HTTP_TIMEOUT",
    );
    expect(clientSafeError(err)).toBe("control plane timeout");
  });

  // ponytail: the 15 s default has no override. This e2e test shortens only
  // AbortSignal.timeout to 200 ms. The real global fetch, the real default
  // signal path and a real socket that never answers do the rest.
  it("e2e: a local server that never answers gives the clear message", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(200));
    const sockets = new Set<Socket>();
    const server = createServer((s) => {
      sockets.add(s);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new KyaHttpClient({
        baseUrl: `http://127.0.0.1:${port}/prefix`,
        apiKey: "sk_e2e_secret",
      });
      const err = (await client
        .evaluatePolicy({ toolId: "shell.exec", argsHash: "0".repeat(64) } as never)
        .catch((e: unknown) => e)) as KyaError;
      expect(err).toBeInstanceOf(KyaError);
      expect(err.code).toBe("PLANE_HTTP_TIMEOUT");
      expect((err.cause as Error).name).toBe("TimeoutError");
      expect(err.message).toContain(
        `control plane did not answer POST http://127.0.0.1:${port}/prefix/api/v1/kya/policy/evaluate within 15 seconds`,
      );
      expect(err.message).not.toContain("sk_e2e_secret");
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
