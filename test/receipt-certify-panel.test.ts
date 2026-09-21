// test/receipt-certify-panel.test.ts
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeLiveCertify } from "../src/certify/live.js";
import { loadCertifyCard, type CertifyCard } from "../src/receipt/enrich.js";
import {
  buildWindowReceiptModel,
  loadReceiptModel,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../src/receipt/render-receipt.js";
import { globalTrailPath } from "../src/trail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-receipt-certify-"));
  dirs.push(d);
  return d;
}

/** Seed the global trail with one live event inside the 30d window. */
function seedTrail(home: string): void {
  mkdirSync(join(home, ".kya"), { recursive: true });
  writeFileSync(
    globalTrailPath({ KYA_HOME: home }),
    `${JSON.stringify({
      ts: new Date(Date.now() - 60_000).toISOString(),
      sessionId: "s1",
      toolId: "Read",
      verdict: "ALLOW",
      reasonCode: "LOW_RISK_READ",
      mode: "hold",
      product: "claude",
      project: "demo",
    })}\n`,
  );
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

describe("loadCertifyCard", () => {
  it("builds a card from a seeded home (KYA_HOLD=1, one trail event)", () => {
    const cwd = tmp();
    const home = tmp();
    seedTrail(home);
    const env = { KYA_HOME: home, KYA_HOLD: "1" };
    const card = loadCertifyCard(cwd, env);
    expect(card).toBeDefined();
    if (!card) return;

    const report = computeLiveCertify(cwd, env, 30);
    expect(card.result).toBe(report.overall.result);
    expect(card.pass).toBe(report.overall.pass);
    expect(card.gap).toBe(report.overall.gap);
    expect(card.insufficientEvidence).toBe(report.overall.insufficientEvidence);
    expect(card.attested).toBe(report.overall.attested);
    // KYA_HOLD=1 → at least SEC-01 passes; the card is a real evaluation
    expect(card.pass).toBeGreaterThanOrEqual(1);
    expect(card.windowDays).toBe(30);
    expect(card.trailEvents).toBe(report.trail.eventCount);
    expect(card.trailEvents).toBe(1);

    // Top gaps: at most 5, all real gap requirements, severity-then-id order
    expect(card.topGaps.length).toBeLessThanOrEqual(5);
    const gapIds = new Set(
      report.requirements.filter((r) => r.status === "gap").map((r) => r.id),
    );
    for (const g of card.topGaps) {
      expect(gapIds.has(g.id)).toBe(true);
      expect(SEV_RANK[g.severity]).toBeDefined();
    }
    const sorted = [...card.topGaps].sort(
      (a, b) =>
        (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) ||
        a.id.localeCompare(b.id),
    );
    expect(card.topGaps).toEqual(sorted);
    // And it really is the head of the full sorted gap list
    const expected = report.requirements
      .filter((r) => r.status === "gap")
      .map((r) => ({ id: r.id, severity: r.severity }))
      .sort(
        (a, b) =>
          (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 5);
    expect(card.topGaps).toEqual(expected);
  });

  it("NEVER throws — unreadable project trail state yields undefined", () => {
    const cwd = tmp();
    const home = tmp(); // global trail absent
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    const legacyTrail = join(cwd, ".kya", "trail.jsonl");
    writeFileSync(legacyTrail, "{}\n");
    chmodSync(legacyTrail, 0o000);
    let card: CertifyCard | undefined;
    expect(() => {
      card = loadCertifyCard(cwd, { KYA_HOME: home });
    }).not.toThrow();
    expect(card).toBeUndefined();
    chmodSync(legacyTrail, 0o600);
  });

  it("loadReceiptModel threads the certify card through extras like orr", () => {
    const cwd = tmp();
    const model = loadReceiptModel({ cwd, days: 3 });
    const c = model.certify;
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.windowDays).toBe(30);
    // Counts cover every catalog requirement (30) — never a partial rollup
    expect(c.pass + c.gap + c.insufficientEvidence + c.attested).toBe(30);
  });
});

const GAP_CARD: CertifyCard = {
  result: "gap",
  pass: 20,
  gap: 3,
  insufficientEvidence: 6,
  attested: 1,
  windowDays: 30,
  trailEvents: 42,
  topGaps: [
    { id: "SEC-04", severity: "critical" },
    { id: "DP-01", severity: "high" },
  ],
};

const PASS_CARD: CertifyCard = {
  result: "pass",
  pass: 26,
  gap: 0,
  insufficientEvidence: 4,
  attested: 0,
  windowDays: 30,
  trailEvents: 7,
  topGaps: [],
};

/** All-insufficient state: fail-closed gap result with zero gap requirements. */
const INSUFFICIENT_CARD: CertifyCard = {
  result: "gap",
  pass: 0,
  gap: 0,
  insufficientEvidence: 30,
  attested: 0,
  windowDays: 30,
  trailEvents: 0,
  topGaps: [],
};

describe("renderReceiptHtml certify panel", () => {
  it("renders a gap card: aria-label, amber pill, counts, top gaps, hint", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: GAP_CARD }));
    expect(html).toContain('aria-label="Certify"');
    expect(html).toContain("Certify — Agent Trust Baseline");
    expect(html).toContain('<span class="pill orr-amber">gap</span>');
    expect(html).toContain('<span class="kpi-num warn">3</span><span class="kpi-lab">Gap</span>');
    expect(html).toContain('<span class="kpi-num ok">20</span><span class="kpi-lab">Pass</span>');
    expect(html).toContain("SEC-04");
    expect(html).toContain("DP-01");
    expect(html).toContain("window 30d, 42 trail events");
    expect(html).toContain("kya certify for the full gap report + signed bundle");
  });

  it("renders a pass card with the green pill", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: PASS_CARD }));
    expect(html).toContain('aria-label="Certify"');
    expect(html).toContain('<span class="pill orr-green">pass</span>');
    expect(html).not.toContain('<span class="pill orr-amber">');
  });

  it("renders a fail-closed neutral Certify hero when the card is undefined", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    // The hero slot always renders: no evaluation must never read as a pass.
    expect(html).toContain('aria-label="Certify"');
    expect(html).toContain('<span class="pill">not evaluated</span>');
    expect(html).not.toContain('class="pill orr-green"');
    expect(html).not.toContain('class="pill orr-amber"');
  });

  it("fail-closed all-insufficient card: amber gap pill, NO gap list", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, { certify: INSUFFICIENT_CARD }),
    );
    expect(html).toContain('aria-label="Certify"');
    expect(html).toContain('<span class="pill orr-amber">gap</span>');
    expect(html).toContain('<span class="kpi-num">0</span><span class="kpi-lab">Gap</span>');
    expect(html).toContain('<span class="kpi-num mute">30</span><span class="kpi-lab">Insufficient</span>');
    // Zero gap requirements → no gap rows at all (no vacuous list markup)
    expect(html).not.toContain('<ul class="rows">');
  });
});

