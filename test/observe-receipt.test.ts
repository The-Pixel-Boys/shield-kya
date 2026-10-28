import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { runWrap } from "../src/commands/wrap.js";
import { runReceipt } from "../src/commands/receipt.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import {
  appendTrail,
  detectProduct,
  readTrail,
  readTrailSince,
  type TrailEvent,
} from "../src/trail.js";

describe("observe-default wrap", () => {
  let cwd: string;
  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("records REQUIRE_APPROVE without opening a Hold ticket", async () => {
    cwd = mkdtempSync(join(tmpdir(), "kya-obs-"));
    const config = resolveConfig({
      cwd,
      offline: true,
      allowMissingApiKey: true,
      env: { KYA_OFFLINE: "1" },
      flags: { offline: true },
    });
    expect(config.holdEnabled).toBe(false);
    const result = await runWrap(config, {
      toolId: "org.sample.data.write",
      irreversible: true,
      offline: true,
    });
    expect(result.observed).toBe(true);
    expect(result.approval).toBeUndefined();
    expect(result.eval.response.verdict).toBe("REQUIRE_APPROVE");
    const trail = readTrail(cwd);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.verdict).toBe("REQUIRE_APPROVE");
  });

  it("still DENYs never-events without a prompt", async () => {
    cwd = mkdtempSync(join(tmpdir(), "kya-nev-"));
    const config = resolveConfig({
      cwd,
      offline: true,
      allowMissingApiKey: true,
      flags: { offline: true },
    });
    const result = await runWrap(config, {
      toolId: "org.sample.never.event",
      irreversible: true,
      offline: true,
    });
    expect(result.eval.response.verdict).toBe("DENY");
    expect(result.eval.response.reasonCode).toBe("NEVER_EVENT");
    expect(readTrail(cwd)[0]?.neverEvent).toBe(true);
  });
});

