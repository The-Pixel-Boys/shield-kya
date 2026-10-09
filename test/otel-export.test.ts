import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildVerdictTracePayload,
  exportVerdictSpan,
  otlpExportSelfTest,
  otlpExportStats,
  resolveOtlpExportConfig,
  type OtlpExportConfig,
  type VerdictEvent,
} from "../src/otel/exporter.js";

const EVENT: VerdictEvent = {
  ts: "2026-10-09T12:00:00.000Z",
  sessionId: "sess-1",
  toolId: "github__get_issue",
  verdict: "ALLOW",
  reasonCode: "ALLOW",
  mode: "observe",
  host: "ide",
  tokensIn: 120,
  tokensOut: 45,
};

interface Capture {
  url: string;
  close: () => Promise<void>;
  requests: () => { body: string; headers: Record<string, string | string[] | undefined> }[];
}

/** Local OTLP sink: records every POST body, optionally stalls to force timeouts. */
async function startSink(opts: { stallMs?: number; status?: number } = {}): Promise<Capture> {
  const seen: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
      const respond = () => {
        res.writeHead(opts.status ?? 200, { "content-type": "application/json" }).end("{}");
      };
      if (opts.stallMs) setTimeout(respond, opts.stallMs);
      else respond();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    requests: () => seen,
  };
}

const sinks: Capture[] = [];
async function sink(opts?: { stallMs?: number; status?: number }): Promise<Capture> {
  const s = await startSink(opts);
  sinks.push(s);
  return s;
}

afterEach(async () => {
  while (sinks.length) await sinks.pop()?.close();
});

function spanAttrs(payload: unknown): Record<string, unknown> {
  const p = payload as {
    resourceSpans: {
      scopeSpans: { spans: { attributes: { key: string; value: Record<string, unknown> }[] }[] }[];
    }[];
  };
  const attrs = p.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  const out: Record<string, unknown> = {};
  for (const a of attrs) {
    out[a.key] = a.value.stringValue ?? a.value.intValue;
  }
  return out;
}

describe("resolveOtlpExportConfig", () => {
  it("is disabled by default (no endpoint anywhere)", () => {
    expect(resolveOtlpExportConfig({}, {})).toBeUndefined();
    expect(resolveOtlpExportConfig({}, undefined)).toBeUndefined();
    expect(resolveOtlpExportConfig({}, { otlpExport: {} })).toBeUndefined();
  });

  it("reads endpoint, headers, insecure from the otlpExport key", () => {
    const cfg = resolveOtlpExportConfig(
      {},
      {
        otlpExport: {
          endpoint: "http://127.0.0.1:4318",
          headers: { Authorization: "Bearer t" },
          insecure: true,
        },
      },
    );
    expect(cfg).toEqual({
      endpoint: "http://127.0.0.1:4318",
      headers: { Authorization: "Bearer t" },
      insecure: true,
    });
  });

  it("KYA_OTLP_EXPORT_ENDPOINT overrides the config file endpoint", () => {
    const cfg = resolveOtlpExportConfig(
      { KYA_OTLP_EXPORT_ENDPOINT: "http://127.0.0.1:9999" },
      { otlpExport: { endpoint: "http://127.0.0.1:4318" } },
    );
    expect(cfg?.endpoint).toBe("http://127.0.0.1:9999");
  });
});

