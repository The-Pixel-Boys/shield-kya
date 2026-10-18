// test/report-fragments-e2e.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import { appendTrail } from "../src/trail.js";

/**
 * Live-refresh fragment contract over real HTTP: POST /fragments returns the
 * rendered containers the client swaps in place instead of reloading the
 * page, and the SSE channel announces changes with a typed source payload.
 */

const FRAGMENT_KEYS = [
  "statCounts",
  "chipProducts",
  "chipProjects",
  "chipServers",
  "heroCertify",
  "heroTiles",
  "overviewPanels",
  "certifyBody",
  "orrPanel",
  "changesList",
] as const;

describe("live fragments e2e (real server)", () => {
  let dir: string;
  let config: ResolvedConfig;
  const servers: Awaited<ReturnType<typeof startLiveReceiptServer>>[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kya-frag-e2e-"));
    config = resolveConfig({
      cwd: dir,
      offline: true,
      allowMissingApiKey: true,
      env: { KYA_OFFLINE: "1" },
      flags: { offline: true },
    });
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      try {
        await s.close();
      } catch {
        /* ignore */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    const s = await startLiveReceiptServer({ config, days: 3 });
    servers.push(s);
    return s;
  }

  it("POST /fragments returns every fragment the client targets", async () => {
    const s = await start();
    appendTrail(dir, {
      ts: new Date().toISOString(),
      sessionId: "frag",
      product: "kimi",
      toolId: "org.sample.safe.read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
    });
    const res = await fetch(`http://127.0.0.1:${s.port}/fragments?t=${s.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      fragments: Record<string, string>;
      nav: Record<string, number | null>;
    };
    expect(body.ok).toBe(true);
    for (const key of FRAGMENT_KEYS) {
      expect(typeof body.fragments[key], `fragment ${key}`).toBe("string");
    }
    expect(body.nav.overview).toBe(1);
    expect(body.nav.activity).toBe(1);
    // The initial page renders the same containers the refresh swaps.
    const page = await (await fetch(`http://127.0.0.1:${s.port}/?t=${s.token}`)).text();
    for (const id of [
      "stat-counts",
      "chip-products",
      "frag-hero-tiles",
      "frag-overview-panels",
      "frag-certify",
      "frag-orr",
      "changes-list",
    ]) {
      expect(page, `page missing #${id}`).toContain(`id="${id}"`);
    }
    expect(page).toContain(body.fragments.statCounts.trim().slice(0, 80));
  });

  it("enforces the token contract on /fragments", async () => {
    const s = await start();
    for (const qs of ["", "?t=wrong"]) {
      const res = await fetch(`http://127.0.0.1:${s.port}/fragments${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status, `POST /fragments${qs}`).toBe(401);
    }
  });

  it("fragments reflect new trail events without a page reload", async () => {
    const s = await start();
    const before = (await (
      await fetch(`http://127.0.0.1:${s.port}/fragments?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json()) as { fragments: Record<string, string>; nav: Record<string, number | null> };
    appendTrail(dir, {
      ts: new Date().toISOString(),
      sessionId: "frag2",
      product: "claude",
      toolId: "org.sample.data.write",
      verdict: "DENY",
      reasonCode: "NEVER_EVENT",
      neverEvent: true,
      mode: "hold",
    });
    const after = (await (
      await fetch(`http://127.0.0.1:${s.port}/fragments?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json()) as { fragments: Record<string, string>; nav: Record<string, number | null> };
    expect(after.nav.overview).toBe(1);
    expect(after.fragments.statCounts).not.toBe(before.fragments.statCounts);
    expect(after.fragments.statCounts).toContain("Never<b>1</b>");
  });

  it("SSE announces changes with a typed source payload", async () => {
    const s = await start();
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${s.port}/events?t=${s.token}`, {
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const readUntil = async (needle: string, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value?: undefined }>((r) =>
            setTimeout(() => r({ done: false }), 250),
          ),
        ]);
        if (value) buf += decoder.decode(value, { stream: true });
        if (buf.includes(needle)) return true;
        if (done) break;
      }
      return buf.includes(needle);
    };
    try {
      expect(await readUntil(": connected", 2000)).toBe(true);
      appendTrail(dir, {
        ts: new Date().toISOString(),
        sessionId: "sse",
        product: "kimi",
        toolId: "org.sample.safe.read",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      });
      expect(await readUntil('"source":"trail"', 3000)).toBe(true);
    } finally {
      ac.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});