describe("renderReceiptMarkdown certify section", () => {
  it("includes ## Certify with the counts line when the card is present", () => {
    const md = renderReceiptMarkdown(buildWindowReceiptModel([], 3, { certify: GAP_CARD }));
    expect(md).toContain("## Certify");
    expect(md).toContain("result: gap");
    expect(md).toContain("20 pass");
    expect(md).toContain("3 gap");
    expect(md).toContain("`SEC-04`");
    expect(md).toContain("`DP-01`");
    expect(md).toContain("kya certify");
  });

  it("puts ## Certify before ## Analytics and ## Feed (dashboard hierarchy)", () => {
    const events = [
      {
        ts: "2026-09-21T00:00:00.000Z",
        sessionId: "s1",
        toolId: "Bash",
        verdict: "DENY",
        reasonCode: "SHELL_EXEC",
        mode: "hold" as const,
      },
    ];
    const md = renderReceiptMarkdown(buildWindowReceiptModel(events, 3, { certify: GAP_CARD }));
    const iCertify = md.indexOf("## Certify");
    expect(iCertify).toBeGreaterThan(-1);
    expect(iCertify).toBeLessThan(md.indexOf("## Analytics"));
    expect(iCertify).toBeLessThan(md.indexOf("## Feed"));
  });

  it("omits ## Certify when the card is absent", () => {
    const md = renderReceiptMarkdown(buildWindowReceiptModel([], 3));
    expect(md).not.toContain("## Certify");
  });

  it("fail-closed all-insufficient card: honest section, no empty Top gaps list", () => {
    const md = renderReceiptMarkdown(
      buildWindowReceiptModel([], 3, { certify: INSUFFICIENT_CARD }),
    );
    expect(md).toContain("## Certify");
    expect(md).toContain("result: gap");
    expect(md).toContain("0 gap");
    expect(md).toContain("30 insufficient");
    expect(md).not.toContain("Top gaps:");
  });
});
