import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { runGateDoctor, runGateRun, runGateStop } from "../src/commands/gate.js";
import { evaluateGatewayTool } from "../src/receipt/gate-page.js";
import { isLoopbackClient, startLiveReceiptServer } from "../src/receipt/live-server.js";
import { appendTrail } from "../src/trail.js";

vi.mock("../src/commands/gate.js", () => ({
  runGateRun: vi.fn(),
  runGateStop: vi.fn(),
  runGateDoctor: vi.fn(),
}));

describe("live receipt server POST endpoints", () => {
  let dir: string;
  let config: ResolvedConfig;
  const servers: Awaited<ReturnType<typeof startLiveReceiptServer>>[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kya-live-post-"));
    config = resolveConfig({
      cwd: dir,
      offline: true,
      allowMissingApiKey: true,
      env: { KYA_OFFLINE: "1" },
      flags: { offline: true },
    });
    vi.clearAllMocks();
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

  async function start(): Promise<Awaited<ReturnType<typeof startLiveReceiptServer>>> {
    const s = await startLiveReceiptServer({ config, days: 3 });
    servers.push(s);
    return s;
  }

  describe("POST /gate/playground", () => {
    it("requires token", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/playground`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: "server1", tool: "read" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects wrong token with 401", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/playground?t=wrong`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: "server1", tool: "read" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects non-loopback origin via x-forwarded-for with 403", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/playground?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4" },
        body: JSON.stringify({ server: "server1", tool: "read" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok?: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("loopback");
    });

    it("returns 400 on invalid server id", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/playground?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: "bad server", tool: "read" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok?: boolean; error?: string };
      expect(body.ok).toBe(false);
    });

    it("returns 400 when tool is missing", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/playground?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: "server1" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns verdict matching evaluateGatewayTool", async () => {
      const s = await start();
      const allowed = await fetch(`http://127.0.0.1:${s.port}/gate/playground?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: "server1", tool: "safe_read" }),
      });
      expect(allowed.status).toBe(200);
      const allowedBody = (await allowed.json()) as { ok?: boolean; verdict?: string; reason?: string };
      expect(allowedBody.ok).toBe(true);
      expect(allowedBody.verdict).toBe("allow");
      expect(allowedBody.reason).toBe(evaluateGatewayTool("server1", "safe_read").reason);

      const denied = await fetch(`http://127.0.0.1:${s.port}/gate/playground?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: "server1", tool: "drop_table" }),
      });
      expect(denied.status).toBe(200);
      const deniedBody = (await denied.json()) as { ok?: boolean; verdict?: string; reason?: string };
      expect(deniedBody.ok).toBe(true);
      expect(deniedBody.verdict).toBe("deny");
      expect(deniedBody.reason).toBe(evaluateGatewayTool("server1", "drop_table").reason);
    });
  });

  describe("POST /gate/action", () => {
    it("requires token", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "doctor" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects wrong token with 401", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action?t=wrong`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "doctor" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects non-loopback origin via x-forwarded-for with 403", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4" },
        body: JSON.stringify({ action: "doctor" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 on invalid action", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dance" }),
      });
      expect(res.status).toBe(400);
    });

    it("start returns running state and server count", async () => {
      const s = await start();
      vi.mocked(runGateRun).mockResolvedValueOnce({
        pid: 123,
        url: "http://127.0.0.1:3930/mcp",
        port: 3930,
        otlpPort: 3931,
        servers: ["server1", "server2"],
        configPath: "/tmp/gate.yaml",
        logPath: "/tmp/gate.log",
        reused: false,
        next: "ready",
      });
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; state?: string; url?: string; servers?: number };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("running");
      expect(body.url).toBe("http://127.0.0.1:3930/mcp");
      expect(body.servers).toBe(2);
      expect(runGateRun).toHaveBeenCalledWith(config);
    });

    it("restart returns running state", async () => {
      const s = await start();
      vi.mocked(runGateRun).mockResolvedValueOnce({
        pid: 124,
        url: "http://127.0.0.1:3930/mcp",
        port: 3930,
        otlpPort: 3931,
        servers: ["server1"],
        configPath: "/tmp/gate.yaml",
        logPath: "/tmp/gate.log",
        reused: false,
        next: "ready",
      });
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; state?: string };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("running");
    });

    it("returns 500 when runGateRun throws", async () => {
      const s = await start();
      vi.mocked(runGateRun).mockRejectedValueOnce(new Error("binary missing"));
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { ok?: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("binary missing");
    });

    it("stop returns stopped state", async () => {
      const s = await start();
      vi.mocked(runGateStop).mockResolvedValueOnce({ stopped: true, pid: 123 });
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; state?: string; stopped?: boolean };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("stopped");
      expect(body.stopped).toBe(true);
    });

    it("doctor returns report", async () => {
      const s = await start();
      const report = {
        binary: { present: true, path: "/tmp/bin" },
        config: { path: "/tmp/cfg", servers: 1 },
        listener: { running: true, url: "http://127.0.0.1:3930/mcp", healthy: true },
        bindScope: { loopbackOnly: true, detail: "loopback-only" },
      };
      vi.mocked(runGateDoctor).mockResolvedValueOnce(report as Awaited<ReturnType<typeof runGateDoctor>>);
      const res = await fetch(`http://127.0.0.1:${s.port}/gate/action?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "doctor" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; state?: string; report?: unknown };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("doctor");
      expect(body.report).toEqual(report);
    });
  });

  describe("POST /stop", () => {
    it("requires token", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/stop`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("rejects wrong token with 401", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/stop?t=wrong`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("rejects non-loopback origin via x-forwarded-for with 403", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/stop?t=${s.token}`, {
        method: "POST",
        headers: { "X-Forwarded-For": "1.2.3.4" },
      });
      expect(res.status).toBe(403);
    });

    it("returns stopped and closes the server", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/stop?t=${s.token}`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; stopped?: boolean };
      expect(body.ok).toBe(true);
      expect(body.stopped).toBe(true);
      await s.waitUntilClosed;
      // After close, a new request should fail to connect.
      await expect(
        fetch(`http://127.0.0.1:${s.port}/healthz?t=${s.token}`),
      ).rejects.toThrow();
    });
  });

  describe("POST /feed", () => {
    it("requires token", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: {}, page: 1 }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects wrong token with 401", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/feed?t=wrong`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: {}, page: 1 }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects non-loopback origin via x-forwarded-for with 403", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/feed?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4" },
        body: JSON.stringify({ filters: {}, page: 1 }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok?: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("loopback");
    });

    it("returns 400 on invalid JSON body", async () => {
      const s = await start();
      const res = await fetch(`http://127.0.0.1:${s.port}/feed?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok?: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("invalid JSON");
    });

    it("paginates and filters events from the local trail", async () => {
      const s = await start();
      for (let i = 0; i < 5; i++) {
        appendTrail(dir, {
          ts: new Date(Date.now() - i * 1000).toISOString(),
          sessionId: "live",
          product: "cursor",
          toolId: "org.sample.safe.read",
          verdict: i % 2 === 0 ? "ALLOW" : "DENY",
          reasonCode: i % 2 === 0 ? "ALLOW" : "NEVER_EVENT",
          mode: "observe",
          neverEvent: i % 2 !== 0,
        });
      }

      const page1 = await fetch(`http://127.0.0.1:${s.port}/feed?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: {}, page: 1 }),
      });
      expect(page1.status).toBe(200);
      const body1 = (await page1.json()) as {
        ok?: boolean;
        feedHtml?: string;
        paginationHtml?: string;
        total?: number;
        page?: number;
        pages?: number;
      };
      expect(body1.ok).toBe(true);
      expect(body1.total).toBe(5);
      expect(body1.page).toBe(1);
      expect(body1.pages).toBe(1);
      expect(body1.feedHtml).toContain('<article class="ev ');
      expect(body1.paginationHtml).toContain("5 events");

      const filtered = await fetch(`http://127.0.0.1:${s.port}/feed?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: { verdict: ["DENY"] }, page: 1 }),
      });
      expect(filtered.status).toBe(200);
      const body2 = (await filtered.json()) as {
        ok?: boolean;
        feedHtml?: string;
        total?: number;
        page?: number;
        pages?: number;
      };
      expect(body2.ok).toBe(true);
      expect(body2.total).toBe(2);
      expect(body2.page).toBe(1);
      expect(body2.feedHtml).toContain("DENY");
      expect(body2.feedHtml).not.toContain("ALLOW");
    });

    it("ignores malformed filters and falls back to empty filters", async () => {
      const s = await start();
      appendTrail(dir, {
        ts: new Date().toISOString(),
        sessionId: "live",
        product: "cursor",
        toolId: "org.sample.safe.read",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      });
      const res = await fetch(`http://127.0.0.1:${s.port}/feed?t=${s.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: { verdict: "DENY" }, page: 1 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; total?: number };
      expect(body.ok).toBe(true);
      expect(body.total).toBe(1);
    });
  });

  describe("isLoopbackClient", () => {
    it("accepts loopback addresses", () => {
      expect(isLoopbackClient({ socket: { remoteAddress: "127.0.0.1" }, headers: {} })).toBe(true);
      expect(isLoopbackClient({ socket: { remoteAddress: "::1" }, headers: {} })).toBe(true);
      expect(isLoopbackClient({ socket: { remoteAddress: "::ffff:127.0.0.1" }, headers: {} })).toBe(true);
    });

    it("rejects non-loopback addresses", () => {
      expect(isLoopbackClient({ socket: { remoteAddress: "10.0.0.1" }, headers: {} })).toBe(false);
      expect(isLoopbackClient({ socket: { remoteAddress: "192.168.1.1" }, headers: {} })).toBe(false);
      expect(isLoopbackClient({ socket: { remoteAddress: undefined }, headers: {} })).toBe(false);
    });

    it("rejects any x-forwarded-for header", () => {
      expect(
        isLoopbackClient({
          socket: { remoteAddress: "127.0.0.1" },
          headers: { "x-forwarded-for": "127.0.0.1" },
        }),
      ).toBe(false);
      expect(
        isLoopbackClient({
          socket: { remoteAddress: "127.0.0.1" },
          headers: { "x-forwarded-for": "1.2.3.4" },
        }),
      ).toBe(false);
    });
  });
});
