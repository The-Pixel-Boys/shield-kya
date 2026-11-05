// The IoC check card and the Developer setup card live in the System zone and show once.
// Only the IoC findings banner sits above the zones, so it repeats on every page.
import { describe, expect, it } from "vitest";
import type { IocResult } from "../src/ioc/result.js";
import type { PostureCard } from "../src/posture/card.js";
import { buildWindowReceiptModel, renderReceiptHtml, type ReceiptModel } from "../src/receipt/render-receipt.js";
import { count, reportZones } from "./support/report-zones.js";

const CLEAN: IocResult = { schema: 1, checkedAt: "2026-11-04T10:00:00Z", listVersion: "2026.11.1", skipped: 0, findings: [] };
const DIRTY: IocResult = {
  ...CLEAN,
  findings: [{ ioc: "ioc-2026-test", check: "extension", severity: "critical", evidence: "~/.cursor/extensions/bad-1.0", hint: "Remove it." }],
};
const CARD: PostureCard = {
  share: false,
  hosted: false,
  hosts: ["claude-code"],
  extensions: [],
  mcpServers: [],
  iocLine: "0 finding(s), list 2026.11.1, checked 2026-11-04T10:00:00Z",
  neverMode: "advisory",
  violations: [],
  policy: "not checked yet",
  lastSentAt: undefined,
};

const render = (ioc: IocResult, live: boolean, posture: PostureCard = CARD): string => {
  const model: ReceiptModel = buildWindowReceiptModel([], 3, { ioc, posture });
  return renderReceiptHtml(live ? { ...model, liveToken: "tok" } : model);
};

describe("report cards: placement", () => {
  for (const live of [false, true]) {
    const mode = live ? "live" : "static";

    it(`${mode}: the Developer setup card is in #system and shows once`, () => {
      const html = render(CLEAN, live);
      const { top, zones } = reportZones(html);
      expect(count(html, 'aria-label="Developer setup"')).toBe(1);
      expect(zones["system"]).toContain('aria-label="Developer setup"');
      expect(top).not.toContain("Developer setup");
    });

    it(`${mode}: a clean IoC card is in #system, shows once, and there is no banner`, () => {
      const html = render(CLEAN, live);
      const { top, zones } = reportZones(html);
      expect(count(html, 'aria-label="IoC check"')).toBe(1);
      expect(zones["system"]).toContain('aria-label="IoC check"');
      expect(top).not.toContain("IoC");
      expect(html).not.toContain('aria-label="IoC findings"');
    });

    it(`${mode}: IoC findings show a short banner at the top and the detail in #system`, () => {
      const html = render(DIRTY, live);
      const { top, zones } = reportZones(html);
      expect(count(html, 'aria-label="IoC findings"')).toBe(1);
      expect(top).toContain('aria-label="IoC findings"');
      expect(top).toContain('href="#system"');
      expect(top).not.toContain("bad-1.0");
      expect(zones["system"]).toContain('aria-label="IoC check details"');
      expect(count(html, "~/.cursor/extensions/bad-1.0")).toBe(1);
      expect(zones["system"]).toContain("~/.cursor/extensions/bad-1.0");
    });

    it(`${mode}: the cards are the first items of the System zone`, () => {
      const sys = reportZones(render(CLEAN, live)).zones["system"]!;
      // The first child element after the zone tag is the IoC card; the Developer setup card is next.
      const inner = sys.slice(sys.indexOf(">") + 1).trimStart();
      expect(inner.startsWith('<section class="card" aria-label="IoC check">')).toBe(true);
      const afterIoc = inner.slice(inner.indexOf("</section>") + "</section>".length).trimStart();
      expect(afterIoc.startsWith('<section class="card" aria-label="Developer setup">')).toBe(true);
    });
  }

  it("static and live put the cards in the same places", () => {
    for (const ioc of [CLEAN, DIRTY]) {
      const a = reportZones(render(ioc, false));
      const b = reportZones(render(ioc, true));
      for (const label of ['aria-label="IoC findings"', 'aria-label="IoC check"', 'aria-label="IoC check details"', 'aria-label="Developer setup"']) {
        expect(count(a.top, label)).toBe(count(b.top, label));
        expect(count(a.zones["system"]!, label)).toBe(count(b.zones["system"]!, label));
      }
    }
  });

  it("live: the toggle button and its result box are in #system; static: the command text", () => {
    const liveSys = reportZones(render(CLEAN, true)).zones["system"]!;
    expect(liveSys).toContain('data-report-action="posture" data-posture-share="on"');
    expect(liveSys).toContain('id="report-action-result-posture"');
    const staticSys = reportZones(render(CLEAN, false)).zones["system"]!;
    expect(staticSys).not.toContain('data-report-action="posture"');
    expect(staticSys).toContain("<code>kya posture on</code>");
  });
});

describe("report cards: Developer setup wording", () => {
  it("says a send adds a device id and a label, and when something is sent", () => {
    const html = render(CLEAN, true);
    expect(html).not.toContain("No device id, no label");
    expect(html).toContain("A send also adds a random device id and a label.");
    expect(html).toContain("<code>kya posture label NAME</code>");
    expect(html).toContain("A send contains no paths, no environment values and no user name");
    expect(html).toContain("Nothing is sent unless you have a hosted login and your workspace admin turned it on.");
    expect(html).toContain("Turning this on only changes a setting on this machine.");
    expect(html).toContain("Hosted login: no, so nothing is sent from this machine.");
  });

  it("with a hosted login, does not say that nothing is sent from this machine", () => {
    const html = render(CLEAN, true, { ...CARD, hosted: true });
    expect(html).toContain("Hosted login: yes");
    expect(html).not.toContain("nothing is sent from this machine");
  });
});
