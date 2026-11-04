/**
 * Live report Map tab: GET /map.json (token gate, 405 for other methods), the Map section in the live page,
 * the map fragment on POST /fragments, and a static receipt that stays without the tab.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { startLiveReceiptServer, type LiveReceiptServer } from "../src/receipt/live-server.js";
import { loadReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";
import { ADVISORY_LINE } from "../src/map/page.js";
import { trailPath } from "../src/trail.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "map", "trail.jsonl");

let dir: string;
let config: ResolvedConfig;
const servers: LiveReceiptServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-map-live-"));
  config = resolveConfig({ cwd: dir, offline: true, allowMissingApiKey: true, env: { KYA_OFFLINE: "1" }, flags: { offline: true } });
  // setup.ts gives each test its own KYA_HOME; the live server reads the trail from there.
  const file = trailPath(dir, process.env);
  mkdirSync(dirname(file), { recursive: true });
  const rows = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { ts: string });
  const newest = Math.max(...rows.map((r) => Date.parse(r.ts)));
  const delta = Date.now() - 3_600_000 - newest;
  writeFileSync(file, `${rows.map((r) => JSON.stringify({ ...r, ts: new Date(Date.parse(r.ts) + delta).toISOString() })).join("\n")}\n`);
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

async function start(): Promise<LiveReceiptServer> {
  const s = await startLiveReceiptServer({ config, days: 3 });
  servers.push(s);
  return s;
}

describe("kya map on the live report", { timeout: 60_000 }, () => {
  it("GET /map.json with the token returns the graph and the heat views (200)", async () => {
    const s = await start();
    const res = await fetch(`http://127.0.0.1:${s.port}/map.json?t=${s.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const j = (await res.json()) as { nodes: unknown[]; edges: unknown[]; heat: { when: { days: string[] } } };
    expect(j.nodes.length).toBeGreaterThan(10);
    expect(j.edges.length).toBeGreaterThan(10);
    expect(j.heat.when.days).toHaveLength(7);
    // The graph holds recent activity: not for a shared cache or a back button (review item 5).
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET /map.json without a token, or with a wrong one, is refused (401)", async () => {
    const s = await start();
    expect((await fetch(`http://127.0.0.1:${s.port}/map.json`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${s.port}/map.json?t=wrong`)).status).toBe(401);
  });

  it("POST /map.json with the token is 405 and names GET as the allowed method", async () => {
    const s = await start();
    const res = await fetch(`http://127.0.0.1:${s.port}/map.json?t=${s.token}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("the live page has the Map tab, the Map section and the vendored library, behind the token", async () => {
    const s = await start();
    expect((await fetch(`http://127.0.0.1:${s.port}/`)).status).toBe(401);
    const html = await (await fetch(`http://127.0.0.1:${s.port}/?t=${s.token}`)).text();
    expect(html).toContain('href="#map"');
    expect(html).toContain('<section class="zone" id="map"');
    expect(html).toContain('id="frag-map"');
    expect(html).toContain('<script id="kya-map">');
    expect(html).not.toContain(s.token);
    expect(html).not.toContain("Cytoscape Consortium");
    const lib = await fetch(`http://127.0.0.1:${s.port}/vendor/cytoscape.min.js?t=${s.token}`);
    expect(lib.status).toBe(200);
    expect(await lib.text()).toContain("Cytoscape Consortium");
    expect((await fetch(`http://127.0.0.1:${s.port}/vendor/cytoscape.min.js`)).status).toBe(401);
  });

  it("POST /fragments with map:true returns the map body; without it, the activity fragments are unchanged", async () => {
    const s = await start();
    const url = `http://127.0.0.1:${s.port}/fragments?t=${s.token}`;
    const map = (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"map":true}' })).json()) as {
      ok: boolean;
      fragments: { mapBody: string };
    };
    expect(map.ok).toBe(true);
    expect(map.fragments.mapBody).toContain('id="kya-map-data"');
    expect(map.fragments.mapBody).toContain(ADVISORY_LINE);
    const plain = (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as {
      fragments: Record<string, unknown>;
    };
    expect(plain.fragments).toHaveProperty("statCounts");
    expect(plain.fragments).not.toHaveProperty("mapBody");
  });

  it("a hostile trail on the live report: the map fragment carries no raw markup", async () => {
    const file = trailPath(dir, process.env);
    const ts = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(file, `${JSON.stringify({ ts, sessionId: "s-h", product: "claude", project: "</script><script>alert(1)</script>", toolId: "<img src=x onerror=alert(1)>", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" })}\n`);
    const s = await start();
    const r = (await (await fetch(`http://127.0.0.1:${s.port}/fragments?t=${s.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"map":true}' })).json()) as {
      fragments: { mapBody: string };
    };
    expect(r.fragments.mapBody).not.toContain("<img src=x onerror=alert(1)>");
    expect(r.fragments.mapBody).not.toContain("</script><script>alert(1)</script>");
  });

  it("a static receipt (kya receipt, no live token) has no Map tab", () => {
    const model = loadReceiptModel({ cwd: dir, days: 3 });
    expect(renderReceiptHtml(model)).not.toContain('id="map"');
  });
});
