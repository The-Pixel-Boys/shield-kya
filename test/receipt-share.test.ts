import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSharePayload,
  clampShareRetries,
  SHARE_DEFAULT_BASE_URL,
  shareBaseUrl,
  shareReceiptPayload,
  shareReceiptWithRetry,
  type SharePayload,
} from "../src/receipt/share.js";
import {
  buildWindowReceiptModel,
  type ReceiptModel,
} from "../src/receipt/render-receipt.js";
import {
  receiptInputFromArgs,
  runReceipt,
  runReceiptShare,
} from "../src/commands/receipt.js";
import { parseArgs } from "../src/parse-args.js";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { runCli, type CliIo } from "../src/cli.js";
import { appendTrail, type TrailEvent } from "../src/trail.js";

function ev(partial: Partial<TrailEvent> & Pick<TrailEvent, "ts" | "sessionId">): TrailEvent {
  return {
    toolId: "org.sample.safe.read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...partial,
  };
}

function richModel(): ReceiptModel {
  return buildWindowReceiptModel(
    [
      ev({ ts: "2026-10-01T10:00:00.000Z", sessionId: "sess-secret-1", product: "cursor", summary: "read agents file", targetPath: "/home/alice/secret/project/file.ts" }),
      ev({ ts: "2026-10-01T09:00:00.000Z", sessionId: "sess-secret-2", product: "claude", verdict: "DENY", reasonCode: "NEVER_EVENT", neverEvent: true }),
      ev({ ts: "2026-10-01T08:00:00.000Z", sessionId: "sess-secret-1", product: "cursor", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD_REVIEW" }),
    ],
    3,
    {
      searchQuery: "read",
      identity: { agentId: "agt-1", agentName: "bot", host: "ide", baseUrl: "http://10.0.0.1:8090" },
    },
  );
}

describe("buildSharePayload", () => {
  it("carries aggregates and labels only — no sessions, paths, tools, or identity", () => {
    const payload = buildSharePayload(richModel());
    expect(payload.version).toBe(1);
    expect(payload.title).toBe("Agent activity");
    expect(payload.rangeLabel).toBe("last 3 days");
    expect(payload.cliVersion).toBeTruthy();
    expect(payload.stats).toEqual({ total: 3, allow: 1, review: 1, deny: 1, never: 1, sessions: 2 });
    expect(payload.products).toEqual([
      { label: "Cursor", count: 2 },
      { label: "Claude Code", count: 1 },
    ]);
    expect(payload.reasonCodes).toEqual([
      { code: "ALLOW", count: 1 },
      { code: "HOLD_REVIEW", count: 1 },
      { code: "NEVER_EVENT", count: 1 },
    ]);
    expect(payload.certify).toBeNull();

    const serialized = JSON.stringify(payload);
    // Redaction: nothing identifying may leave the machine.
    expect(serialized).not.toContain("sess-secret");
    expect(serialized).not.toContain("/home/alice");
    expect(serialized).not.toContain("org.sample.safe.read");
    expect(serialized).not.toContain("10.0.0.1");
    expect(serialized).not.toContain("read agents file");
    expect(serialized).not.toContain("agt-1");
  });

  it("caps products at 6 and reason codes at 8", () => {
    const events: TrailEvent[] = [];
    for (let i = 0; i < 9; i++) {
      events.push(ev({ ts: `2026-10-01T0${i}:00:00.000Z`, sessionId: "s", product: `p${i}` as TrailEvent["product"], reasonCode: `R${i}` }));
    }
    const payload = buildSharePayload(buildWindowReceiptModel(events, 3, {}));
    expect(payload.products).toHaveLength(6);
    expect(payload.reasonCodes).toHaveLength(8);
  });

  it("maps the certify card when present", () => {
    const model = buildWindowReceiptModel([ev({ ts: "2026-10-01T10:00:00.000Z", sessionId: "s" })], 3, {
      certify: {
        result: "gap",
        pass: 10,
        gap: 2,
        insufficientEvidence: 1,
        attested: 3,
        windowDays: 30,
        trailEvents: 5,
        topGaps: [
          { id: "SOC-01", title: "Signed AUP", severity: "high", evidence: "no aup on file" },
          { id: "LOG-02", title: "Tamper-evident log", severity: "critical", evidence: "n/a" },
        ],
        requirements: [],
      },
    });
    const payload = buildSharePayload(model);
    expect(payload.certify).toEqual({
      status: "gap",
      pass: 10,
      gap: 2,
      insufficient: 1,
      attested: 3,
      topGaps: [
        { id: "SOC-01", severity: "high", title: "Signed AUP" },
        { id: "LOG-02", severity: "critical", title: "Tamper-evident log" },
      ],
    });
  });
});

describe("shareBaseUrl", () => {
  it("prefers the flag, then KYA_SHARE_URL, then the default", () => {
    expect(shareBaseUrl("https://flag.example/", {})).toBe("https://flag.example");
    expect(shareBaseUrl(undefined, { KYA_SHARE_URL: "https://env.example/" })).toBe("https://env.example");
    expect(shareBaseUrl(undefined, {})).toBe(SHARE_DEFAULT_BASE_URL);
    expect(shareBaseUrl("https://flag.example", { KYA_SHARE_URL: "https://env.example" })).toBe("https://flag.example");
  });
});

describe("shareReceiptPayload", () => {
  const payload = buildSharePayload(
    buildWindowReceiptModel([ev({ ts: "2026-10-01T10:00:00.000Z", sessionId: "s" })], 3, {}),
  );

  it("POSTs the payload and returns the public URL on 200/201", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ url: "https://shield-agent.com/share/abc123" }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await shareReceiptPayload(payload, { baseUrl: "https://api.example", fetchImpl });
    expect(result).toEqual({ ok: true, url: "https://shield-agent.com/share/abc123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example/api/v1/share/reports");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(payload);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails cleanly on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const result = await shareReceiptPayload(payload, { baseUrl: "https://api.example", fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("HTTP 500");
  });

  it("429 without Retry-After: 'retry later' text", async () => {
    const fetchImpl = vi.fn(async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch;
    const result = await shareReceiptPayload(payload, { baseUrl: "https://api.example", fetchImpl });
    expect(result).toEqual({
      ok: false,
      status: 429,
      retryAfterSeconds: undefined,
      error: "share failed: rate limited — retry later",
    });
  });

  it("429 with Retry-After 42: 'retry in ~42s' text", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("slow down", { status: 429, headers: { "Retry-After": "42" } }),
    ) as unknown as typeof fetch;
    const result = await shareReceiptPayload(payload, { baseUrl: "https://api.example", fetchImpl });
    expect(result).toEqual({
      ok: false,
      status: 429,
      retryAfterSeconds: 42,
      error: "share failed: rate limited — retry in ~42s",
    });
  });

  it("fails cleanly on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await shareReceiptPayload(payload, { baseUrl: "https://api.example", fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("connection refused");
  });

  it("fails cleanly when the response has no url", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const result = await shareReceiptPayload(payload, { baseUrl: "https://api.example", fetchImpl });
    expect(result.ok).toBe(false);
  });
});

