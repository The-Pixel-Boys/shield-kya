/**
 * Alert routing for trail verdicts (src/notify). Real local HTTP server (node:http) for the wire
 * paths; injected sleep / random / nowMs keep retry-backoff, circuit and rate-limit tests fast and
 * deterministic. No fake timers: the module takes a sleep seam instead.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NOTIFY_KIND,
  allowedEventFields,
  buildMinimizedPayload,
  buildPayload,
  notifyOnTrailEvent,
  notifyStats,
  resetNotifyState,
  resolveWebhooks,
  type NotifyDeps,
} from "../src/notify/index.js";
import { RATE_LIMIT_MAX_SENDS, RETRY_DELAYS_MS } from "../src/notify/sender.js";
import type { TrailEvent } from "../src/trail.js";

interface Recorded {
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

interface Stub {
  readonly base: string;
  readonly requests: Recorded[];
  /** Status returned once failuresBeforeOk is exhausted. */
  okStatus: number;
  /** How many requests get failStatus first. */
  failuresBeforeOk: number;
  failStatus: number;
  /** Delay before answering, to exercise the per-attempt timeout. */
  delayMs: number;
  close(): Promise<void>;
}

const stubs: Stub[] = [];

async function startStub(over: Partial<Pick<Stub, "okStatus" | "failuresBeforeOk" | "failStatus" | "delayMs">> = {}): Promise<Stub> {
  const requests: Recorded[] = [];
  const stub: Stub = {
    base: "",
    requests,
    okStatus: over.okStatus ?? 200,
    failuresBeforeOk: over.failuresBeforeOk ?? 0,
    failStatus: over.failStatus ?? 500,
    delayMs: over.delayMs ?? 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.on("error", () => undefined);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      requests.push({ headers: req.headers, body });
      const status = stub.failuresBeforeOk > 0 ? stub.failStatus : stub.okStatus;
      stub.failuresBeforeOk = Math.max(0, stub.failuresBeforeOk - 1);
      const answer = () => {
        try {
          res.statusCode = status;
          res.end("{}");
        } catch {
          /* client may have aborted on timeout */
        }
      };
      if (stub.delayMs > 0) setTimeout(answer, stub.delayMs);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (stub as { base: string }).base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  stubs.push(stub);
  return stub;
}

const baseEvent = (over: Partial<TrailEvent> = {}): TrailEvent => ({
  ts: "2026-10-09T12:00:00.000Z",
  sessionId: "sess-1",
  host: "claude",
  product: "claude",
  project: "demo",
  toolId: "shell.exec",
  verdict: "DENY",
  reasonCode: "NEVER_COMMAND",
  mode: "observe",
  summary: "rm -rf build/",
  targetPath: "src/index.ts",
  ...over,
});

/** No real waiting, deterministic jitter (0) unless overridden. */
const fastDeps = (extra: Partial<NotifyDeps> = {}): NotifyDeps => ({
  sleep: async () => {},
  random: () => 0,
  ...extra,
});

beforeEach(() => resetNotifyState());

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

describe("templates", () => {
  it("generic payload carries kind plus allow-listed event fields only", () => {
    const p = buildPayload("generic", baseEvent({ argsHash: "h", diffPreview: "SECRET DIFF" }));
    expect(p["kind"]).toBe(NOTIFY_KIND);
    const event = p["event"] as Record<string, unknown>;
    expect(event["toolId"]).toBe("shell.exec");
    expect(event["verdict"]).toBe("DENY");
    expect(event).not.toHaveProperty("argsHash");
    expect(event).not.toHaveProperty("diffPreview");
    expect(Object.keys(event).sort()).toEqual(Object.keys(allowedEventFields(baseEvent())).sort());
  });

  it("slack payload has a text fallback and Block Kit blocks", () => {
    const p = buildPayload("slack", baseEvent());
    expect(typeof p["text"]).toBe("string");
    expect(p["text"]).toContain("DENY");
    expect(p["text"]).toContain("shell.exec");
    const blocks = p["blocks"] as { type: string }[];
    expect(blocks[0]?.type).toBe("header");
    expect(blocks.some((b) => b.type === "section")).toBe(true);
  });

  it("linear payload is create-issue-shaped, DENY urgent / REQUIRE_APPROVE high", () => {
    const deny = buildPayload("linear", baseEvent());
    expect(deny["title"]).toContain("DENY");
    expect(typeof deny["description"]).toBe("string");
    expect(deny["priority"]).toBe(1);
    const hold = buildPayload("linear", baseEvent({ verdict: "REQUIRE_APPROVE" }));
    expect(hold["priority"]).toBe(2);
  });

  it("jira payload is create-issue-shaped", () => {
    const p = buildPayload("jira", baseEvent());
    const fields = p["fields"] as Record<string, unknown>;
    expect(fields["summary"]).toContain("shell.exec");
    expect(typeof fields["description"]).toBe("string");
    expect(fields["issuetype"]).toEqual({ name: "Task" });
  });

  it("minimized payload is exactly toolId / verdict / reasonCode / ts", () => {
    expect(buildMinimizedPayload(baseEvent())).toEqual({
      toolId: "shell.exec",
      verdict: "DENY",
      reasonCode: "NEVER_COMMAND",
      ts: "2026-10-09T12:00:00.000Z",
    });
  });
});

describe("config resolution", () => {
  it("parses valid entries, drops garbage, appends the env override as generic", async () => {
    const stub = await startStub();
    const envStub = await startStub();
    const hooks = resolveWebhooks(
      {
        notify: {
          webhooks: [
            { url: stub.base, template: "slack", events: ["DENY"], headers: { "x-api-key": "k" }, timeoutMs: 500 },
            { url: "not a url" },
            "junk",
            { url: "ftp://example.com/x" },
          ],
        },
      },
      { KYA_NOTIFY_WEBHOOK: envStub.base },
    );
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toMatchObject({ url: stub.base, template: "slack", events: ["DENY"], timeoutMs: 500 });
    expect(hooks[1]).toMatchObject({ url: envStub.base, template: "generic", events: ["DENY", "REQUIRE_APPROVE"] });
  });

  it("empty or missing notify config resolves to no webhooks", () => {
    expect(resolveWebhooks(undefined, {})).toEqual([]);
    expect(resolveWebhooks({}, {})).toEqual([]);
    expect(resolveWebhooks({ notify: { webhooks: [] } }, {})).toEqual([]);
  });
});

describe("verdict filtering", () => {
  it("ALLOW never fires; DENY and REQUIRE_APPROVE fire", async () => {
    const stub = await startStub();
    const config = { notify: { webhooks: [{ url: stub.base }] } };
    await notifyOnTrailEvent(baseEvent({ verdict: "ALLOW" }), config, {}, fastDeps());
    expect(stub.requests).toHaveLength(0);
    await notifyOnTrailEvent(baseEvent({ verdict: "DENY" }), config, {}, fastDeps());
    await notifyOnTrailEvent(baseEvent({ verdict: "REQUIRE_APPROVE" }), config, {}, fastDeps());
    expect(stub.requests).toHaveLength(2);
  });

  it("per-webhook events list narrows the verdicts", async () => {
    const stub = await startStub();
    const config = { notify: { webhooks: [{ url: stub.base, events: ["DENY"] }] } };
    await notifyOnTrailEvent(baseEvent({ verdict: "REQUIRE_APPROVE" }), config, {}, fastDeps());
    expect(stub.requests).toHaveLength(0);
    await notifyOnTrailEvent(baseEvent({ verdict: "DENY" }), config, {}, fastDeps());
    expect(stub.requests).toHaveLength(1);
  });

  it("env override alone fires a generic payload", async () => {
    const stub = await startStub();
    await notifyOnTrailEvent(baseEvent(), undefined, { KYA_NOTIFY_WEBHOOK: stub.base }, fastDeps());
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.body["kind"]).toBe(NOTIFY_KIND);
  });

  it("webhook headers reach the receiver", async () => {
    const stub = await startStub();
    const config = { notify: { webhooks: [{ url: stub.base, headers: { "x-hook-token": "abc123" } }] } };
    await notifyOnTrailEvent(baseEvent(), config, {}, fastDeps());
    expect(stub.requests[0]?.headers["x-hook-token"]).toBe("abc123");
  });
});