describe("buildVerdictTracePayload", () => {
  it("produces resourceSpans/scopeSpans/spans with traceparent-style ids", () => {
    const p = buildVerdictTracePayload(EVENT) as {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue: string } }[] };
        scopeSpans: {
          scope: { name: string };
          spans: {
            traceId: string;
            spanId: string;
            name: string;
            kind: number;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            status: { code: number; message?: string };
          }[];
        }[];
      }[];
    };
    expect(p.resourceSpans).toHaveLength(1);
    const svc = p.resourceSpans[0].resource.attributes;
    expect(svc).toContainEqual({ key: "service.name", value: { stringValue: "shield-kya-cli" } });
    const span = p.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.name).toBe("kya.verdict github__get_issue");
    expect(span.startTimeUnixNano).toBe(span.endTimeUnixNano);
    expect(span.status.code).toBe(1);
  });

  it("maps verdict metadata to GenAI + kya.* attributes, tokens included when known", () => {
    const attrs = spanAttrs(buildVerdictTracePayload(EVENT));
    expect(attrs).toMatchObject({
      "gen_ai.tool.name": "github__get_issue",
      "kya.verdict": "ALLOW",
      "kya.reason_code": "ALLOW",
      "kya.mode": "observe",
      "kya.host": "ide",
      "kya.session_id": "sess-1",
      "gen_ai.usage.input_tokens": "120",
      "gen_ai.usage.output_tokens": "45",
    });
  });

  it("omits token attributes when unknown and marks DENY as span error", () => {
    const denied = buildVerdictTracePayload({
      sessionId: "s",
      toolId: "t",
      verdict: "DENY",
      reasonCode: "POLICY_DENY",
      mode: "hold",
    }) as { resourceSpans: { scopeSpans: { spans: { status: { code: number; message?: string } }[] }[] }[] };
    const attrs = spanAttrs(denied);
    expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attrs["kya.host"]).toBeUndefined();
    expect(denied.resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({
      code: 2,
      message: "POLICY_DENY",
    });
  });
});

describe("exportVerdictSpan", () => {
  it("no-ops when unconfigured (no fetch, no stats)", async () => {
    const before = otlpExportStats();
    await exportVerdictSpan(EVENT, undefined);
    expect(otlpExportStats()).toEqual(before);
  });

  it("POSTs the OTLP/JSON payload to {endpoint}/v1/traces with headers", async () => {
    const s = await sink();
    const cfg: OtlpExportConfig = {
      endpoint: s.url,
      headers: { "x-test-token": "abc" },
    };
    await exportVerdictSpan(EVENT, cfg);
    const reqs = s.requests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].headers["content-type"]).toBe("application/json");
    expect(reqs[0].headers["x-test-token"]).toBe("abc");
    const payload = JSON.parse(reqs[0].body);
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    expect(spanAttrs(payload)["kya.verdict"]).toBe("ALLOW");
    const stats = otlpExportStats();
    expect(stats.exported).toBeGreaterThan(0);
  });

  it("never throws against a dead endpoint and counts the failure", async () => {
    const before = otlpExportStats();
    const dead: OtlpExportConfig = { endpoint: "http://127.0.0.1:1" };
    await expect(exportVerdictSpan(EVENT, dead)).resolves.toBeUndefined();
    const after = otlpExportStats();
    expect(after.failed).toBe(before.failed + 1);
    expect(after.exported).toBe(before.exported);
  });

  it("aborts after the 2s timeout and still resolves cleanly", async () => {
    const s = await sink({ stallMs: 5_000 });
    const before = otlpExportStats();
    const t0 = Date.now();
    await expect(
      exportVerdictSpan(EVENT, { endpoint: s.url }),
    ).resolves.toBeUndefined();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(4_000);
    expect(otlpExportStats().failed).toBe(before.failed + 1);
  }, 15_000);

  it("refuses plaintext http to non-loopback hosts unless insecure", async () => {
    const before = otlpExportStats();
    await exportVerdictSpan(EVENT, { endpoint: "http://example.com:4318" });
    expect(otlpExportStats()).toEqual(before);
  });
});

describe("otlpExportSelfTest", () => {
  it("reports success with the span visible at the sink", async () => {
    const s = await sink();
    const res = await otlpExportSelfTest({ endpoint: s.url });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("/v1/traces");
    expect(s.requests()).toHaveLength(1);
    expect(spanAttrs(JSON.parse(s.requests()[0].body))["kya.reason_code"]).toBe("SELFTEST");
  });

  it("reports failure without throwing when the endpoint is dead", async () => {
    const res = await otlpExportSelfTest({ endpoint: "http://127.0.0.1:1" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("export failed");
  });

  it("reports unconfigured as a failure detail", async () => {
    const res = await otlpExportSelfTest(undefined);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("not configured");
  });
});
