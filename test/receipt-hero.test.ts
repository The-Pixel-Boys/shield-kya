// test/receipt-hero.test.ts
import { describe, expect, it } from "vitest";
import type { CertifyCard } from "../src/receipt/enrich.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";
import { SHOWBACK_DISCLAIMER, type ShowbackReport } from "../src/showback/cost-per-task.js";
import type { TrailEvent } from "../src/trail.js";

/**
 * Hero card internals (0.8.0 Task 2): the rich Certify hero (large result
 * pill, count tiles, top-5 gap rows with severity chips, accent state class),
 * the static verdict mix bars, the activity sparkline (always 7 rects, no
 * NaN/Infinity), and the conditional showback hero card.
 */

function ev(partial: Partial<TrailEvent> & Pick<TrailEvent, "ts" | "sessionId">): TrailEvent {
  return {
    toolId: "org.sample.safe.read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...partial,
  };
}

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 86_400_000;

const PASS_CARD: CertifyCard = {
  result: "pass",
  pass: 26,
  gap: 0,
  insufficientEvidence: 4,
  attested: 0,
  windowDays: 30,
  trailEvents: 7,
  topGaps: [],
  requirements: [],
};

/** Six gaps (one more than the hero shows), already in the card's severity order. */
const GAP_CARD: CertifyCard = {
  result: "gap",
  pass: 20,
  gap: 6,
  insufficientEvidence: 3,
  attested: 1,
  windowDays: 30,
  trailEvents: 42,
  topGaps: [
    {
      id: "SEC-04",
      title: "Writes require approval",
      severity: "critical",
      evidence: "3 write events with verdict=ALLOW in window",
    },
    {
      id: "SEC-07",
      title: "Deny-by-default for unknown tools",
      severity: "critical",
      evidence: "unknown tool id seen without a matching policy",
    },
    {
      id: "DP-01",
      title: "Payloads stay within the allowlist",
      severity: "high",
      evidence: "payload fields exceed the declared allowlist",
    },
    {
      id: "OBS-02",
      title: "Trail captures every tool call",
      severity: "medium",
      evidence: "2 sessions missing trail events",
    },
    {
      id: "LOG-03",
      title: "Retention window configured",
      severity: "low",
      evidence: "no retention setting in .kya/config.json",
    },
    {
      id: "ZZZ-99",
      title: "overflow row must not render",
      severity: "low",
      evidence: "overflow evidence must not render",
    },
  ],
  requirements: [
    {
      id: "SEC-09",
      domain: "security",
      title: "Incident contact on file",
      severity: "low",
      status: "attested",
      evidence: "operator attested 2026-09-01",
      attestation: {
        text: "Our on-call rota covers agent incidents; reviewed quarterly.",
        at: "2026-09-01T00:00:00.000Z",
      },
    },
  ],
};

/** Two attested requirements — pins the "(+N more)" collapse. */
const ATTESTED_CARD: CertifyCard = {
  result: "gap",
  pass: 24,
  gap: 1,
  insufficientEvidence: 3,
  attested: 2,
  windowDays: 30,
  trailEvents: 9,
  topGaps: [
    {
      id: "SEC-01",
      title: "Gate enforces, not observe-only",
      severity: "high",
      evidence: 'gate mode is observe — set KYA_HOLD=1 / KYA_OFFLINE=1 or "gateMode" in .kya/config.json',
    },
  ],
  requirements: [
    {
      id: "SEC-09",
      domain: "security",
      title: "Incident contact on file",
      severity: "low",
      status: "attested",
      evidence: "operator attested 2026-09-01",
      attestation: {
        text: "Our on-call rota covers agent incidents; reviewed quarterly.",
        at: "2026-09-01T00:00:00.000Z",
      },
    },
    {
      id: "DP-03",
      domain: "data",
      title: "Backups verified",
      severity: "medium",
      status: "attested",
      evidence: "operator attested 2026-09-02",
      attestation: {
        text: "Nightly restores tested in staging.",
        at: "2026-09-02T00:00:00.000Z",
      },
    },
  ],
};

const SHOWBACK: ShowbackReport = {
  billingMeter: false,
  disclaimer: SHOWBACK_DISCLAIMER,
  totalTokensIn: 1000,
  totalTokensOut: 200,
  estimatedUsd: 0.0123,
  perRun: [
    {
      runId: "run-1",
      parentAgentId: "refund-bot",
      tokensIn: 1000,
      tokensOut: 200,
      estimatedUsd: 0.0123,
      steps: 2,
      subagentIds: [],
    },
  ],
  perAgent: [],
};

/** Slice the section element carrying `aria-label="X"` (from its opening tag
 * to the closing tag). */
