// test/receipt-certify-tab.test.ts
import { describe, expect, it } from "vitest";
import type {
  CertifyRequirementResult,
  RequirementSeverity,
  RequirementStatus,
} from "../src/certify/evaluate.js";
import type { CertifyCard } from "../src/receipt/enrich.js";
import { receiptCss } from "../src/receipt/receipt-css.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

/**
 * The dedicated Certify tab: a 4th :target zone between Overview and
 * Activity carrying the full live requirement table — all 30 requirements
 * grouped by the 6 catalog domains in catalog order, with status pills,
 * evidence lines, and attestation text. Fail-closed: no card, no table.
 */

const EVENTS: TrailEvent[] = [
  {
    ts: new Date().toISOString(),
    sessionId: "s",
    toolId: "org.sample.safe.read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
  },
];

function req(
  id: string,
  domain: string,
  severity: RequirementSeverity,
  status: RequirementStatus,
  title: string,
  extra: Partial<Pick<CertifyRequirementResult, "evidence" | "attestation">> = {},
): CertifyRequirementResult {
  return {
    id,
    domain,
    title,
    severity,
    status,
    evidence: extra.evidence ?? `evidence for ${id}`,
    ...(extra.attestation ? { attestation: extra.attestation } : {}),
  };
}

/** All 30 catalog requirements, catalog order, with a realistic status mix. */
const REQS: CertifyRequirementResult[] = [
  req("DP-01", "data-privacy", "high", "pass", "Agent tool calls are intercepted and recorded"),
  req("DP-02", "data-privacy", "critical", "gap", "No high-stakes writes allowed in hold mode"),
  req("DP-03", "data-privacy", "critical", "pass", "No shell execution allowed in hold mode"),
  req("DP-04", "data-privacy", "high", "insufficient_evidence", "Redaction by construction"),
  req("DP-05", "data-privacy", "medium", "pass", "Bounded local evidence retention"),
  req("SEC-01", "security", "high", "pass", "Gate enforces, not observe-only"),
  req("SEC-02", "security", "medium", "pass", "Deny path is exercised"),
  req("SEC-03", "security", "medium", "gap", "Human approval path is exercised"),
  req("SEC-04", "security", "high", "gap", "ORR security posture is not red"),
  req("SEC-05", "security", "high", "insufficient_evidence", "No unknown tools allowed in hold mode"),
  req("SAFE-01", "safety", "critical", "pass", "Never-events are never allowed"),
  req("SAFE-02", "safety", "medium", "gap", "Sandbox available for high-risk execution"),
  req("SAFE-03", "safety", "high", "gap", "Latest ORR overall is not red"),
  req("SAFE-04", "safety", "critical", "gap", "Destructive operations require human approval"),
  req("SAFE-05", "safety", "medium", "gap", "Blocked actions have a retry policy"),
  req("REL-01", "reliability", "high", "insufficient_evidence", "Trail recording is active"),
  req("REL-02", "reliability", "medium", "insufficient_evidence", "Unknown-tool rate is bounded"),
  req("REL-03", "reliability", "medium", "insufficient_evidence", "ORR evidence is fresh (30 days)"),
  req("REL-04", "reliability", "low", "insufficient_evidence", "Evidence pipeline continuity is monitored"),
  req("REL-05", "reliability", "low", "insufficient_evidence", "Receipts are generated"),
  req("ACC-01", "accountability", "high", "pass", "Session identity on all events"),
  req("ACC-02", "accountability", "medium", "pass", "Project attribution on events"),
  req("ACC-03", "accountability", "medium", "pass", "ORR evidence exists (90 days)"),
  req("ACC-04", "accountability", "low", "pass", "Cost showback is available"),
  req("ACC-05", "accountability", "high", "pass", "Named human policy owner"),
  req("SOC-01", "society", "high", "attested", "Acceptable-use policy", {
    evidence: "attested by operator",
    attestation: {
      text: "AUP signed by ops — filed in the team wiki",
      at: "2026-09-01T12:00:00.000Z",
    },
  }),
  req("SOC-02", "society", "high", "insufficient_evidence", "Incident-response runbook"),
  req("SOC-03", "society", "medium", "insufficient_evidence", "Third-party model disclosure"),
  req("SOC-04", "society", "high", "insufficient_evidence", "Data-processing terms"),
  req("SOC-05", "society", "medium", "insufficient_evidence", "Human escalation contact"),
];

const FULL_CARD: CertifyCard = {
  result: "gap",
  pass: 11,
  gap: 7,
  insufficientEvidence: 11,
  attested: 1,
  windowDays: 30,
  trailEvents: 42,
  topGaps: [],
  requirements: REQS,
};

function htmlWith(card: CertifyCard | undefined): string {
  return renderReceiptHtml(
    buildWindowReceiptModel(EVENTS, 3, card ? { certify: card } : {}),
  );
}

