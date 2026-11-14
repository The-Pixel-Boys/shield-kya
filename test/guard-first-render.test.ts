/**
 * Features kya-receipt (Blocked panel first, Certify out of the first screen) and kya-start (guard proof lines).
 * Unit tests for the renderer and the proof helpers; the built-CLI paths are in guard-first-e2e.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { CertifyCard } from "../src/receipt/enrich.js";
import {
  blockedCalls,
  buildLiveFragments,
  buildWindowReceiptModel,
  isPlaneConfigured,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../src/receipt/render-receipt.js";
import { DEMO_CALLS, PROMISE, demoLabels } from "../src/guard-demo.js";
import { formatProofLines, guardProof, type GuardProof } from "../src/commands/start.js";
import type { TrailEvent } from "../src/trail.js";

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function row(partial: Partial<TrailEvent>): TrailEvent {
  return { ts: iso(0), sessionId: "s", toolId: "Bash", verdict: "ALLOW", outcome: "ran", reasonCode: "ALLOW", mode: "offline", ...partial };
}
const blocked = (n: number, extra: Partial<TrailEvent> = {}) =>
  row({ ts: iso(n * 60_000), toolId: "Bash", verdict: "DENY", outcome: "blocked", reasonCode: "NEVER_EVENT", neverEvent: true, summary: `call ${n}`, ...extra });

const GAP_CARD: CertifyCard = {
  result: "gap",
  pass: 7,
  gap: 19,
  insufficientEvidence: 5,
  attested: 0,
  windowDays: 30,
  trailEvents: 3,
  topGaps: [{ id: "SAFE-04", title: "Destructive operations require human approval", severity: "critical", evidence: "e" }],
  requirements: [],
};

/** The overview zone of the page: what the person sees first. */
function overview(html: string): string {
  const a = html.indexOf('<section class="zone" id="overview"');
  return html.slice(a, html.indexOf('<section class="zone" id="activity"'));
}

describe("Blocked panel (HTML)", () => {
  it("with no activity: three demo rows, labelled demo, count 0", () => {
    const o = overview(renderReceiptHtml(buildWindowReceiptModel([], 3)));
    expect(o).toContain('aria-label="Blocked"');
    expect(o).toContain('<span class="blk-num">0</span>');
    for (const c of DEMO_CALLS) {
      expect(o).toContain(`<code>${c.label}</code>`);
      expect(o).toContain(c.what);
    }
    expect(o.match(/<span class="pill">demo<\/span>/g)!.length).toBeGreaterThanOrEqual(4);
    expect(o).toContain("These rows are samples, not your activity");
  });

  it("with calls that ran but none blocked: still the labelled demo, never a count of demo rows as activity", () => {
    const o = overview(renderReceiptHtml(buildWindowReceiptModel([row({}), row({ ts: iso(1000) })], 3)));
    expect(o).toContain('<span class="blk-num">0</span>');
    expect(o).toContain("demo");
  });

  it("with blocked rows: the count and the five most recent, newest first; no demo label", () => {
    const events = [1, 2, 3, 4, 5, 6, 7].map((n) => blocked(n));
    const o = overview(renderReceiptHtml(buildWindowReceiptModel(events, 3)));
    expect(o).toContain('<span class="blk-num bad">7</span>');
    expect(o).not.toMatch(/<span class="pill">demo<\/span>/);
    const shown = [...o.matchAll(/shell|call (\d)/g)];
    const nums = [...o.matchAll(/<span class="blk-what">call (\d)<\/span>/g)].map((m) => Number(m[1]));
    expect(shown.length).toBeGreaterThan(0);
    expect(nums).toEqual([1, 2, 3, 4, 5]);
    expect(o).toContain("Showing the last 5 of 7");
  });

  it("counts by outcome only: a DENY row without an outcome is not a blocked call", () => {
    const legacy = row({ verdict: "DENY", reasonCode: "NEVER_EVENT" });
    delete (legacy as { outcome?: string }).outcome;
    expect(blockedCalls([legacy, row({ outcome: "ran", verdict: "DENY" }), row({ outcome: "held" })])).toEqual([]);
    expect(blockedCalls([blocked(2), blocked(1)]).map((e) => e.summary)).toEqual(["call 1", "call 2"]);
  });

  it("escapes row text", () => {
    const o = overview(renderReceiptHtml(buildWindowReceiptModel([blocked(1, { toolId: "<b>x</b>", summary: "<img src=x>" })], 3)));
    expect(o).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(o).not.toContain("<img src=x>");
  });
});