function section(html: string, ariaLabel: string): string {
  const label = html.indexOf(`aria-label="${ariaLabel}"`);
  expect(label).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<section", label);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", label);
  expect(end).toBeGreaterThan(-1);
  return html.slice(start, end);
}

describe("hero Certify panel", () => {
  it("pass card: green pill, accent class, toned tiles only when > 0", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: PASS_CARD }));
    const hero = section(html, "Certify");
    expect(hero).toContain('hero-certify pass');
    expect(hero).toContain('<span class="pill orr-green">pass</span>');
    expect(hero).toContain("Certify — Agent Trust Baseline");
    // Tiles: pass 26 is toned ok; gap 0 carries no tone class.
    expect(hero).toContain('<span class="kpi-num ok">26</span><span class="kpi-lab">Pass</span>');
    expect(hero).toContain('<span class="kpi-num">0</span><span class="kpi-lab">Gap</span>');
    expect(hero).toContain(
      '<span class="kpi-num mute">4</span><span class="kpi-lab">Insufficient</span>',
    );
    expect(hero).toContain('<span class="kpi-num">0</span><span class="kpi-lab">Attested</span>');
    expect(hero).toContain(
      "live evaluation — window 30d, 7 trail events · the Certify tab has the full live requirement table · kya certify for the gap report + signed bundle",
    );
    // A pass card has no gap rows.
    expect(hero).not.toContain('class="sev ');
  });

  it("gap card with 6 gaps: exactly 5 severity-ordered rows, amber pill", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: GAP_CARD }));
    const hero = section(html, "Certify");
    expect(hero).toContain('hero-certify gap');
    expect(hero).toContain('<span class="pill orr-amber">gap</span>');
    // Exactly 5 rows — the sixth (ZZZ-99) is cut.
    expect(hero.match(/class="sev /g)).toHaveLength(5);
    expect(hero).toContain("SEC-04");
    expect(hero).toContain("LOG-03");
    expect(hero).not.toContain("ZZZ-99");
    // Severity chips keep the card's severity order: critical…high…medium…low.
    const iCritical = hero.indexOf('<span class="sev critical">critical</span>');
    const iHigh = hero.indexOf('<span class="sev high">high</span>');
    const iMedium = hero.indexOf('<span class="sev medium">medium</span>');
    const iLow = hero.indexOf('<span class="sev low">low</span>');
    expect(iCritical).toBeGreaterThan(-1);
    expect(iHigh).toBeGreaterThan(iCritical);
    expect(iMedium).toBeGreaterThan(iHigh);
    expect(iLow).toBeGreaterThan(iMedium);
    // Tiles: gap 6 is toned warn; attested 1 stays muted (signed statement,
    // unverified — the neutral tone matches the legend and the Certify tab).
    expect(hero).toContain('<span class="kpi-num warn">6</span><span class="kpi-lab">Gap</span>');
    expect(hero).toContain('<span class="kpi-num mute">1</span><span class="kpi-lab">Attested</span>');
    expect(hero).toContain("window 30d, 42 trail events");
  });

  it("legend defines gap / insufficient / attested in one muted line", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: GAP_CARD }));
    const hero = section(html, "Certify");
    expect(hero).toContain("gap = requirement failing — your work plan");
    expect(hero).toContain(
      "insufficient = not enough local evidence to evaluate (never counts as pass)",
    );
    expect(hero).toContain("attested = your signed statement, unverified");
    // One legend row, straight under the count tiles, before the gap rows.
    expect(hero.match(/class="legend/g)).toHaveLength(1);
    const iTiles = hero.indexOf('class="kpi-row"');
    const iLegend = hero.indexOf("gap = requirement failing");
    const iFirstRow = hero.indexOf('<ul class="rows">');
    expect(iLegend).toBeGreaterThan(iTiles);
    expect(iLegend).toBeLessThan(iFirstRow);
  });

  it("every shown top-gap row carries its catalog title next to the id", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: GAP_CARD }));
    const hero = section(html, "Certify");
    for (const g of GAP_CARD.topGaps.slice(0, 5)) {
      expect(hero).toContain(`<code>${g.id}</code> — ${g.title}`);
    }
    // The cut sixth row leaks neither title nor evidence.
    expect(hero).not.toContain("overflow row must not render");
    expect(hero).not.toContain("overflow evidence must not render");
  });

  it("renders the evidence one-liner under the gap row, muted", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: GAP_CARD }));
    const hero = section(html, "Certify");
    expect(hero).toContain(
      '<span class="gap-ev">3 write events with verdict=ALLOW in window</span>',
    );
    expect(hero).toContain(
      '<span class="gap-ev">no retention setting in .kya/config.json</span>',
    );
  });

  it("attested card: first attested id + attestation text under the legend", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: GAP_CARD }));
    const hero = section(html, "Certify");
    // attested: 1 → no collapse suffix.
    expect(hero).toContain("attested: <code>SEC-09</code>");
    expect(hero).toContain('"Our on-call rota covers agent incidents; reviewed quarterly."');
    expect(hero).not.toContain("more)");
  });

  it("two attested requirements collapse to first id (+1 more)", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: ATTESTED_CARD }));
    const hero = section(html, "Certify");
    expect(hero).toContain("attested: <code>SEC-09</code> (+1 more)");
    expect(hero).toContain('"Our on-call rota covers agent incidents; reviewed quarterly."');
    // The second attestation is summarized by the count, not rendered.
    expect(hero).not.toContain("Nightly restores tested in staging.");
  });

  it("no attested line when attested count is zero", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: PASS_CARD }));
    const hero = section(html, "Certify");
    expect(hero).not.toContain("attested: <code>");
  });

  it("escapes hostile titles and evidence in gap rows", () => {
    const evil: CertifyCard = {
      ...GAP_CARD,
      attested: 0,
      requirements: [],
      topGaps: [
        {
          id: "SEC-01",
          title: '<script>alert("x")</script>',
          severity: "high",
          evidence: 'evidence <img src=x onerror=alert(1)> "quoted"',
        },
      ],
    };
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: evil }));
    const hero = section(html, "Certify");
    expect(hero).not.toContain("<script>alert");
    expect(hero).not.toContain("<img src=x");
    expect(hero).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(hero).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("clips an overlong evidence one-liner to ~140 chars", () => {
    const longEvidence = `gate mode is observe — ${"x".repeat(300)}`;
    const longCard: CertifyCard = {
      ...GAP_CARD,
      attested: 0,
      requirements: [],
      topGaps: [{ id: "SEC-01", title: "Gate enforces", severity: "high", evidence: longEvidence }],
    };
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { certify: longCard }));
    const hero = section(html, "Certify");
    expect(hero).not.toContain(longEvidence);
    expect(hero).toContain(`gate mode is observe — ${"x".repeat(110)}`);
  });

  it("absent card: neutral fail-closed state — never green", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    const hero = section(html, "Certify");
    expect(hero).toContain('hero-certify none');
    expect(hero).toContain('<span class="pill">not evaluated</span>');
    expect(hero).not.toContain("orr-green");
    expect(hero).not.toContain("orr-amber");
    expect(hero).not.toContain('class="sev ');
  });
});