/** The Certify zone markup only (from its section tag to the Activity zone). */
function certifyZone(html: string): string {
  const start = html.indexOf('<section class="zone" id="certify"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('<section class="zone" id="activity"');
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("Certify tab (4th zone)", () => {
  it("(a) ships a Certify tab between Overview and Activity with aria wiring", () => {
    const html = htmlWith(FULL_CARD);
    expect(html).toContain('<a class="tab" id="tab-certify" href="#certify">Certify</a>');
    expect(html).toContain('<section class="zone" id="certify" aria-labelledby="tab-certify">');
    // Nav order: Overview / Certify / Activity / System.
    const nav = html.slice(html.indexOf('<nav class="tabs"'), html.indexOf("</nav>"));
    const iOverview = nav.indexOf('href="#overview"');
    const iCertify = nav.indexOf('href="#certify"');
    const iActivity = nav.indexOf('href="#activity"');
    const iSystem = nav.indexOf('href="#system"');
    expect(iOverview).toBeGreaterThan(-1);
    expect(iCertify).toBeGreaterThan(iOverview);
    expect(iActivity).toBeGreaterThan(iCertify);
    expect(iSystem).toBeGreaterThan(iActivity);
    // Zone order matches: the Certify zone sits between Overview and Activity.
    expect(html.indexOf('<section class="zone" id="overview"')).toBeLessThan(
      html.indexOf('<section class="zone" id="certify"'),
    );
    expect(html.indexOf('<section class="zone" id="certify"')).toBeLessThan(
      html.indexOf('<section class="zone" id="activity"'),
    );
  });

  it("(b) extends EVERY tab-switch selector to #certify inside the :has() gate", () => {
    const css = receiptCss();
    const gate = css.indexOf("@supports selector(body:has(*))");
    expect(gate).toBeGreaterThan(-1);
    const patterns = [
      "#changes, #activity, #certify, #system { display: none; }",
      "#overview:target, #changes:target, #activity:target, #certify:target, #system:target { display: block; }",
      "body:has(#certify:target) #overview",
      'body:has(#certify:target) .tab[href="#certify"]',
    ];
    for (const p of patterns) {
      const i = css.indexOf(p);
      expect(i, `missing selector pattern: ${p}`).toBeGreaterThan(gate);
    }
  });

  it("(c) renders all 30 requirement rows grouped by the 6 domains in catalog order", () => {
    const zone = certifyZone(htmlWith(FULL_CARD));
    expect(zone).toContain('aria-label="Certify detail"');
    // Every requirement: <code>ID</code> — title, with a status pill.
    for (const r of REQS) {
      expect(zone).toContain(`<code>${r.id}</code> — ${r.title}`);
    }
    // Status pill counts match the fixture mix (pass 11 / gap 7 /
    // insufficient 11 / attested 1).
    expect(zone.match(/class="pill ok">pass<\/span>/g)).toHaveLength(11);
    expect(zone.match(/class="pill orr-amber">gap<\/span>/g)).toHaveLength(7);
    expect(zone.match(/class="pill">insufficient evidence<\/span>/g)).toHaveLength(11);
    expect(zone.match(/class="pill att">attested<\/span>/g)).toHaveLength(1);
    // Domain headings (esc'd) in catalog order with mini-counts.
    const labels = [
      "Data &amp; Privacy",
      "Security",
      "Safety",
      "Reliability",
      "Accountability",
      "Society",
    ];
    let prev = -1;
    for (const label of labels) {
      const i = zone.indexOf(label);
      expect(i, `missing domain heading ${label}`).toBeGreaterThan(prev);
      prev = i;
    }
    // Mini-counts per domain (pass · gap · insufficient · attested).
    expect(zone).toContain("3 pass · 1 gap · 1 insufficient · 0 attested"); // data-privacy
    expect(zone).toContain("5 pass · 0 gap · 0 insufficient · 0 attested"); // accountability
    expect(zone).toContain("0 pass · 0 gap · 4 insufficient · 1 attested"); // society
  });

  it("(d) renders evidence lines; attested rows show the attestation text", () => {
    const zone = certifyZone(htmlWith(FULL_CARD));
    expect(zone).toContain("evidence for DP-01");
    // The attested row carries the attestation text + timestamp instead of
    // its bare evidence line.
    expect(zone).toContain("attested 2026-09-01T12:00:00.000Z");
    expect(zone).toContain("AUP signed by ops — filed in the team wiki");
  });

  it("(e) fail-closed empty state: undefined card → zone-empty hint, no table", () => {
    const html = htmlWith(undefined);
    const zone = certifyZone(html);
    expect(zone).toContain('class="mute small zone-empty"');
    expect(zone).not.toContain('aria-label="Certify detail"');
    expect(zone).not.toContain("<code>DP-01</code>");
    // The hero keeps its own, distinct label.
    expect(html).toContain('aria-label="Certify"');
    expect(html).not.toContain('aria-label="Certify detail"');
  });

  it("(f) escapes requirement titles and attestation text (escaping fixture)", () => {
    const evil = req(
      "DP-01",
      "data-privacy",
      "high",
      "attested",
      '<img src=x onerror=alert(1)> intercepted',
      {
        attestation: { text: 'signed <script>alert(2)</script>', at: "2026-09-02T00:00:00.000Z" },
      },
    );
    const zone = certifyZone(
      htmlWith({ ...FULL_CARD, requirements: [evil] }),
    );
    expect(zone).toContain("&lt;img src=x onerror=alert(1)&gt; intercepted");
    expect(zone).toContain("signed &lt;script&gt;alert(2)&lt;/script&gt;");
    expect(zone).not.toContain("<img");
    expect(zone).not.toContain("<script>");
  });

  it("(g) renders a requirement with empty evidence without a detail line", () => {
    const bare = req("DP-01", "data-privacy", "high", "pass", "Silent requirement", {
      evidence: "",
    });
    const zone = certifyZone(htmlWith({ ...FULL_CARD, requirements: [bare] }));
    expect(zone).toContain(
      '<span class="pill ok">pass</span> <code>DP-01</code> — Silent requirement',
    );
    expect(zone).not.toContain('class="evi"');
    expect(zone).not.toContain('class="att"');
  });
});
