/**
 * Notify delivery ledger (src/notify/log.ts): append-only JSONL at
 * .kya/notify-log.jsonl, line-cap rewrite, per-target summary, and the
 * end-to-end wiring from notifyOnTrailEvent through sender.ts. Real local
 * HTTP stub for the wire path, same pattern as notify.test.ts.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendNotifyLog,
  NOTIFY_LOG_MAX_LINES,
  NOTIFY_LOG_KEEP_LINES,
  notifyLogPath,
  notifyTargetLabel,
  readNotifyLog,
  summarizeNotifyLog,
  type NotifyLogEntry,
} from "../src/notify/log.js";
import { notifyOnTrailEvent, resetNotifyState, type NotifyDeps } from "../src/notify/index.js";
import { buildWindowReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

const home = () => mkdtempSync(join(tmpdir(), "kya-notifylog-home-"));

const entry = (over: Partial<NotifyLogEntry> = {}): NotifyLogEntry => ({
  ts: "2026-10-09T12:00:00.000Z",
  target: "hooks.example.com",
  verdict: "DENY",
  ok: true,
  attempt: 1,
  ...over,
});

describe("notifyTargetLabel", () => {
  it("keeps host[:port] only, never the path (which can embed secrets)", () => {
    expect(notifyTargetLabel("https://hooks.slack.com/services/T00/B00/secret")).toBe(
      "hooks.slack.com",
    );
    expect(notifyTargetLabel("http://127.0.0.1:9999/hook?token=abc")).toBe("127.0.0.1:9999");
    expect(notifyTargetLabel("https://user:pass@example.com/x")).toBe("example.com");
    expect(notifyTargetLabel("not a url")).toBe("unknown");
  });
});

describe("appendNotifyLog / readNotifyLog", () => {
  it("appends one JSON line per entry and reads it back", () => {
    const env = { KYA_HOME: home() };
    appendNotifyLog(env, entry());
    appendNotifyLog(env, entry({ ok: false, httpStatus: 500, attempt: 2 }));
    const entries = readNotifyLog(env);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ ok: false, httpStatus: 500, attempt: 2 });
    const raw = readFileSync(notifyLogPath(env), "utf8").trim().split("\n");
    expect(raw).toHaveLength(2);
    expect(() => JSON.parse(raw[0]!)).not.toThrow();
  });

  it("skips malformed lines on read and tolerates a missing file", () => {
    const env = { KYA_HOME: home() };
    expect(readNotifyLog(env)).toEqual([]);
    appendNotifyLog(env, entry());
    const path = notifyLogPath(env);
    writeFileSync(path, `${readFileSync(path, "utf8")}junk line\n{"bad":1}\n`, "utf8");
    expect(readNotifyLog(env)).toHaveLength(1);
  });

  it("rewrites to the last KEEP lines once the file exceeds MAX lines", () => {
    const env = { KYA_HOME: home() };
    // Seed MAX + 1 lines, each long enough that the file clears the size gate.
    const seed = Array.from({ length: NOTIFY_LOG_MAX_LINES + 1 }, (_, i) =>
      JSON.stringify(entry({ ts: `2026-10-09T12:00:${String(i % 60).padStart(2, "0")}.000Z`, target: `t${i}.example.com` })),
    ).join("\n");
    const path = notifyLogPath(env);
    mkdirSync(join(env.KYA_HOME!, ".kya"), { recursive: true });
    writeFileSync(path, `${seed}\n`, "utf8");
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(NOTIFY_LOG_MAX_LINES + 1);
    appendNotifyLog(env, entry({ target: "fresh.example.com" }));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(NOTIFY_LOG_KEEP_LINES);
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ target: "fresh.example.com" });
  });
});

describe("summarizeNotifyLog", () => {
  it("rolls up per-target delivered/failed and the last attempt", () => {
    const summary = summarizeNotifyLog([
      entry({ ts: "2026-10-09T10:00:00.000Z" }),
      entry({ ts: "2026-10-09T11:00:00.000Z" }),
      entry({ ts: "2026-10-09T12:00:00.000Z", ok: false, error: "timeout", attempt: 4 }),
      entry({ ts: "2026-10-09T09:00:00.000Z", target: "other.example.com", ok: false, httpStatus: 500 }),
    ]);
    expect(summary).toBeDefined();
    expect(summary?.delivered).toBe(2);
    expect(summary?.failed).toBe(2);
    expect(summary?.lastTs).toBe("2026-10-09T12:00:00.000Z");
    const main = summary?.targets.find((t) => t.target === "hooks.example.com");
    expect(main).toMatchObject({ delivered: 2, failed: 1, lastOk: false, lastDetail: "timeout" });
    const other = summary?.targets.find((t) => t.target === "other.example.com");
    expect(other).toMatchObject({ delivered: 0, failed: 1, lastDetail: "HTTP 500" });
  });

  it("is undefined for an empty ledger", () => {
    expect(summarizeNotifyLog([])).toBeUndefined();
  });
});

describe("delivery wiring (notifyOnTrailEvent -> ledger)", () => {
  const stubs: { close(): Promise<void> }[] = [];
  let base = "";

  const baseEvent = (): TrailEvent => ({
    ts: "2026-10-09T12:00:00.000Z",
    sessionId: "sess-1",
    host: "claude",
    toolId: "shell.exec",
    verdict: "DENY",
    reasonCode: "NEVER_COMMAND",
    mode: "observe",
  });

  const fastDeps: NotifyDeps = { sleep: async () => {}, random: () => 0 };

  async function startStub(failuresBeforeOk = 0): Promise<void> {
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.statusCode = failuresBeforeOk > 0 ? 500 : 200;
        failuresBeforeOk = Math.max(0, failuresBeforeOk - 1);
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    stubs.push({
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    });
  }

  beforeEach(() => resetNotifyState());
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("records a delivered attempt with target host, verdict and HTTP status", async () => {
    await startStub();
    const env = { KYA_HOME: home() };
    await notifyOnTrailEvent(baseEvent(), { notify: { webhooks: [{ url: base }] } }, env, fastDeps);
    const entries = readNotifyLog(env);
    expect(entries).toHaveLength(1);
    const host = new URL(base).host;
    expect(entries[0]).toMatchObject({
      target: host,
      verdict: "DENY",
      ok: true,
      httpStatus: 200,
      attempt: 1,
    });
    // The ledger must never carry the URL path.
    expect(readFileSync(notifyLogPath(env), "utf8")).not.toContain("/hook");
  });

  it("records every failed attempt with the error detail", async () => {
    await startStub(99);
    const env = { KYA_HOME: home() };
    await notifyOnTrailEvent(baseEvent(), { notify: { webhooks: [{ url: base }] } }, env, fastDeps);
    const entries = readNotifyLog(env);
    expect(entries).toHaveLength(4); // initial + 3 retries
    expect(entries.every((e) => !e.ok && e.httpStatus === 500)).toBe(true);
    expect(entries.map((e) => e.attempt)).toEqual([1, 2, 3, 4]);
    const summary = summarizeNotifyLog(entries);
    expect(summary?.failed).toBe(4);
    expect(summary?.targets[0]).toMatchObject({ failed: 4, lastOk: false });
  });

  it("renders the Alerts panel per target", async () => {
    await startStub();
    const env = { KYA_HOME: home() };
    await notifyOnTrailEvent(baseEvent(), { notify: { webhooks: [{ url: base }] } }, env, fastDeps);
    const summary = summarizeNotifyLog(readNotifyLog(env));
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { alerts: summary }));
    expect(html).toContain('aria-label="Alerts"');
    expect(html).toContain(new URL(base).host);
    expect(html).toContain("delivered");
  });
});