describe("Certify leaves the first screen", () => {
  it("the overview has no Certify panel and no gap count; the Certify tab holds the panel", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([blocked(1)], 3, { certify: GAP_CARD }));
    const o = overview(html);
    expect(o).not.toContain('aria-label="Certify"');
    expect(o).not.toMatch(/\bgap\b/i);
    expect(o).not.toContain("SAFE-04");
    const certify = html.slice(html.indexOf('<section class="zone" id="certify"'), html.indexOf('<section class="zone" id="orr"'));
    expect(certify).toContain('aria-label="Certify"');
    expect(certify).toContain("SAFE-04");
    expect(certify).toContain('<span class="kpi-num warn">19</span>');
  });

  it("the nav shows no count on Certify, in the page and in the live refresh", () => {
    const model = buildWindowReceiptModel([blocked(1)], 3, { certify: GAP_CARD });
    const html = renderReceiptHtml(model);
    const link = html.slice(html.indexOf('id="tab-certify"'), html.indexOf("</a>", html.indexOf('id="tab-certify"')));
    expect(link).not.toContain("nav-count");
    const live = buildLiveFragments(model, true);
    expect(live.nav.certify).toBeNull();
  });

  it("live fragments carry heroBlocked and no heroCertify; the certify body carries the panel", () => {
    const live = buildLiveFragments(buildWindowReceiptModel([blocked(1)], 3, { certify: GAP_CARD }), true);
    expect(live.fragments.heroBlocked).toContain('id="frag-hero-blocked"');
    expect(live.fragments).not.toHaveProperty("heroCertify");
    expect(live.fragments.certifyBody).toContain('aria-label="Certify"');
  });

  it("an absent card keeps the fail-closed none panel in the Certify tab, with the empty hint", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    const certify = html.slice(html.indexOf('<section class="zone" id="certify"'), html.indexOf('<section class="zone" id="orr"'));
    expect(certify).toContain("hero-certify none");
    expect(certify).toContain("zone-empty");
  });
});

