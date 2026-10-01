import { describe, expect, it } from "vitest";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
  renderFeedPage,
} from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

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

describe("receipt pagination", () => {
  it("renders at most 50 events on page 1 of a live-token report", () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      ev({ ts: iso(i * 1000), sessionId: `s-${i}` }),
    );
    const html = renderReceiptHtml(
      buildWindowReceiptModel(events, 3, { page: 1, liveToken: "test-token" }),
    );
    expect((html.match(/<article class="ev /g) || []).length).toBe(50);
    expect(html).toContain('id="pagination-bar"');
    expect(html).toContain("Page 1 of 3");
  });

  it("shows a single page indicator at the page-size boundary", () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      ev({ ts: iso(i * 1000), sessionId: `s-${i}` }),
    );
    const html = renderReceiptHtml(
      buildWindowReceiptModel(events, 3, { page: 1, liveToken: "test-token" }),
    );
    expect((html.match(/<article class="ev /g) || []).length).toBe(50);
    expect(html).toContain("Page 1 of 1");
    expect(html).not.toContain('data-page="2"');
  });

  it("renders the last page correctly", () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      ev({ ts: iso(i * 1000), sessionId: `s-${i}` }),
    );
    const html = renderReceiptHtml(
      buildWindowReceiptModel(events, 3, { page: 3, liveToken: "test-token" }),
    );
    expect((html.match(/<article class="ev /g) || []).length).toBe(20);
    expect(html).toContain("Page 3 of 3");
  });

  it("clamps out-of-range pages", () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      ev({ ts: iso(i * 1000), sessionId: `s-${i}` }),
    );
    const html = renderReceiptHtml(
      buildWindowReceiptModel(events, 3, { page: 99, liveToken: "test-token" }),
    );
    expect((html.match(/<article class="ev /g) || []).length).toBe(20);
    expect(html).toContain("Page 3 of 3");
    expect(html).not.toContain("Page 99");
  });

  it("static reports render the full event list without page buttons", () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      ev({ ts: iso(i * 1000), sessionId: `s-${i}` }),
    );
    const html = renderReceiptHtml(buildWindowReceiptModel(events, 3, {}));
    expect((html.match(/<article class="ev /g) || []).length).toBe(120);
    expect(html).toContain('id="pagination-bar"');
    expect(html).toContain("120 events");
    expect(html).not.toContain('data-page="2"');
    expect(html).not.toContain("Page 1 of 3");
  });

  it("filters before paging", () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      ev({
        ts: iso(i * 1000),
        sessionId: `s-${i}`,
        verdict: i % 2 === 0 ? "ALLOW" : "DENY",
        reasonCode: i % 2 === 0 ? "ALLOW" : "HIGH_STAKES_WRITE",
      }),
    );
    const result = renderFeedPage(events, { verdict: ["DENY"] }, 1, NOW, false);
    expect(result.total).toBe(60);
    expect(result.pages).toBe(2);
    expect(result.page).toBe(1);
    expect((result.feedHtml.match(/<article class="ev /g) || []).length).toBe(50);
    expect(result.feedHtml).toContain("DENY");
    expect(result.feedHtml).not.toContain("ALLOW");
    expect(result.paginationHtml).toContain("Page 1 of 2");
  });
});
