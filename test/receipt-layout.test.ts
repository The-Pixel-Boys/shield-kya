// test/receipt-layout.test.ts
import { describe, expect, it } from "vitest";
import type { CertifyCard } from "../src/receipt/enrich.js";
import { receiptCss } from "../src/receipt/receipt-css.js";
import {
  buildReceiptModel,
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

/**
 * Layout contract for the tabbed dashboard shell (0.8.0): hero KPI grid with
 * a dedicated Certify card ahead of the feed, pure-CSS :target tabs, filter
 * chips living in the Activity zone, and a fully offline standalone page.
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

const EVENTS: TrailEvent[] = [
  ev({ ts: iso(0), sessionId: "s", product: "kimi", host: "ide", project: "dev" }),
  ev({
    ts: iso(60_000),
    sessionId: "s",
    product: "claude",
    host: "runtime",
    mode: "hold",
    verdict: "DENY",
    reasonCode: "NEVER_EVENT",
    neverEvent: true,
    project: "data-pipeline",
  }),
];

describe("receipt dashboard layout (hero grid + tabs)", () => {
  it("places the Certify section BEFORE the activity feed", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(EVENTS, 3, { certify: PASS_CARD }),
    );
    const iCertify = html.indexOf('aria-label="Certify"');
    const iFeed = html.indexOf('id="feed"');
    expect(iCertify).toBeGreaterThan(-1);
    expect(iFeed).toBeGreaterThan(-1);
    expect(iCertify).toBeLessThan(iFeed);
  });

  it("keeps aria-label=\"Certify\" on the hero card", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(EVENTS, 3, { certify: PASS_CARD }),
    );
    expect(html).toContain('aria-label="Certify"');
    // Hero grid wrapper exists and contains the Certify card.
    const iHero = html.indexOf('class="hero"');
    expect(iHero).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="Certify"')).toBeGreaterThan(iHero);
  });

  it("ships tab nav links to #overview / #activity / #system", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, {}));
    expect(html).toContain('href="#overview"');
    expect(html).toContain('href="#activity"');
    expect(html).toContain('href="#system"');
    // Zones with matching ids exist so :target can switch them.
    expect(html).toContain('id="overview"');
    expect(html).toContain('id="activity"');
    expect(html).toContain('id="system"');
  });

  it("pins header and tab nav in one sticky top zone (no stranded nav on fragment jumps)", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, {}));
    const iStick = html.indexOf('class="topstick"');
    expect(iStick).toBeGreaterThan(-1);
    // Both the header and the tab nav live inside the sticky container.
    const iBar = html.indexOf('class="bar"');
    const iTabs = html.indexOf('class="tabs"');
    const iClose = html.indexOf("</div>", iTabs);
    expect(iBar).toBeGreaterThan(iStick);
    expect(iTabs).toBeGreaterThan(iBar);
    expect(iClose).toBeGreaterThan(iTabs);
    const css = receiptCss();
    expect(css).toMatch(/\.topstick \{[^}]*position: sticky/);
    expect(css).toContain("scroll-margin-top: 6.4rem");
    // The header alone must NOT be sticky anymore (the container is).
    expect(css).not.toMatch(/header\.bar \{[^}]*position: sticky/);
  });

  it("labels each zone by its tab anchor (tab ids + aria-labelledby)", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, {}));
    for (const zone of ["overview", "activity", "system"]) {
      expect(html).toContain(`id="tab-${zone}" href="#${zone}"`);
      expect(html).toContain(`id="${zone}" aria-labelledby="tab-${zone}"`);
    }
  });

  it("pins the CSS guards: :has() gate, tab focus ring, prefixed backdrop blur", () => {
    const css = receiptCss();
    // Tab hiding must stay behind the :has() gate or zones go unreachable.
    expect(css).toContain("@supports selector(body:has(*))");
    expect(css).toContain(".tab:focus-visible");
    expect(css).toContain("-webkit-backdrop-filter");
    // Hero grid collapse 4 → 2 → 1 and horizontal tab scroll on narrow.
    expect(css).toMatch(/@media \(max-width: 1100px\)[^}]*\{[^}]*repeat\(2, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 480px\)[^}]*\{[^}]*grid-template-columns: 1fr/);
    expect(css).toContain("overflow-x: auto");
  });

  it("emits the filter script exactly once; the live script once iff model.live", () => {
    const staticHtml = renderReceiptHtml(buildReceiptModel("s", EVENTS, {}));
    expect(staticHtml.match(/id="kya-filters"/g)).toHaveLength(1);
    expect(staticHtml.match(/new EventSource\(/g)).toBeNull();

    const liveHtml = renderReceiptHtml(
      buildReceiptModel("s", EVENTS, { live: true, liveToken: "tok-abc123" }),
    );
    expect(liveHtml.match(/id="kya-filters"/g)).toHaveLength(1);
    expect(liveHtml.match(/new EventSource\(/g)).toHaveLength(1);
  });

  it("empty model renders coherently with a fail-closed (never green) hero", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    // Shell stays intact.
    expect(html).toContain('class="hero"');
    expect(html).toContain('id="feed"');
    expect(html).toContain('href="#overview"');
    // Fail-closed: a neutral Certify state, NEVER a green/pass pill.
    expect(html).toContain('aria-label="Certify"');
    expect(html).toContain('<span class="pill">not evaluated</span>');
    expect(html).not.toContain('class="pill orr-green"');
    expect(html).not.toContain('>pass</span>');
  });

  it("fresh install reads as a guided get-started page, not broken boxes", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    // Each zone gets a hint instead of an empty frame.
    expect(html.match(/class="mute small zone-empty"/g)).toHaveLength(2);
    expect(html).toContain("No activity in this window yet");
    expect(html).toContain("No system state yet");
    // The feed tells the user how to make the first event appear.
    expect(html).toContain('class="empty"');
    expect(html).toContain("No events yet");
    expect(html).toContain("<code>kya wrap</code>");
    // Hero grid still renders its zero-state cards (fail-closed Certify,
    // zeroed verdict mix, flat sparkline) rather than collapsing.
    expect(html).toContain('class="hero"');
    expect(html).toContain('aria-label="Verdicts"');
    expect(html).toContain('aria-label="Activity"');
    // Analytics panel is empty-state omitted, not half-rendered.
    expect(html).not.toContain('id="dashboard"');
  });

  it("keeps filter chips inside the Activity zone, out of the top header", () => {
    const html = renderReceiptHtml(buildReceiptModel("s", EVENTS, {}));
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).not.toContain("data-fgroup");
    expect(header).not.toContain("clear-filters");
    // Chips sit between the Activity zone start and the feed.
    const iActivity = html.indexOf('id="activity"');
    const iClear = html.indexOf('id="clear-filters"');
    const iFeed = html.indexOf('id="feed"');
    expect(iActivity).toBeGreaterThan(-1);
    expect(iClear).toBeGreaterThan(iActivity);
    expect(iFeed).toBeGreaterThan(iClear);
    // Verdict chip row moved along with the clear control. (The Analytics
    // panel's db-item rows share data-fgroup, so match the .stat chip markup.)
    const iVerdictChip = html.indexOf('class="stat ok" data-fgroup="verdict" data-fvalue="ALLOW"');
    expect(iVerdictChip).toBeGreaterThan(iActivity);
    expect(iVerdictChip).toBeLessThan(iFeed);
  });

  it("contains no external http(s) references — fully offline page", () => {
    const empty = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(empty).not.toMatch(/https?:\/\//);
    const live = renderReceiptHtml(
      buildReceiptModel("s", EVENTS, { live: true, liveToken: "tok-abc123" }),
    );
    expect(live).not.toMatch(/https?:\/\//);
  });
});
