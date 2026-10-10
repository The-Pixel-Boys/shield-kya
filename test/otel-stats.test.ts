/**
 * Persistent OTLP export stats (src/otel/stats.ts): accumulation across
 * processes (read-modify-write per flush), endpoint host labeling, tolerant
 * reads, exporter wiring, and the report's OTel panel.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  otelEndpointLabel,
  otelStatsPath,
  readOtelStats,
  recordOtlpExport,
} from "../src/otel/stats.js";
import { exportVerdictSpan, type VerdictEvent } from "../src/otel/exporter.js";
import { buildWindowReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";

const home = () => mkdtempSync(join(tmpdir(), "kya-otelstats-home-"));

const EVENT: VerdictEvent = {
  ts: "2026-10-09T12:00:00.000Z",
  sessionId: "sess-1",
  toolId: "github__get_issue",
  verdict: "ALLOW",
  reasonCode: "ALLOW",
  mode: "observe",
  host: "ide",
};

describe("otelEndpointLabel", () => {
  it("keeps host[:port] only, stripping userinfo and path", () => {
    expect(otelEndpointLabel("http://127.0.0.1:4318")).toBe("127.0.0.1:4318");
    expect(otelEndpointLabel("https://user:secret@collector.example.com:4318/v1")).toBe(
      "collector.example.com:4318",
    );
    expect(otelEndpointLabel("not a url")).toBe("");
  });
});

describe("recordOtlpExport / readOtelStats", () => {
  it("accumulates sent and failed across calls (cross-process style)", () => {
    const env = { KYA_HOME: home() };
    recordOtlpExport(env, "http://127.0.0.1:4318", true, "2026-10-09T12:00:00.000Z");
    recordOtlpExport(env, "http://127.0.0.1:4318", true, "2026-10-09T12:01:00.000Z");
    recordOtlpExport(env, "http://127.0.0.1:4318", false, "2026-10-09T12:02:00.000Z");
    expect(readOtelStats(env)).toEqual({
      endpoint: "127.0.0.1:4318",
      spansSent: 2,
      spansFailed: 1,
      lastExportAt: "2026-10-09T12:02:00.000Z",
    });
  });

  it("never persists credentials embedded in the endpoint URL", () => {
    const env = { KYA_HOME: home() };
    recordOtlpExport(env, "https://user:secret@collector.example.com:4318", true);
    const stats = readOtelStats(env);
    expect(stats?.endpoint).toBe("collector.example.com:4318");
    expect(readFileSync(otelStatsPath(env), "utf8")).not.toContain("secret");
  });

  it("tolerates missing and corrupt stats files", () => {
    const env = { KYA_HOME: home() };
    expect(readOtelStats(env)).toBeUndefined();
    mkdirSync(join(env.KYA_HOME!, ".kya"), { recursive: true });
    writeFileSync(otelStatsPath(env), "not json", "utf8");
    expect(readOtelStats(env)).toBeUndefined();
    writeFileSync(otelStatsPath(env), JSON.stringify({ spansSent: 0, spansFailed: 0 }), "utf8");
    expect(readOtelStats(env)).toBeUndefined();
  });
});

describe("exportVerdictSpan stats wiring", () => {
  const sinks: Server[] = [];

  async function startSink(status = 200): Promise<string> {
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    sinks.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    while (sinks.length) {
      const s = sinks.pop()!;
      await new Promise((resolve) => s.close(() => resolve(undefined)));
    }
  });

  it("records a successful flush", async () => {
    const url = await startSink();
    const env = { KYA_HOME: home() };
    await exportVerdictSpan(EVENT, { endpoint: url }, env);
    const stats = readOtelStats(env);
    expect(stats?.spansSent).toBe(1);
    expect(stats?.spansFailed).toBe(0);
    expect(stats?.endpoint).toBe(new URL(url).host);
    expect(stats?.lastExportAt).toBeTruthy();
  });

  it("records a failed flush (HTTP 500 and dead endpoint)", async () => {
    const url = await startSink(500);
    const env = { KYA_HOME: home() };
    await exportVerdictSpan(EVENT, { endpoint: url }, env);
    await exportVerdictSpan(EVENT, { endpoint: "http://127.0.0.1:1" }, env);
    const stats = readOtelStats(env);
    expect(stats?.spansSent).toBe(0);
    expect(stats?.spansFailed).toBe(2);
  });

  it("writes nothing when the endpoint is refused by the scheme check", async () => {
    const env = { KYA_HOME: home() };
    await exportVerdictSpan(EVENT, { endpoint: "http://example.com:4318" }, env);
    expect(readOtelStats(env)).toBeUndefined();
  });
});

describe("OTel report panel", () => {
  it("renders endpoint, counts and last export time", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, {
        otel: {
          endpoint: "127.0.0.1:4318",
          spansSent: 12,
          spansFailed: 1,
          lastExportAt: new Date().toISOString(),
        },
      }),
    );
    expect(html).toContain('aria-label="OTel export"');
    expect(html).toContain("127.0.0.1:4318");
    expect(html).toContain("Spans sent");
    expect(html).toContain("last export");
  });
});
