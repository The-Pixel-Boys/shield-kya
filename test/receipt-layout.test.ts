// test/receipt-layout.test.ts
import { describe, expect, it } from "vitest";
import type { CertifyCard } from "../src/receipt/enrich.js";
import { receiptCss } from "../src/receipt/receipt-css.js";
import {
  buildReceiptModel,
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";
import { minimalGatePage } from "./fixtures/gate-page.js";
import type { TrailEvent } from "../src/trail.js";

/**
 * Layout contract for the sidebar dashboard shell: hero KPI grid with a
 * dedicated Certify card ahead of the feed, pure-CSS :target sidebar nav,
 * filter chips living in the Activity zone, and a fully offline standalone page.
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
  requirements: [],
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

describe("receipt dashboard layout (hero grid + sidebar)", () => {
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

  it("ships sidebar nav links to main zones plus Gateway sub-pages", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, {}));
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="sidebar-nav"');
    for (const zone of ["overview", "activity", "changes", "certify", "system"]) {
      expect(html).toContain(`href="#${zone}"`);
      expect(html).toContain(`id="${zone}"`);
    }
    for (const zone of ["gateway-home", "gateway-listeners", "gateway-routes", "gateway-backends", "gateway-policies", "gateway-playground"]) {
      expect(html).toContain(`href="#${zone}"`);
    }
    expect(html).toContain('id="gateway-home"');
  });

  it("renders a fixed sidebar and keeps the page header inside main", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, {}));
    // No sticky top bar anymore.
    expect(html).not.toContain('class="topstick"');
    expect(html).not.toContain('class="tabs"');
    // Sidebar is outside <main>; page header is inside <main>.
    const iSidebar = html.indexOf('<aside class="sidebar">');
    const iMain = html.indexOf('<main>');
    const iPageHeader = html.indexOf('class="page-header"');
    const iMainClose = html.indexOf('</main>');
    expect(iSidebar).toBeGreaterThan(-1);
    expect(iMain).toBeGreaterThan(iSidebar);
    expect(iPageHeader).toBeGreaterThan(iMain);
    expect(iPageHeader).toBeLessThan(iMainClose);
    const css = receiptCss();
    expect(css).toMatch(/\.sidebar \{[^}]*position: fixed/);
    expect(css).toMatch(/main \{[^}]*margin-left:/);
  });

  it("labels each zone by its tab anchor (tab ids + aria-labelledby)", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, {}));
    for (const zone of ["overview", "activity", "changes", "certify", "system"]) {
      expect(html).toContain(`id="tab-${zone}" href="#${zone}"`);
      expect(html).toContain(`id="${zone}" aria-labelledby="tab-${zone}"`);
    }
    // Gateway home always renders (setup hint); sub-pages only render when gate data exists.
    expect(html).toContain('id="tab-gateway-home" href="#gateway-home"');
    expect(html).toContain('id="gateway-home" aria-labelledby="tab-gateway-home"');
  });

  it("pins the CSS guards: :has() gate, nav-link focus ring, and responsive breakpoint", () => {
    const css = receiptCss();
    // Zone hiding must stay behind the :has() gate or zones go unreachable.
    expect(css).toContain("@supports selector(body:has(*))");
    expect(css).toContain(".nav-link:focus-visible");
    expect(css).toContain("body:has(#overview:target) .nav-link[href=\"#overview\"]");
    // Sidebar collapse breakpoint and hero-tiles grid collapse 4 → 2 → 1.
    expect(css).toMatch(/@media \(max-width: 900px\)[^}]*\{[^}]*\.sidebar/);
    expect(css).toContain(".hero-tiles {");
    expect(css).toMatch(/\.hero-tiles \{[^}]*grid-template-columns: repeat\(4, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[^}]*\{[^}]*\.hero-tiles[^}]*grid-template-columns: repeat\(2, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 480px\)[^}]*\{[^}]*\.hero-tiles[^}]*grid-template-columns: 1fr/);
  });

  it("emits the filter script only when liveToken is set; the SSE script once iff model.live", () => {
    const staticHtml = renderReceiptHtml(buildReceiptModel("s", EVENTS, {}));
    expect(staticHtml).not.toContain('id="kya-filters"');
    expect(staticHtml.match(/new EventSource\(/g)).toBeNull();

    const liveHtml = renderReceiptHtml(
      buildReceiptModel("s", EVENTS, { live: true, liveToken: "tok-abc123" }),
    );
    expect(liveHtml.match(/id="kya-filters"/g)).toHaveLength(1);
    expect(liveHtml.match(/new EventSource\(/g)).toHaveLength(1);
  });

  it("renders the hero inside #overview only", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, { certify: PASS_CARD }));
    const iOverview = html.indexOf('<section class="zone" id="overview"');
    const iActivity = html.indexOf('id="activity"');
    const iHero = html.indexOf('class="hero"');
    expect(iOverview).toBeGreaterThan(-1);
    expect(iHero).toBeGreaterThan(iOverview);
    expect(iHero).toBeLessThan(iActivity);
  });

  it("renders the Gateway hero tile inside the hero tiles when gate is provided", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(EVENTS, 3, { gate: minimalGatePage("not-set-up") }),
    );
    const iHero = html.indexOf('class="hero"');
    const iTiles = html.indexOf('class="hero-tiles"');
    const iGatewayHero = html.indexOf('aria-label="Gateway"');
    const iFeed = html.indexOf('id="feed"');
    expect(iHero).toBeGreaterThan(-1);
    expect(iTiles).toBeGreaterThan(iHero);
    expect(iGatewayHero).toBeGreaterThan(iTiles);
    expect(iGatewayHero).toBeLessThan(iFeed);
  });

  it("renders the theme toggle and stop-report link in the sidebar footer", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, {}));
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('id="stop-report"');
    const iFooter = html.indexOf('class="sidebar-footer"');
    const iToggle = html.indexOf('id="theme-toggle"');
    const iStop = html.indexOf('id="stop-report"');
    expect(iToggle).toBeGreaterThan(iFooter);
    expect(iStop).toBeGreaterThan(iFooter);
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
    // Each zone gets a hint instead of an empty frame (incl. the Certify tab).
    expect(html.match(/class="mute small zone-empty"/g)).toHaveLength(4);
    expect(html).toContain("No activity in this window yet");
    expect(html).toContain("No live evaluation yet");
    expect(html).toContain("No system state yet");
    expect(html).toContain("Gateway details will appear here after setup.");
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

  it("keeps filter chips inside the Activity zone, out of the page header", () => {
    const html = renderReceiptHtml(buildReceiptModel("s", EVENTS, {}));
    const header = html.slice(html.indexOf('class="page-header"'), html.indexOf('</header>', html.indexOf('class="page-header"')));
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

  it("zones follow the sidebar order with Gateway pages between Certify and System", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel(EVENTS, 3, {}));
    const positions = [
      html.indexOf('<section class="zone" id="overview"'),
      html.indexOf('<section class="zone" id="activity"'),
      html.indexOf('<section class="zone" id="changes"'),
      html.indexOf('<section class="zone" id="certify"'),
      html.indexOf('<section class="zone" id="gateway-home"'),
      html.indexOf('<section class="zone" id="system"'),
    ];
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("contains no external http(s) references except the live star link — fully offline page", () => {
    const empty = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(empty).not.toMatch(/https?:\/\//);
    const live = renderReceiptHtml(
      buildReceiptModel("s", EVENTS, { live: true, liveToken: "tok-abc123" }),
    );
    // The live report carries exactly one intentional external reference:
    // the sidebar "Star on GitHub" CTA. Everything else stays loopback/offline.
    const withoutStar = live.replaceAll(
      "https://github.com/The-Pixel-Boys/shield-agent",
      "",
    );
    expect(withoutStar).not.toMatch(/https?:\/\//);
  });
});
