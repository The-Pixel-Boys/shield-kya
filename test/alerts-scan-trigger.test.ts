/**
 * kya-alerts: the report daemon must not lose an alert scan trigger (issue #697). Real live server,
 * real trail and state files, a local HTTP receiver. Each case is a way the fs.watch trigger alone loses
 * an alert: events written before the watcher is live, a scan that ends with nothing done (state lock
 * held by another process), and a burst of writes while a scan is in progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import { alertsStatePath } from "../src/alerts/state.js";
import { appendTrail, type TrailEvent } from "../src/trail.js";
import { resetNotifyState } from "../src/notify/index.js";

vi.mock("../src/commands/gate.js", () => ({ runGateRun: vi.fn(), runGateStop: vi.fn(), runGateDoctor: vi.fn() }));

const ev = (tool: string, minAgo: number): TrailEvent => ({
  ts: new Date(Date.now() - minAgo * 60_000).toISOString(),
  sessionId: "trigger-session",
  toolId: tool,
  verdict: "DENY",
  reasonCode: "NEVER_EVENT",
  mode: "offline",
  neverEvent: true,
});

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return pred();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("kya-alerts scan trigger is not lost", () => {
  let home: string;
  let project: string;
  let sink: Server;
  const posts: Array<Record<string, any>> = [];
  /** While set, the receiver holds each response until it is called: the scan stays in progress. */
  let hold: Promise<void> | undefined;
  let server: Awaited<ReturnType<typeof startLiveReceiptServer>> | undefined;

  const start = (): ReturnType<typeof startLiveReceiptServer> =>
    startLiveReceiptServer({
      config: resolveConfig({ cwd: project, offline: true, allowMissingApiKey: true, env: { KYA_OFFLINE: "1" }, flags: { offline: true } }),
      days: 3,
      alertScanMinMs: 200,
    });

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kya-alerts-trigger-home-"));
    project = mkdtempSync(join(tmpdir(), "kya-alerts-trigger-proj-"));
    posts.length = 0;
    hold = undefined;
    resetNotifyState();
    sink = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += String(d)));
      req.on("end", () => {
        posts.push(JSON.parse(raw) as Record<string, any>);
        void (hold ?? Promise.resolve()).then(() => res.writeHead(200).end("{}"));
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/h`;
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(
      join(home, ".kya", "config.json"),
      JSON.stringify({ alerts: { enabled: true }, notify: { webhooks: [{ url, events: ["incident.opened"] }] } }),
    );
    vi.stubEnv("KYA_HOME", home);
    vi.stubEnv("KYA_ALERTS", "");
  });

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    server = undefined;
    await new Promise<void>((r) => sink.close(() => r()));
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("scans events that were written before the server (no watch event ever comes)", async () => {
    appendTrail(project, ev("tool.alpha", 3), process.env);
    appendTrail(project, ev("tool.alpha", 2), process.env);
    server = await start();
    expect(await waitFor(() => posts.length >= 1, 20_000)).toBe(true);
  }, 40_000);

  it("rescans after a scan that ended with nothing done because another process held the state lock", async () => {
    const lock = `${alertsStatePath(process.env)}.lock`;
    mkdirSync(lock, { recursive: true });
    server = await start();
    appendTrail(project, ev("tool.alpha", 3), process.env);
    appendTrail(project, ev("tool.alpha", 2), process.env);
    // The scan waits 2 s for the lock, gives up and ends with no alert.
    await sleep(2_600);
    expect(posts).toHaveLength(0);
    rmSync(lock, { recursive: true, force: true });
    // No further trail write: only the safety rescan can send the alert now.
    expect(await waitFor(() => posts.length >= 1, 20_000)).toBe(true);
  }, 40_000);

  it("scans a burst of trail writes that arrives while a scan is in progress", async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    server = await start();
    appendTrail(project, ev("tool.alpha", 3), process.env);
    appendTrail(project, ev("tool.alpha", 2), process.env);
    // The first scan is now stuck in the webhook delivery.
    expect(await waitFor(() => posts.length >= 1, 20_000)).toBe(true);
    for (let i = 0; i < 6; i++) appendTrail(project, ev("tool.beta", 2 - i * 0.1), process.env);
    await sleep(400);
    expect(posts).toHaveLength(1);
    release();
    expect(await waitFor(() => posts.length >= 2, 20_000)).toBe(true);
    expect(JSON.stringify(posts[1])).toContain("tool.beta");
  }, 40_000);
});
