import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { busyWaitMs, KyaHttpClient } from "../src/client.js";
import { clientSafeError, HttpError, KyaError } from "../src/errors.js";
import { handleMcpToolCall } from "../src/mcp/protocol.js";

/** One canned answer. `retryAfter: null` sends no header. */
interface Reply {
  status: number;
  code?: string;
  retryAfter?: string | null;
  body?: unknown;
  /** Raw response text (for a body that is not JSON). */
  raw?: string;
}

const BUSY = (retryAfter: string | null = "0"): Reply => ({
  status: 503,
  code: "kya.approval_busy",
  retryAfter,
});
const OK: Reply = { status: 200, body: { id: "appr-1", status: "PENDING" } };

interface Plane {
  baseUrl: string;
  hits: { method: string; url: string; body: string }[];
  onHit?: () => void;
}

const servers: Server[] = [];

/** Real local HTTP plane. Answers from the queue; the last reply repeats forever. */
async function plane(queue: Reply[]): Promise<Plane> {
  const p: Plane = { baseUrl: "", hits: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      p.hits.push({ method: req.method ?? "", url: req.url ?? "", body });
      p.onHit?.();
      const r = (queue.length > 1 ? queue.shift() : queue[0]) as Reply;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (r.retryAfter != null) headers["Retry-After"] = r.retryAfter;
      const payload =
        r.body ??
        { error: { type: "X", code: r.code ?? "kya.other", message: "approval is busy; retry in a few seconds" } };
      res.writeHead(r.status, headers);
      res.end(r.raw ?? JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  p.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return p;
}

const client = (p: Plane) => new KyaHttpClient({ baseUrl: p.baseUrl, apiKey: "sk_test" });
const create = (c: KyaHttpClient, signal?: AbortSignal) =>
  c.requestApproval(
    { agentId: "agent-1", disputeId: "11111111-1111-1111-1111-111111111111", toolId: "org.data.write" },
    { signal },
  );

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("busy approval retry (real local HTTP server)", () => {
  it("503 kya.approval_busy then 200: the create succeeds with the same body", async () => {
    const p = await plane([BUSY(), OK]);
    const res = await create(client(p));
    expect(res).toMatchObject({ id: "appr-1", status: "PENDING" });
    expect(p.hits).toHaveLength(2);
    // Same work item on the retry: the plane dedups, no second approval.
    expect(p.hits[1]!.body).toBe(p.hits[0]!.body);
  });

  it("decide: 503 busy then 200 succeeds", async () => {
    const p = await plane([BUSY(), { status: 200, body: { id: "appr-1", status: "APPROVED" } }]);
    const res = await client(p).decideApproval("appr-1", "approve");
    expect(res.status).toBe("APPROVED");
    expect(p.hits.map((h) => h.url)).toEqual([
      "/api/v1/kya/approvals/appr-1/approve",
      "/api/v1/kya/approvals/appr-1/approve",
    ]);
  });

  it("honours Retry-After: 1 (waits 1 s to 1.2 s plus jitter)", async () => {
    const p = await plane([BUSY("1"), OK]);
    const t0 = performance.now();
    await create(client(p));
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(990);
    // Wide upper bound: CI load must not make this test flaky.
    expect(elapsed).toBeLessThan(3000);
    expect(p.hits).toHaveLength(2);
  });

  it("4 busy answers in a row: PLANE_BUSY after exactly 4 calls", async () => {
    // The 5th answer would be 200: a client with no retry limit would succeed.
    const p = await plane([BUSY(), BUSY(), BUSY(), BUSY(), OK]);
    const err = (await create(client(p)).catch((e: unknown) => e)) as KyaError;
    expect(err).toBeInstanceOf(KyaError);
    expect(err).not.toBeInstanceOf(HttpError);
    expect(err.code).toBe("PLANE_BUSY");
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe("approval service busy; retry later");
    expect((err.cause as HttpError).status).toBe(503);
    expect(p.hits).toHaveLength(4);
    // MCP clients get the fixed text only: no plane URL, no body.
    expect(clientSafeError(err)).toBe("approval service busy; retry later");
  });

  it("caller AbortSignal stops the wait at once", async () => {
    const p = await plane([BUSY("2"), OK]);
    const ac = new AbortController();
    const reason = new DOMException("caller stop", "AbortError");
    p.onHit = () => setTimeout(() => ac.abort(reason), 50);
    const t0 = Date.now();
    const err = await create(client(p), ac.signal).catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(p.hits).toHaveLength(1);
  });

  it("stops at the 20 s deadline instead of waiting past it", async () => {
    // Each plane hit moves the clock 15 s. A 10 s wait would end after the deadline.
    let now = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const p = await plane([BUSY("10"), OK]);
    p.onHit = () => (now += 15_000);
    const err = (await create(client(p)).catch((e: unknown) => e)) as KyaError;
    expect(err.code).toBe("PLANE_BUSY");
    expect(p.hits).toHaveLength(1);
  });

  for (const r of [
    { status: 500 },
    { status: 503, code: "kya.llm_unavailable" },
    { status: 409, code: "kya.approval_exists" },
    { status: 429, retryAfter: "0" },
    { status: 502, code: "kya.approval_busy" },
    { status: 503, raw: "<html><body>503 Service Unavailable</body></html>" },
    { status: 503, body: { code: "kya.approval_busy", error: { code: "kya.other" } } },
  ] as Reply[]) {
    it(`does not retry HTTP ${r.status} ${r.code ?? r.raw?.slice(0, 6) ?? "busy code in the wrong place"}`, async () => {
      const p = await plane([r, OK]);
      const err = (await create(client(p)).catch((e: unknown) => e)) as HttpError;
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(r.status);
      expect(p.hits).toHaveLength(1);
    });
  }

  it("does not retry calls that are not safe to send again (invoke, kill)", async () => {
    const p = await plane([BUSY(), OK]);
    const c = new KyaHttpClient({ baseUrl: p.baseUrl, apiKey: "sk_test", agentId: "agent-1" });
    const invoke = (await c.invokeTool({ toolId: "org.data.write" }).catch((e: unknown) => e)) as HttpError;
    expect(invoke).toBeInstanceOf(HttpError);
    expect(invoke.status).toBe(503);
    expect(p.hits).toHaveLength(1);
    const p2 = await plane([BUSY(), OK]);
    const kill = (await client(p2).killAgent("agent-1").catch((e: unknown) => e)) as HttpError;
    expect(kill.status).toBe(503);
    expect(p2.hits).toHaveLength(1);
  });

  it("MCP request_approval: a busy plane is an error, never an approval", async () => {
    const p = await plane([BUSY()]);
    const result = await handleMcpToolCall(
      "kya.request_approval",
      { action: "org.data.write", agentId: "agent-1" },
      { client: client(p), host: "ide", agentId: "agent-1" },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "approval service busy; retry later" });
    expect(p.hits).toHaveLength(4);
  });
});

describe("busyWaitMs", () => {
  const none = () => 0;
  const max = () => 1;

  it("uses delta-seconds and adds at most 20 percent jitter", () => {
    expect(busyWaitMs("1", none)).toBe(1000);
    expect(busyWaitMs("1", max)).toBe(1200);
    expect(busyWaitMs(" 3 ", none)).toBe(3000);
    expect(busyWaitMs("0", max)).toBe(0);
  });

  it("clamps a huge Retry-After to 10 s, jitter included", () => {
    expect(busyWaitMs("3600", none)).toBe(10_000);
    expect(busyWaitMs("99999999999999999999999", max)).toBe(10_000);
    expect(busyWaitMs("9", max)).toBe(10_000);
  });

  it("gives the 2 s default for a missing or bad value", () => {
    for (const v of [undefined, null, "", " ", "-5", "abc", "NaN", "1e3", "0x10", "2.5", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
      expect(busyWaitMs(v, none)).toBe(2000);
    }
  });
});
