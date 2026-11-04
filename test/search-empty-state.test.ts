import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import { renderFeedPage } from "../src/receipt/render-receipt.js";
import { appendTrail, type TrailEvent } from "../src/trail.js";
import { installFakeRuntime } from "./support/fake-fastembed.js";

vi.mock("../src/commands/gate.js", () => ({
  runGateRun: vi.fn(),
  runGateStop: vi.fn(),
  runGateDoctor: vi.fn(),
}));

const EVENT: TrailEvent = {
  ts: new Date(Date.now() - 1000).toISOString(),
  sessionId: "empty-state",
  product: "claude",
  toolId: "Bash",
  verdict: "ALLOW",
  reasonCode: "ALLOW",
  mode: "observe",
  summary: "ran ls in the project",
};

describe("activity search: empty state", () => {
  let dir: string;
  let config: ResolvedConfig;
  const servers: Awaited<ReturnType<typeof startLiveReceiptServer>>[] = [];
  const savedHome = process.env.KYA_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kya-empty-search-"));
    process.env.KYA_HOME = dir; // keeps the opt-in runtime prefix inside the temp dir
    config = resolveConfig({
      cwd: dir,
      offline: true,
      allowMissingApiKey: true,
      env: { KYA_OFFLINE: "1" },
      flags: { offline: true },
    });
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close().catch(() => undefined);
    if (savedHome === undefined) delete process.env.KYA_HOME;
    else process.env.KYA_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a search with no hits says no events match and how to turn on plain-language search", () => {
    const r = renderFeedPage([EVENT], {}, 1, Date.now(), true, "dangerous");
    expect(r.total).toBe(0);
    expect(r.feedHtml).toContain("No events match");
    expect(r.feedHtml).toContain("dangerous");
    expect(r.feedHtml).toContain("Plain-language search is off");
    expect(r.feedHtml).toContain("npm install --prefix");
    expect(r.feedHtml).toContain("@shield-agent/fastembed@3.0.0");
    expect(r.feedHtml).not.toContain("No events yet");
  });

  it("with the runtime installed the page does not claim plain-language search is off", () => {
    installFakeRuntime(process.env);
    const r = renderFeedPage([EVENT], {}, 1, Date.now(), true, "dangerous");
    expect(r.feedHtml).toContain("No events match");
    expect(r.feedHtml).not.toContain("Plain-language search is off");
  });

  it("the search text is escaped", () => {
    const r = renderFeedPage([EVENT], {}, 1, Date.now(), true, "<img src=x onerror=alert(1)>");
    expect(r.feedHtml).not.toContain("<img src=x");
    expect(r.feedHtml).toContain("&lt;img");
  });

  it("filters that hide every event say so, without a search", () => {
    const r = renderFeedPage([EVENT], { verdict: ["DENY"] }, 1, Date.now(), true);
    expect(r.feedHtml).toContain("No events match these filters");
    expect(r.feedHtml).not.toContain("No events yet");
  });

  it("an empty trail still says no events yet", () => {
    const r = renderFeedPage([], {}, 1, Date.now(), true, "dangerous");
    expect(r.feedHtml).toContain("No events yet");
    expect(r.feedHtml).not.toContain("No events match");
  });

  it("live server: POST /feed with an unmatched search returns the no-match message", async () => {
    appendTrail(dir, EVENT);
    const s = await startLiveReceiptServer({ config, days: 3 });
    servers.push(s);
    const res = await fetch(`http://127.0.0.1:${s.port}/feed?t=${s.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: {}, page: 1, q: "dangerous" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; feedHtml?: string; total?: number };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(0);
    expect(body.feedHtml).toContain("No events match");
    expect(body.feedHtml).toContain("Plain-language search is off");
    expect(body.feedHtml).not.toContain("No events yet");
  });
});