describe("retry and backoff", () => {
  it("retries on 5xx with the configured backoff sequence and succeeds", async () => {
    const stub = await startStub({ failuresBeforeOk: 2 });
    const delays: number[] = [];
    const deps = fastDeps({ sleep: async (ms) => { delays.push(ms); } });
    await notifyOnTrailEvent(baseEvent(), { notify: { webhooks: [{ url: stub.base }] } }, {}, deps);
    expect(stub.requests).toHaveLength(3);
    expect(delays).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]);
  });

  it("jitter is bounded at +25% of the base delay", async () => {
    const stub = await startStub({ failuresBeforeOk: 1 });
    const delays: number[] = [];
    const deps = fastDeps({ sleep: async (ms) => { delays.push(ms); }, random: () => 0.999 });
    await notifyOnTrailEvent(baseEvent(), { notify: { webhooks: [{ url: stub.base }] } }, {}, deps);
    expect(delays[0]).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[0] ?? 0);
    expect(delays[0]).toBeLessThanOrEqual(Math.floor((RETRY_DELAYS_MS[0] ?? 0) * 1.25));
  });

  it("gives up after the initial attempt plus 3 retries", async () => {
    const stub = await startStub({ failuresBeforeOk: 99 });
    await notifyOnTrailEvent(baseEvent(), { notify: { webhooks: [{ url: stub.base }] } }, {}, fastDeps());
    expect(stub.requests).toHaveLength(1 + RETRY_DELAYS_MS.length);
  });
});