describe("report title and Markdown", () => {
  it("title and h1 carry the promise", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(html).toContain(`<title>${PROMISE} - last 3 days</title>`);
    expect(html).toContain(`<h1>${PROMISE}</h1>`);
  });

  it("Markdown starts with the promise and the Blocked section; Certify (with its gap count) comes last", () => {
    const md = renderReceiptMarkdown(buildWindowReceiptModel([row({})], 3, { certify: GAP_CARD }));
    const lines = md.split("\n");
    expect(lines[0]).toBe(`# ${PROMISE}`);
    expect(lines[4]).toBe("## Blocked (demo)");
    const iCertify = md.indexOf("## Certify");
    expect(iCertify).toBeGreaterThan(-1);
    expect(md.slice(0, iCertify)).not.toMatch(/\bgap\b/i);
    expect(md.slice(iCertify)).toContain("19 gap");
    expect(md.indexOf("## Certify")).toBeGreaterThan(md.indexOf("## Feed"));
  });

  it("Markdown with blocked rows: count, last five, newest first", () => {
    const md = renderReceiptMarkdown(buildWindowReceiptModel([6, 5, 4, 3, 2, 1].map((n) => blocked(n)), 3));
    expect(md).toContain("## Blocked\n");
    expect(md).toContain("6 calls blocked in this window. Last 5:");
    const section = md.slice(md.indexOf("## Blocked"), md.indexOf("\n## ", md.indexOf("## Blocked") + 5));
    expect([...section.matchAll(/call (\d)/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("control-plane address", () => {
  const identity = { agentId: "agt-1", agentName: "refund-bot", host: "ide" as const, baseUrl: "http://127.0.0.1:8090" };

  it("is hidden without a plane (name and id stay), shown with one, in HTML and Markdown", () => {
    const hidden = buildWindowReceiptModel([], 3, { identity });
    expect(renderReceiptHtml(hidden)).toContain('<div class="identity">refund-bot/agt-1</div>');
    expect(renderReceiptHtml(hidden)).not.toContain("127.0.0.1:8090");
    expect(renderReceiptMarkdown(hidden)).not.toContain("127.0.0.1:8090");
    const shown = buildWindowReceiptModel([], 3, { identity, planeConfigured: true });
    expect(renderReceiptHtml(shown)).toContain("refund-bot/agt-1 · ide · http://127.0.0.1:8090");
    expect(renderReceiptMarkdown(shown)).toContain("refund-bot/agt-1 · ide · http://127.0.0.1:8090");
  });

  it("no identity line at all when nothing but the placeholder is known", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { identity: { host: "ide", baseUrl: "http://127.0.0.1:8090" } }));
    expect(html).not.toContain('class="identity"');
  });

  it("isPlaneConfigured: API key, base URL env, or a base URL other than the init default; never the default alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "kya-plane-"));
    try {
      const env = { KYA_HOME: dir };
      expect(isPlaneConfigured(undefined, env)).toBe(false);
      expect(isPlaneConfigured({ baseUrl: "http://127.0.0.1:8090" }, env)).toBe(false);
      expect(isPlaneConfigured({ baseUrl: "http://127.0.0.1:8090/" }, env)).toBe(false);
      expect(isPlaneConfigured({ baseUrl: "https://plane.example.com" }, env)).toBe(true);
      expect(isPlaneConfigured(undefined, { ...env, KYA_API_KEY: "k" })).toBe(true);
      expect(isPlaneConfigured(undefined, { ...env, SHIELD_API_KEY: "k" })).toBe(true);
      expect(isPlaneConfigured(undefined, { ...env, KYA_BASE_URL: "http://127.0.0.1:9" })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("guard proof", () => {
  const proof = (blockedLabels: string[], hosts: string[]): GuardProof => ({
    demo: true,
    results: DEMO_CALLS.map((c) => ({ label: c.label, blocked: blockedLabels.includes(c.label) })),
    guardedHosts: hosts,
  });

  it("claims the agent is guarded only when all three are blocked and a host hook is in place", () => {
    const all = DEMO_CALLS.map((c) => c.label);
    expect(formatProofLines(proof(all, ["claude"])).at(-1)).toBe("Blocked: rm -rf ~, read .env, curl | sh. Your agent is now guarded.");
    const noHost = formatProofLines(proof(all, [])).join("\n");
    expect(noHost).toContain("Blocked: rm -rf ~, read .env, curl | sh.");
    expect(noHost).not.toContain("Your agent is now guarded");
    expect(noHost).toContain("no agent is guarded yet");
    const partial = formatProofLines(proof(["rm -rf ~", "curl | sh"], ["claude"])).join("\n");
    expect(partial).toContain("Blocked: rm -rf ~, curl | sh. Not blocked: read .env");
    expect(partial).not.toContain("Your agent is now guarded");
    const none = formatProofLines(proof([], ["claude"])).join("\n");
    expect(none).toContain("Not blocked: rm -rf ~, read .env, curl | sh");
    expect(none).not.toContain("Blocked: rm");
  });

  it("guardProof runs the three calls through the real hook and leaves no temp dir or trail behind", async () => {
    const base = mkdtempSync(join(tmpdir(), "kya-proof-test-"));
    // Private TMPDIR: other test files run `kya start` in parallel and make their own kya-proof-* dirs in the shared one.
    const tmp = mkdtempSync(join(tmpdir(), "kya-proof-tmp-"));
    const home = process.env.HOME;
    const kyaHome = process.env.KYA_HOME;
    const tmpEnv = process.env.TMPDIR;
    try {
      process.env.TMPDIR = tmp;
      process.env.HOME = base;
      process.env.KYA_HOME = join(base, "kh");
      const p = await guardProof(base, ["claude"]);
      expect(p?.results).toEqual(DEMO_CALLS.map((c) => ({ label: c.label, blocked: true })));
      expect(p?.guardedHosts).toEqual(["claude"]);
      // Nothing under the caller's KYA_HOME: the hook wrote to its own throw-away home.
      expect(readdirSync(base)).toEqual([]);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      if (tmpEnv === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpEnv;
      rmSync(tmp, { recursive: true, force: true });
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (kyaHome === undefined) delete process.env.KYA_HOME;
      else process.env.KYA_HOME = kyaHome;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("one promise", () => {
  const copy = JSON.parse(readFileSync(join(import.meta.dirname, "..", "channel-copy.json"), "utf8")) as { short: string; long: string };
  afterEach(() => undefined);

  it("the CLI promise equals channel-copy.json long, and short is its first sentence", () => {
    expect(copy.long).toBe(PROMISE);
    expect(PROMISE.startsWith(copy.short)).toBe(true);
    expect(PROMISE).toBe("Stops your coding agent from deleting, leaking or dropping things. Records everything else.");
  });

  it("demo labels read as the start line expects", () => {
    expect(demoLabels()).toBe("rm -rf ~, read .env, curl | sh");
  });
});