describe("receipt 3-day window", () => {
  it("excludes events older than window and renders activity feed", () => {
    const now = Date.now();
    const events: TrailEvent[] = [
      {
        ts: new Date(now - 1 * 86400000).toISOString(),
        sessionId: "a",
        product: "cursor",
        toolId: "org.sample.safe.read",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      },
      {
        ts: new Date(now - 2 * 86400000).toISOString(),
        sessionId: "b",
        product: "claude",
        toolId: "org.sample.never.event",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        mode: "observe",
        neverEvent: true,
      },
      {
        ts: new Date(now - 10 * 86400000).toISOString(),
        sessionId: "old",
        product: "codex",
        toolId: "org.sample.safe.read",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      },
    ];
    const since = new Date(now - 3 * 86400000);
    const filtered = events.filter((e) => Date.parse(e.ts) >= since.getTime());
    expect(filtered).toHaveLength(2);
    const model = buildWindowReceiptModel(filtered, 3);
    const html = renderReceiptHtml(model);
    expect(html).toContain("Agent activity");
    expect(html).toContain("last 3 days");
    expect(html).toContain('aria-label="Activity feed"');
    expect(html).toContain("class=\"ev");
    // The always-on Capabilities index is the only table on a data-free model.
    expect(html).toContain('aria-label="Capabilities"');
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).toContain("Cursor");
    expect(html).toContain("Claude Code");
    expect(html).toContain("blocked");
    expect(html).not.toContain("observe path");
    expect(html).not.toContain("second approve");
    expect(html).not.toContain("Codex"); // old event excluded
  });

  it("live flag injects the live-update EventSource", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, { live: true, liveToken: "tok-abc123" }),
    );
    expect(html).toContain("EventSource('/events?t=' + encodeURIComponent(readToken()))");
    expect(html).toContain("Live");
    expect(html).toContain("this page will refresh");
  });

  it("static empty state does not claim live refresh", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(html).toContain("regenerate this receipt");
    expect(html).not.toContain("this page will refresh");
  });

  // The day labels follow the LOCAL calendar. The clock and the time zone are fixed, so the result does not depend on
  // when or where the test runs (it failed in CI just after local midnight next to a 25-hour clock-change day).
  describe("day buckets use Today and Yesterday labels", () => {
    const savedTz = process.env.TZ;
    afterEach(() => {
      vi.useRealTimers();
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    });

    const at = (ts: string, sessionId: string) => ({
      ts,
      sessionId,
      product: "cursor",
      toolId: "t1",
      verdict: "ALLOW" as const,
      reasonCode: "ALLOW",
      mode: "observe" as const,
    });

    /** Local noon of the day {@code back} days before the local day of {@code now}. */
    const localNoon = (now: Date, back: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12).toISOString();

    const labels = (html: string) => [...html.matchAll(/class="day"[^>]*>([^<]*)</g)].map((m) => m[1]);

    // [time zone, local wall time of "now"]: 23:59 and 00:01 boundaries, and both clock-change weeks of 2026.
    const cases: Array<[string, string]> = [
      ["UTC", "2026-10-27T00:01:00Z"],
      ["UTC", "2026-10-26T23:59:00Z"],
      ["Europe/Bucharest", "2026-10-26T21:55:00Z"], // 23:55 local, the day after the 25-hour day (CI failure)
      ["Europe/Bucharest", "2026-10-26T22:01:00Z"], // 00:01 local on 2026-10-27
      ["Europe/Bucharest", "2026-03-29T21:30:00Z"], // 00:30 local, the day after the 23-hour day
      ["America/New_York", "2026-11-02T04:59:00Z"], // 23:59 local on the 25-hour day (2026-11-01)
      ["America/New_York", "2026-11-02T05:01:00Z"], // 00:01 local
      ["Pacific/Auckland", "2026-09-27T11:01:00Z"], // 00:01 local on 2026-09-28, after spring-forward
    ];

    it.each(cases)("in %s at %s", (tz, instant) => {
      process.env.TZ = tz;
      vi.useFakeTimers();
      vi.setSystemTime(new Date(instant));
      const now = new Date();
      const html = renderReceiptHtml(
        buildWindowReceiptModel(
          [at(now.toISOString(), "a"), at(localNoon(now, 1), "b"), at(localNoon(now, 2), "c")],
          3,
        ),
      );
      const twoDaysBack = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 12);
      const key = `${twoDaysBack.getFullYear()}-${String(twoDaysBack.getMonth() + 1).padStart(2, "0")}-${String(twoDaysBack.getDate()).padStart(2, "0")}`;
      expect(labels(html)).toEqual(["Today", "Yesterday", key]);
    });
  });

  it("detectProduct maps common env", () => {
    expect(detectProduct({ CURSOR_SESSION_ID: "x" })).toBe("cursor");
    expect(detectProduct({ CLAUDECODE: "1" })).toBe("claude");
    expect(detectProduct({ CODEX_HOME: "/tmp" })).toBe("codex");
    expect(detectProduct({ GROK_BUILD: "1" })).toBe("grok");
  });

  it("receipt command defaults to multi-day file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-rec-"));
    try {
      const now = Date.now();
      appendTrail(cwd, {
        ts: new Date(now).toISOString(),
        sessionId: "demo",
        product: "cursor",
        toolId: "org.sample.safe.read",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      });
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      const out = await runReceipt(config, { open: false });
      expect(out.days).toBe(3);
      expect(out.rangeLabel).toContain("last 3 days");
      const html = readFileSync(out.htmlPath, "utf8");
      expect(html).toContain("Agent activity");
      expect(html).toContain('aria-label="Activity feed"');
      expect(html).not.toContain("observe path");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("readTrailSince filters", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-since-"));
    try {
      const now = Date.now();
      appendTrail(cwd, {
        ts: new Date(now - 10 * 86400000).toISOString(),
        sessionId: "old",
        toolId: "t",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      });
      appendTrail(cwd, {
        ts: new Date(now).toISOString(),
        sessionId: "new",
        toolId: "t2",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        mode: "observe",
        neverEvent: true,
      });
      const recent = readTrailSince(cwd, new Date(now - 3 * 86400000));
      expect(recent).toHaveLength(1);
      expect(recent[0]?.sessionId).toBe("new");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("live server serves feed and broadcasts SSE on trail write", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-live-"));
    try {
      appendTrail(cwd, {
        ts: new Date().toISOString(),
        sessionId: "live",
        product: "grok",
        toolId: "org.sample.safe.read",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      });
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      const beforeSig = process.listenerCount("SIGINT");
      const live = await startLiveReceiptServer({ config, days: 3 });
      try {
        expect(live.url).toContain("?t=");
        const denied = await fetch(`http://127.0.0.1:${live.port}/`);
        expect(denied.status).toBe(401);

        const page = await fetch(live.url);
        const html = await page.text();
        expect(page.status).toBe(200);
        expect(html).toContain("Live");
        expect(html).toContain("EventSource('/events?t=' + encodeURIComponent(readToken()))");
        expect(html).toContain("Grok");
        expect(html).toContain("org.sample.safe.read");

        const ac = new AbortController();
        const sseUrl = new URL("/events", live.url);
        sseUrl.searchParams.set("t", live.token);
        const sseRes = await fetch(sseUrl, { signal: ac.signal });
        expect(sseRes.headers.get("content-type") ?? "").toContain("text/event-stream");
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const readUntil = async (needle: string, ms: number) => {
          const deadline = Date.now() + ms;
          while (!buf.includes(needle) && Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
          }
          return buf.includes(needle);
        };
        expect(await readUntil(": connected", 2000)).toBe(true);

        appendTrail(cwd, {
          ts: new Date().toISOString(),
          sessionId: "live",
          product: "cursor",
          toolId: "org.sample.data.write",
          verdict: "REQUIRE_APPROVE",
          reasonCode: "HIGH_STAKES_WRITE",
          mode: "observe",
          summary: "write x.ts (1 chars)",
        });
        expect(await readUntil('"source":"trail"', 3000)).toBe(true);
        ac.abort();
        await reader.cancel().catch(() => undefined);
      } finally {
        await live.close();
        expect(process.listenerCount("SIGINT")).toBe(beforeSig);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