describe("clampShareRetries", () => {
  it("clamps to max 3, negative/non-numeric → 0", () => {
    expect(clampShareRetries(undefined)).toBe(0);
    expect(clampShareRetries("0")).toBe(0);
    expect(clampShareRetries("2")).toBe(2);
    expect(clampShareRetries("9")).toBe(3);
    expect(clampShareRetries("-1")).toBe(0);
    expect(clampShareRetries("abc")).toBe(0);
  });
});

describe("shareReceiptWithRetry", () => {
  const payload = buildSharePayload(
    buildWindowReceiptModel([ev({ ts: "2026-10-01T10:00:00.000Z", sessionId: "s" })], 3, {}),
  );

  function scriptFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
    let i = 0;
    return vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!);
  }

  it("retries 429 (Retry-After) then 500 with bounded backoff, returns the 201 url", async () => {
    const fetchImpl = scriptFetch(
      new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }),
      new Response("boom", { status: 500 }),
      new Response(JSON.stringify({ url: "https://shield-agent.com/r/ok" }), { status: 201 }),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await shareReceiptWithRetry(payload, {
      baseUrl: "https://api.example",
      fetchImpl,
      retries: 2,
      sleep,
    });
    expect(result).toEqual({ ok: true, url: "https://shield-agent.com/r/ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // First delay honors Retry-After exactly (no jitter).
    expect(sleep.mock.calls[0]![0]).toBe(1000);
    // Second delay is exponential (2s) + uniform jitter 0–250ms.
    expect(sleep.mock.calls[1]![0]).toBeGreaterThanOrEqual(2000);
    expect(sleep.mock.calls[1]![0]).toBeLessThanOrEqual(2250);
  });

  it("never retries 4xx validation errors, even with retries left", async () => {
    const fetchImpl = scriptFetch(
      new Response("bad payload", { status: 400 }),
      new Response(JSON.stringify({ url: "https://shield-agent.com/r/ok" }), { status: 201 }),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await shareReceiptWithRetry(payload, {
      baseUrl: "https://api.example",
      fetchImpl,
      retries: 3,
      sleep,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("HTTP 400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("default (retries 0) is a single attempt on 429", async () => {
    const fetchImpl = scriptFetch(
      new Response("slow down", { status: 429 }),
      new Response(JSON.stringify({ url: "https://shield-agent.com/r/ok" }), { status: 201 }),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await shareReceiptWithRetry(payload, { baseUrl: "https://api.example", fetchImpl, sleep });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("share failed: rate limited — retry later");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("kya receipt --share", () => {
  let cwd: string;
  let config: ResolvedConfig;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kya-share-cli-"));
    config = resolveConfig({
      cwd,
      offline: true,
      allowMissingApiKey: true,
      env: { KYA_OFFLINE: "1" },
      flags: { offline: true },
    });
    appendTrail(cwd, {
      ts: new Date().toISOString(),
      sessionId: "share-session",
      toolId: "org.sample.safe.read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
      summary: "top secret operation",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(cwd, { recursive: true, force: true });
  });

  function captureIo(): { io: CliIo; logs: string[]; errors: string[] } {
    const logs: string[] = [];
    const errors: string[] = [];
    return {
      logs,
      errors,
      io: {
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
        exit: () => {},
      },
    };
  }

  it("receiptInputFromArgs accepts --q and runReceipt stamps it into the HTML", async () => {
    const parsed = parseArgs(["receipt", "--q", "read agents", "--days", "7"]);
    const input = receiptInputFromArgs(parsed);
    expect(input.searchQuery).toBe("read agents");
    expect(input.days).toBe(7);
    const result = await runReceipt(config, { searchQuery: "read agents" });
    const html = readFileSync(result.htmlPath, "utf8");
    expect(html).toContain('value="read agents"');
    expect(html).toContain('<div class="feed-search-meta">');
  });

  it("prints Shared report: <url> on success", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ url: "https://shield-agent.com/r/pub-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { io, logs } = captureIo();
    const code = await runCli(["receipt", "--share"], io, {}, cwd);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Shared report: https://shield-agent.com/r/pub-1");
    // Payload redaction end-to-end: raw summary never leaves the machine.
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as SharePayload;
    expect(JSON.stringify(body)).not.toContain("top secret operation");
    expect(JSON.stringify(body)).not.toContain("share-session");
    expect(body.stats.total).toBe(1);
  });

  it("exits 1 with a one-line error on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    const { io, logs, errors } = captureIo();
    const code = await runCli(["receipt", "--share"], io, {}, cwd);
    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("share failed: HTTP 502");
  });

  it("honors --share-url and KYA_SHARE_URL", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ url: "https://shield-agent.com/r/pub-2" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { io } = captureIo();
    await runCli(["receipt", "--share", "--share-url", "https://flag.example/"], io, {}, cwd);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://flag.example/api/v1/share/reports");

    const fetchMock2 = vi.fn(async () =>
      new Response(JSON.stringify({ url: "https://shield-agent.com/r/pub-3" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock2);
    await runCli(["receipt", "--share"], io, { KYA_SHARE_URL: "https://env.example" }, cwd);
    expect(fetchMock2.mock.calls[0]![0]).toBe("https://env.example/api/v1/share/reports");
  });

  it("receiptInputFromArgs parses --share-retries with clamping", () => {
    expect(receiptInputFromArgs(parseArgs(["receipt", "--share"])).shareRetries).toBe(0);
    expect(receiptInputFromArgs(parseArgs(["receipt", "--share", "--share-retries", "2"])).shareRetries).toBe(2);
    expect(receiptInputFromArgs(parseArgs(["receipt", "--share", "--share-retries", "9"])).shareRetries).toBe(3);
    expect(receiptInputFromArgs(parseArgs(["receipt", "--share", "--share-retries", "abc"])).shareRetries).toBe(0);
  });

  it("429: single attempt by default, 'rate limited — retry later' message", async () => {
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const { io, errors } = captureIo();
    const code = await runCli(["receipt", "--share"], io, {}, cwd);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("share failed: rate limited — retry later");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400: no retry even with --share-retries 3", async () => {
    const fetchMock = vi.fn(async () => new Response("bad payload", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const { io, errors } = captureIo();
    const code = await runCli(["receipt", "--share", "--share-retries", "3"], io, {}, cwd);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("share failed: HTTP 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("runReceiptShare returns an error result instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    const result = await runReceiptShare(config, {}, {});
    expect(result.ok).toBe(false);
  });
});
