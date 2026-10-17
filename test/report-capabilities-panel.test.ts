/**
 * Capabilities panel: the always-on index of everything the install supports.
 * Contract under test (docs/report-design.md): the panel renders on a fresh
 * install with every row in the "available" state, turns rows green only when
 * the matching model data exists, and never depends on probe IO of its own.
 */
import { describe, expect, it } from "vitest";
import { buildWindowReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";
import { emptyOpenshellCard } from "../src/receipt/openshell-card.js";
import type { TrailEvent } from "../src/trail.js";

const osEv = (over: Partial<TrailEvent> = {}): TrailEvent => ({
  ts: "2026-10-15T12:00:00.000Z",
  sessionId: "import-openshell-2026-10-15",
  host: "import",
  toolId: "openshell.network",
  verdict: "DENY",
  reasonCode: "OPENSHELL_POLICY",
  mode: "observe",
  importFormat: "openshell",
  importedFrom: "openshell",
  summary: "dst: api.example.com:443",
  ...over,
});

describe("Capabilities panel", () => {
  it("always renders, lists every capability, and shows all rows available on a fresh install", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(html).toContain('aria-label="Capabilities"');
    expect(html).toContain("MCP gateway");
    expect(html).toContain("OpenShell sandboxing");
    expect(html).toContain("Sandboxes");
    expect(html).toContain("Trace imports");
    expect(html).toContain("Endpoint discovery");
    expect(html).toContain("Investigation");
    expect(html).toContain("Alerts");
    expect(html).toContain("OTel export");
    expect(html).toContain("Certify baseline");
    expect(html).toContain("ORR board");
    // Fresh install: everything is available, nothing is live.
    expect(html).not.toContain('<span class="pill ok">running</span>');
    expect(html).not.toContain('<span class="pill ok">in use</span>');
    expect(html).not.toContain('<span class="pill ok">evaluated</span>');
  });

  it("names the activation command for an unused capability", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(html).toContain("<code>kya gate init</code>");
    expect(html).toContain("<code>kya import --from openshell FILE</code>");
    expect(html).toContain("<code>KYA_SANDBOX=mock kya sandbox spawn</code>");
    expect(html).toContain("<code>kya discover</code>");
    expect(html).toContain("<code>kya investigate</code>");
    expect(html).toContain("<code>kya certify</code>");
    expect(html).toContain("<code>kya orr run</code>");
  });

  it("turns rows green when the matching model data exists", () => {
    const openshell = emptyOpenshellCard();
    const withActivity = {
      ...openshell,
      activity: {
        total: 2,
        deny: 1,
        allow: 1,
        network: 2,
        http: 0,
        topDestinations: [],
        lastTs: "2026-10-15T12:00:00.000Z",
      },
    };
    const html = renderReceiptHtml(
      buildWindowReceiptModel([osEv(), osEv({ verdict: "ALLOW" })], 3, {
        openshell: withActivity,
        imports: {
          total: 5,
          errors: 0,
          formats: [{ format: "openshell", imported: 5, errors: 0 }],
          lastTs: "2026-10-15T12:00:00.000Z",
        },
      }),
    );
    expect(html).toContain('<span class="pill ok">in use</span>');
    expect(html).toContain('<span class="pill ok">5 imported</span>');
  });

  it("keeps unrelated rows available when only one capability has data", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, {
        openshell: {
          ...emptyOpenshellCard(),
          activity: {
            total: 1,
            deny: 1,
            allow: 0,
            network: 1,
            http: 0,
            topDestinations: [],
            lastTs: "2026-10-15T12:00:00.000Z",
          },
        },
      }),
    );
    expect(html).toContain('<span class="pill ok">in use</span>');
    // Gateway row is still untouched.
    expect(html).not.toContain('<span class="pill ok">running</span>');
    expect(html).toContain("<code>kya gate init</code>");
  });

  it("escapes model-derived labels", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, {
        imports: {
          total: 1,
          errors: 0,
          formats: [{ format: "x", imported: 1, errors: 0 }],
          lastTs: "",
        },
        discovery: {
          total: 3,
          sanctioned: 1,
          review: 2,
          topCategories: [],
          capturedAt: "2026-10-15T12:00:00.000Z",
          os: "<img src=x onerror=alert(1)>",
        },
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("3 found");
  });
});
