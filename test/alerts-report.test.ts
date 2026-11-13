/**
 * kya-alerts: the report daemon runs the incident scan when the trail changes (at most once per
 * interval) and the overview lists the incidents that alerted. Real live server, real files, a
 * local HTTP receiver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import { appendTrail, type TrailEvent } from "../src/trail.js";
import { resetNotifyState } from "../src/notify/index.js";
import { installFakeModel, installFakeOrt } from "./support/fake-triage-runtime.js";

vi.mock("../src/commands/gate.js", () => ({ runGateRun: vi.fn(), runGateStop: vi.fn(), runGateDoctor: vi.fn() }));

const ev = (tool: string, minAgo: number): TrailEvent => ({
  ts: new Date(Date.now() - minAgo * 60_000).toISOString(),
  sessionId: "report-session",
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

describe("kya-alerts report daemon", () => {
  let home: string;
  let project: string;
  let sink: Server;
  const posts: Array<Record<string, unknown>> = [];
  let server: Awaited<ReturnType<typeof startLiveReceiptServer>> | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kya-alerts-report-home-"));
    project = mkdtempSync(join(tmpdir(), "kya-alerts-report-proj-"));
    posts.length = 0;
    resetNotifyState();
    sink = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += String(d)));
      req.on("end", () => {
        posts.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200).end("{}");
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

  it("scans on a trail change, throttles the next scan, and lists the alerted incident on the overview", async () => {
    const config = resolveConfig({ cwd: project, offline: true, allowMissingApiKey: true, env: { KYA_OFFLINE: "1" }, flags: { offline: true } });
    server = await startLiveReceiptServer({ config, days: 3, alertScanMinMs: 1_500 });
    // First change: scans at once.
    appendTrail(project, ev("tool.alpha", 3), process.env);
    appendTrail(project, ev("tool.alpha", 2), process.env);
    expect(await waitFor(() => posts.length >= 1, 20_000)).toBe(true);
    // Second change right after: held back until the interval has passed, then scanned once.
    appendTrail(project, ev("tool.beta", 2), process.env);
    appendTrail(project, ev("tool.beta", 1), process.env);
    await new Promise((r) => setTimeout(r, 400));
    expect(posts).toHaveLength(1);
    expect(await waitFor(() => posts.length >= 2, 20_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p["event"] === "incident.opened")).toBe(true);

    const html = await (await fetch(server.url)).text();
    expect(html).toContain("Incident alerts");
    expect(html).toContain("Never-list tool attempted repeatedly");
  }, 60_000);

  it("with the local model installed, the daemon adds triage to the alert and the overview list shows it", async () => {
    installFakeOrt({ KYA_HOME: home });
    installFakeModel({ KYA_HOME: home });
    const config = resolveConfig({ cwd: project, offline: true, allowMissingApiKey: true, env: { KYA_OFFLINE: "1" }, flags: { offline: true } });
    server = await startLiveReceiptServer({ config, days: 3, alertScanMinMs: 200 });
    appendTrail(project, ev("tool.alpha", 3), process.env);
    appendTrail(project, ev("tool.alpha", 2), process.env);
    expect(await waitFor(() => posts.length >= 1, 20_000)).toBe(true);
    expect((posts[0]!["incident"] as Record<string, any>)["triage"]).toMatchObject({ model: "kya-triage-test", category: { id: "credential-access" } });
    const html = await (await fetch(server.url)).text();
    expect(html).toContain("triage (local model, advisory): credential-access");
  }, 60_000);

  it("does nothing when alerts are off", async () => {
    vi.stubEnv("KYA_ALERTS", "off");
    const config = resolveConfig({ cwd: project, offline: true, allowMissingApiKey: true, env: { KYA_OFFLINE: "1" }, flags: { offline: true } });
    server = await startLiveReceiptServer({ config, days: 3, alertScanMinMs: 200 });
    appendTrail(project, ev("tool.alpha", 3), process.env);
    appendTrail(project, ev("tool.alpha", 2), process.env);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(posts).toHaveLength(0);
    expect(await (await fetch(server.url)).text()).not.toContain("Incident alerts");
  }, 20_000);
});
