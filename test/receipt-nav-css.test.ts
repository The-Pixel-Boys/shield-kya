// test/receipt-nav-css.test.ts
import { describe, expect, it } from "vitest";
import type { CertifyCard, OrrCard } from "../src/receipt/enrich.js";
import { receiptCss } from "../src/receipt/receipt-css.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

/**
 * Sidebar nav contract: zone switching is pure CSS (:target + :has), so every
 * nav link must have matching hide, :target, overview-override, and highlight
 * rules in receiptCss(), and every rendered zone must be reachable from the
 * nav. This is the e2e guard for "clicking a menu item does nothing" bugs:
 * a nav item rendered without CSS wiring clicks to a no-op.
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

const EVENTS: TrailEvent[] = [
  ev({ ts: iso(0), sessionId: "s", product: "kimi", host: "ide", project: "dev" }),
];

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

const ORR_CARD: OrrCard = {
  overall: "red",
  disposition: "no_go",
  primaryFailureMode: "test failure",
  mostUrgentFix: "fix it",
  generatedAt: iso(60_000),
  targetName: "dev",
  scorecards: { pass: 3, fail: 1, partial: 2, notEvaluated: 0 },
};

function renderFull(): string {
  return renderReceiptHtml(
    buildWindowReceiptModel(EVENTS, 3, { certify: PASS_CARD, orr: ORR_CARD }),
  );
}

function navIds(html: string): string[] {
  const nav = html.match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
  return [...nav.matchAll(/href="#([a-z0-9-]+)"/g)].map((m) => m[1]);
}

function zoneIds(html: string): string[] {
  return [...html.matchAll(/<section class="zone[^"]*" id="([a-z0-9-]+)"/g)].map(
    (m) => m[1],
  );
}

describe("sidebar nav CSS wiring (e2e click contract)", () => {
  const css = receiptCss();

  it("every nav link is wired into the CSS :target switch", () => {
    const ids = navIds(renderFull());
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      expect(css, `#${id} needs a :target display rule`).toContain(`#${id}:target`);
      expect(
        css,
        `#${id} needs a nav highlight rule for body:has(#${id}:target)`,
      ).toContain(`body:has(#${id}:target) .nav-link[href="#${id}"]`);
      if (id === "overview") continue;
      // Hidden by default and shown on :target; otherwise it stacks under
      // Overview and the click appears to do nothing.
      const hideRules = [
        ...css.matchAll(/([^{}]+)\{[^{}]*display:\s*none[^{}]*\}/g),
      ].map((m) => m[1]);
      expect(
        hideRules.some((sel) => sel.includes(`#${id}`)),
        `#${id} must be display:none until targeted`,
      ).toBe(true);
      expect(
        css,
        `#${id} targeted must hide the default Overview zone`,
      ).toContain(`body:has(#${id}:target) #overview`);
    }
  });

  it("every rendered zone is reachable from the sidebar nav", () => {
    const html = renderFull();
    const nav = new Set(navIds(html));
    for (const id of zoneIds(html)) {
      expect(nav.has(id), `zone #${id} has no sidebar nav link`).toBe(true);
    }
  });

  it("Overview keeps its no-target highlight fallback", () => {
    expect(css).toContain(
      'body:not(:has(.zone:target)) .nav-link[href="#overview"]',
    );
  });
});
