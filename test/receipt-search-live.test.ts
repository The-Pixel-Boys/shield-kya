import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { runGateDoctor, runGateRun, runGateStop } from "../src/commands/gate.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import { appendTrail } from "../src/trail.js";

vi.mock("../src/commands/gate.js", () => ({
  runGateRun: vi.fn(),
  runGateStop: vi.fn(),
  runGateDoctor: vi.fn(),
}));

/** Deterministic fake embeddings for semantic-ranking wiring tests. */
class FakeEmbeddingProvider {
  async embed(text: string): Promise<number[] | undefined> {
    const t = text.toLowerCase();
    // Topic dimensions: 0=github, 1=issue/ticket, 2=deploy, 3=slack, 4=changelog/read.
    // A small baseline keeps every event in the ranked list so we can verify
    // the paraphrase target outranks unrelated events.
    const vec = [0.1, 0.1, 0.1, 0.1, 0.1];
    if (t.includes("github")) vec[0] = 1;
    if (t.includes("issue") || t.includes("ticket")) vec[1] = 1;
    if (t.includes("deploy")) vec[2] = 1;
    if (t.includes("slack")) vec[3] = 1;
    if (t.includes("changelog") || t.includes("read")) vec[4] = 1;
    return vec;
  }
}

describe("live receipt server search", () => {
  let dir: string;
  let config: ResolvedConfig;
  const servers: Awaited<ReturnType<typeof startLiveReceiptServer>>[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kya-live-search-"));
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

  async function start(
    provider?: FakeEmbeddingProvider,
  ): Promise<Awaited<ReturnType<typeof startLiveReceiptServer>>> {
    const s = await startLiveReceiptServer({ config, days: 3, embeddingProvider: provider });
    servers.push(s);
    return s;
  }

  function writeEvents(): void {
    appendTrail(dir, {
      ts: new Date(Date.now() - 3000).toISOString(),
      sessionId: "search-live",
      product: "cursor",
      toolId: "mcp__github__create_issue",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
      summary: "created a GitHub issue about deployment",
    });
    appendTrail(dir, {
      ts: new Date(Date.now() - 2000).toISOString(),
      sessionId: "search-live",
      product: "cursor",
      toolId: "org.sample.safe.read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
      summary: "read the changelog",
    });
    appendTrail(dir, {
      ts: new Date(Date.now() - 1000).toISOString(),
      sessionId: "search-live",
      product: "cursor",
      toolId: "mcp__slack__post_message",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
      summary: "posted a Slack update",
    });
  }

  it("ranks paraphrase hits above unrelated events", async () => {
    const s = await start(new FakeEmbeddingProvider());
    writeEvents();

    const res = await fetch(`http://127.0.0.1:${s.port}/feed?t=${s.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: {}, page: 1, q: "opened a GitHub ticket" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      feedHtml?: string;
      total?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(3);
    const html = body.feedHtml ?? "";
    // The top result should be the GitHub event.
    const firstArticle = html.match(/<article[^>]*>/)?.[0] ?? "";
    expect(firstArticle).toContain("mcp__github__create_issue");
  });

  it("returns lexical matches when semantic search is disabled", async () => {
    const s = await start();
    writeEvents();

    const res = await fetch(`http://127.0.0.1:${s.port}/feed?t=${s.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: {}, page: 1, q: "slack" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      feedHtml?: string;
      total?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
    expect(body.feedHtml).toContain("mcp__slack__post_message");
  });
});