describe("verdicts hero card — static mix bars", () => {
  // 2 allow + 1 deny + 1 review: total 4 → 50% / 25% / 25%.
  const EVENTS: TrailEvent[] = [
    ev({ ts: iso(0), sessionId: "s" }),
    ev({ ts: iso(1_000), sessionId: "s" }),
    ev({ ts: iso(2_000), sessionId: "s", verdict: "DENY", reasonCode: "HIGH_STAKES_WRITE" }),
    ev({ ts: iso(3_000), sessionId: "s", verdict: "REQUIRE_APPROVE", reasonCode: "APPROVAL" }),
  ];

  it("renders proportional widths and counts, never as filter buttons", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3));
    const hero = section(html, "Verdicts");
    expect(hero).toContain('<span class="mix-fill ok" style="width:50%"></span>');
    expect(hero).toContain('<span class="mix-fill bad" style="width:25%"></span>');
    expect(hero).toContain('<span class="mix-fill warn" style="width:25%"></span>');
    expect(hero).toContain('<span class="mix-num">2</span>');
    expect(hero).toContain('<span class="mix-num">1</span>');
    // Static markup only — filter chips live in the Activity tab.
    expect(hero).not.toContain("data-fgroup");
    expect(hero).not.toContain("<button");
  });

  it("never overlay shares the same total base", () => {
    const events: TrailEvent[] = [
      ...EVENTS.slice(0, 3),
      ev({
        ts: iso(4_000),
        sessionId: "s",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
    ];
    const html = renderReceiptHtml(buildWindowReceiptModel(events, 3));
    const hero = section(html, "Verdicts");
    // 4 verdict events, one of them a never-event → Never bar 25%.
    expect(hero).toContain('<span class="mix-fill bad" style="width:25%"></span>');
    const iNever = hero.indexOf(">Never</span>");
    expect(iNever).toBeGreaterThan(-1);
  });

  it("never-event with a non-standard verdict stays inside the total-events base", () => {
    // verdict is a free-form string from untrusted JSONL: a never-event with
    // a bogus verdict counts in `never` but in no verdict bucket. Base must
    // be events.length (the dashboard.ts "base 100% = total events" contract),
    // or the Never bar can exceed the base the Overview card uses.
    const events: TrailEvent[] = [
      ev({ ts: iso(0), sessionId: "s" }),
      ev({ ts: iso(1_000), sessionId: "s", verdict: "DENY", reasonCode: "HIGH_STAKES_WRITE" }),
      ev({
        ts: iso(2_000),
        sessionId: "s",
        verdict: "MAYBE",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
    ];
    const html = renderReceiptHtml(buildWindowReceiptModel(events, 3));
    const hero = section(html, "Verdicts");
    // 1/3 each for Allow, Deny, Never on the total-events base of 3.
    expect(hero).toContain('<span class="mix-fill ok" style="width:33%"></span>');
    expect(hero.match(/<span class="mix-fill bad" style="width:33%"><\/span>/g)).toHaveLength(2);
    expect(hero).toContain('<span class="mix-num">1</span>');
    // No bar may exceed 100%.
    for (const m of hero.matchAll(/style="width:(\d+)%"/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(100);
    }
  });

  it("empty window: zero widths, no NaN", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    const hero = section(html, "Verdicts");
    expect(hero).toContain('style="width:0%"');
    expect(hero).not.toContain("NaN");
  });
});

describe("activity hero card — 7-bucket sparkline", () => {
  it("emits exactly 7 rects with the max bucket at full height", () => {
    // Three daily buckets: 2 events, gap day, 4 events.
    const events: TrailEvent[] = [
      ev({ ts: iso(2 * DAY), sessionId: "s" }),
      ev({ ts: iso(2 * DAY + 60_000), sessionId: "s" }),
      ev({ ts: iso(0), sessionId: "s" }),
      ev({ ts: iso(60_000), sessionId: "s" }),
      ev({ ts: iso(120_000), sessionId: "s" }),
      ev({ ts: iso(180_000), sessionId: "s" }),
    ];
    const html = renderReceiptHtml(buildWindowReceiptModel(events, 3));
    const hero = section(html, "Activity");
    expect(hero).toContain('<span class="kpi-num">6</span><span class="kpi-lab">Events</span>');
    const rects = hero.match(/<rect /g);
    expect(rects).toHaveLength(7);
    // Max bucket (4 events) normalizes to 100% height (24) at y=0;
    // the 2-event bucket is half height.
    expect(hero).toContain('y="0" width="8" height="24"');
    expect(hero).toContain('y="12" width="8" height="12"');
    expect(hero).not.toContain("NaN");
    expect(hero).not.toContain("Infinity");
  });

  it("empty events: still 7 rects on a flat baseline, no NaN/Infinity", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    const hero = section(html, "Activity");
    expect(hero.match(/<rect /g)).toHaveLength(7);
    expect(hero).toContain('height="0"');
    expect(hero).not.toContain("NaN");
    expect(hero).not.toContain("Infinity");
  });
});

describe("showback hero card", () => {
  it("renders inside the hero grid when model.showback is present", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { showback: SHOWBACK }));
    const iHero = html.indexOf('class="hero"');
    const iOverview = html.indexOf('id="overview"');
    const iShowback = html.indexOf('aria-label="Showback"');
    expect(iHero).toBeGreaterThan(-1);
    expect(iShowback).toBeGreaterThan(iHero);
    expect(iShowback).toBeLessThan(iOverview);
    const hero = section(html, "Showback");
    expect(hero).toContain('<span class="kpi-num">1000</span><span class="kpi-lab">Tokens in</span>');
    expect(hero).toContain('<span class="kpi-num">200</span><span class="kpi-lab">Tokens out</span>');
    expect(hero).toContain("~$0.01");
    expect(hero).toContain(SHOWBACK_DISCLAIMER);
  });

  it("is omitted entirely when model.showback is absent", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(html).not.toContain('aria-label="Showback"');
  });
});

describe("hero output safety", () => {
  it("contains no external http(s) references across the rich hero", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(
        [ev({ ts: iso(0), sessionId: "s" })],
        3,
        { certify: GAP_CARD, showback: SHOWBACK },
      ),
    );
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("assertNoSecrets stays final: adversarial near-miss identity strings render", () => {
    // Near-miss shapes that must NOT trip the secret scanner (missing the
    // payload or far too short), plus HTML-breaking characters that must be
    // escaped.
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, {
        identity: {
          agentName: 'bot "sk_live" <script>alert(1)</script>',
          agentId: "AKIA123", // AKIA prefix but far too short
          host: "ide",
          baseUrl: "api-key=abc", // keyword assignment with a sub-16-char value
        },
        certify: PASS_CARD,
      }),
    );
    expect(html).toContain('aria-label="Certify"');
    // Identity is inert escaped text: no raw script tag, no live quote break.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<a [^>]*href="(?!#)/);
  });
});