describe("timeout", () => {
  it("aborts a slow receiver after timeoutMs and still retries", async () => {
    const stub = await startStub({ delayMs: 300 });
    const started = Date.now();
    await notifyOnTrailEvent(
      baseEvent(),
      { notify: { webhooks: [{ url: stub.base, timeoutMs: 50 }] } },
      {},
      fastDeps(),
    );
    expect(Date.now() - started).toBeLessThan(300 * (1 + RETRY_DELAYS_MS.length));
    expect(stub.requests.length).toBeGreaterThanOrEqual(1);
  });
});

describe("circuit breaker", () => {
  it("opens after 5 consecutive failed deliveries and drops while open", async () => {
    const stub = await startStub({ failuresBeforeOk: 999 });
    let now = 1_000_000;
    const deps = fastDeps({ nowMs: () => now });
    const config = { notify: { webhooks: [{ url: stub.base }] } };
    for (let i = 0; i < 5; i++) {
      await notifyOnTrailEvent(baseEvent(), config, {}, deps);
      now += 61_000; // keep the rate-limit window out of this test
    }
    const requestsAfterFive = stub.requests.length;
    expect(notifyStats().droppedByCircuitOpen).toBe(0);
    await notifyOnTrailEvent(baseEvent(), config, {}, deps);
    expect(stub.requests).toHaveLength(requestsAfterFive);
    expect(notifyStats().droppedByCircuitOpen).toBe(1);
  });

  it("half-opens after the cooldown and closes on success", async () => {
    const failing = await startStub({ failuresBeforeOk: 999 });
    let now = 2_000_000;
    const deps = fastDeps({ nowMs: () => now });
    const config = { notify: { webhooks: [{ url: failing.base }] } };
    for (let i = 0; i < 5; i++) {
      await notifyOnTrailEvent(baseEvent(), config, {}, deps);
      now += 61_000;
    }
    now += 5 * 60_000 + 1_000; // past CIRCUIT_OPEN_MS
    failing.failuresBeforeOk = 0; // receiver healthy again
    await notifyOnTrailEvent(baseEvent(), config, {}, deps);
    expect(stubRequests(failing)).toBe(5 * (1 + RETRY_DELAYS_MS.length) + 1);
    // And the circuit is closed again: the next event flows without a drop.
    now += 61_000;
    await notifyOnTrailEvent(baseEvent(), config, {}, deps);
    expect(notifyStats().droppedByCircuitOpen).toBe(0);
    expect(stubRequests(failing)).toBe(5 * (1 + RETRY_DELAYS_MS.length) + 2);
  });
});

function stubRequests(stub: Stub): number {
  return stub.requests.length;
}

describe("rate limit", () => {
  it("caps sends per rolling minute and counts the drops", async () => {
    const stub = await startStub();
    const now = 3_000_000; // frozen clock: nothing evicts from the window
    const deps = fastDeps({ nowMs: () => now });
    const config = { notify: { webhooks: [{ url: stub.base }] } };
    const total = RATE_LIMIT_MAX_SENDS + 5;
    for (let i = 0; i < total; i++) {
      await notifyOnTrailEvent(baseEvent(), config, {}, deps);
    }
    expect(stub.requests).toHaveLength(RATE_LIMIT_MAX_SENDS);
    expect(notifyStats().droppedByRateLimit).toBe(5);
  });
});

describe("secrets hygiene", () => {
  it("falls back to the minimized payload when the serialized body trips assertNoSecrets", async () => {
    const stub = await startStub();
    const event = baseEvent({ summary: "token=sk_live_abcdef1234567890" });
    await notifyOnTrailEvent(event, { notify: { webhooks: [{ url: stub.base }] } }, {}, fastDeps());
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.body).toEqual({
      toolId: "shell.exec",
      verdict: "DENY",
      reasonCode: "NEVER_COMMAND",
      ts: "2026-10-09T12:00:00.000Z",
    });
  });

  it("clean redacted fields ship in full", async () => {
    const stub = await startStub();
    await notifyOnTrailEvent(baseEvent(), { notify: { webhooks: [{ url: stub.base }] } }, {}, fastDeps());
    const event = stub.requests[0]?.body["event"] as Record<string, unknown>;
    expect(event["summary"]).toBe("rm -rf build/");
    expect(event["targetPath"]).toBe("src/index.ts");
  });
});

describe("never throws", () => {
  it("dead receiver, malformed event fields and bad config all resolve", async () => {
    await expect(
      notifyOnTrailEvent(baseEvent(), { notify: { webhooks: [{ url: "http://127.0.0.1:1/hook" }] } }, {}, fastDeps()),
    ).resolves.toBeUndefined();
    await expect(
      notifyOnTrailEvent(
        baseEvent({ summary: undefined }),
        { notify: { webhooks: [{ url: 42 }, null] } },
        {},
        fastDeps(),
      ),
    ).resolves.toBeUndefined();
  });
});
