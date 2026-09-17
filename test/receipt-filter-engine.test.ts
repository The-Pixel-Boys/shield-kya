import { describe, expect, it } from "vitest";
import { buildReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

/**
 * Engine tests for the report's inline chip-filter <script>: the script is
 * extracted from real renderReceiptHtml() output and evaluated against a
 * minimal hand-rolled DOM (no jsdom dependency). Chips and feed rows are
 * parsed from the rendered markup, so the wiring between data-fgroup/data-*
 * attributes and the engine is covered end to end.
 */

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttrs(tagSrc: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tagSrc.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
    attrs[m[1]!] = m[2] !== undefined ? unescapeAttr(m[2]) : "";
  }
  return attrs;
}

class FakeClassList {
  private set: Set<string>;
  constructor(cls: string | undefined) {
    this.set = new Set((cls ?? "").split(/\s+/).filter(Boolean));
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
  toggle(c: string, on: boolean): void {
    if (on) this.set.add(c);
    else this.set.delete(c);
  }
}

class FakeEl {
  readonly attrs: Record<string, string>;
  readonly dataset: Record<string, string> = {};
  readonly classList: FakeClassList;
  hidden: boolean;
  children: FakeEl[] = [];
  querySelectorAll?: (sel: string) => FakeEl[];
  private listeners: Record<string, (() => void) | undefined> = {};

  constructor(attrs: Record<string, string>) {
    this.attrs = { ...attrs };
    this.classList = new FakeClassList(attrs.class);
    this.hidden = "hidden" in attrs;
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("data-")) this.dataset[k.slice(5)] = v;
    }
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name]! : null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  addEventListener(ev: string, fn: () => void): void {
    this.listeners[ev] = fn;
  }
  click(): void {
    this.listeners.click?.();
  }
}

interface Mount {
  chips: FakeEl[];
  rows: FakeEl[];
  days: FakeEl[];
  clearBtn: FakeEl;
  location: { hash: string; pathname: string; search: string };
}

/** Parse chips/rows/days out of the rendered HTML and evaluate the filter script. */
function mount(html: string, hash = ""): Mount {
  const script = /<script id="kya-filters">([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(script, "filter script tag present").toBeTruthy();

  const chips = [...html.matchAll(/<button [^>]*data-fgroup[^>]*>/g)].map(
    (m) => new FakeEl(parseAttrs(m[0])),
  );
  expect(chips.length).toBeGreaterThan(0);
  const clearTag = /<button [^>]*id="clear-filters"[^>]*>/.exec(html);
  expect(clearTag, "clear-filters control present").toBeTruthy();
  const clearBtn = new FakeEl(parseAttrs(clearTag![0]));

  const feedInner = /<section class="feed" id="feed"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1];
  expect(feedInner, "feed section present").toBeTruthy();
  const feed = new FakeEl({ class: "feed", id: "feed" });
  const rows: FakeEl[] = [];
  const days: FakeEl[] = [];
  for (const m of feedInner!.matchAll(/<div class="day"[^>]*>|<article [^>]*>/g)) {
    const el = new FakeEl(parseAttrs(m[0]));
    feed.children.push(el);
    if (el.classList.contains("day")) days.push(el);
    else rows.push(el);
  }
  feed.querySelectorAll = (sel: string) => (sel === ".ev" ? rows : []);

  const location = { hash, pathname: "/receipt.html", search: "" };
  const history = {
    replaceState: (_a: unknown, _b: unknown, url: string) => {
      const i = url.indexOf("#");
      location.hash = i >= 0 ? url.slice(i) : "";
    },
  };
  const document = {
    getElementById: (id: string) =>
      id === "feed" ? feed : id === "clear-filters" ? clearBtn : null,
    querySelectorAll: (sel: string) => (sel === "[data-fgroup]" ? chips : []),
  };
  new Function("document", "location", "history", script!)(document, location, history);
  return { chips, rows, days, clearBtn, location };
}

function ev(partial: Partial<TrailEvent> & Pick<TrailEvent, "ts" | "sessionId">): TrailEvent {
  return {
    toolId: "org.sample.safe.read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...partial,
  };
}

/** Two day-groups: 2026-09-11 (A, B) and 2026-09-10 (C, D, E). */
const EVENTS: TrailEvent[] = [
  ev({ ts: "2026-09-11T10:00:00.000Z", sessionId: "s", toolId: "A", product: "kimi", verdict: "DENY", reasonCode: "NOPE", project: "alpha" }),
  ev({ ts: "2026-09-11T09:00:00.000Z", sessionId: "s", toolId: "B", product: "claude", project: "beta" }),
  ev({ ts: "2026-09-10T10:00:00.000Z", sessionId: "s", toolId: "C", product: "kimi", project: "constructor" }),
  ev({ ts: "2026-09-10T09:00:00.000Z", sessionId: "s", toolId: "D", product: "grok", project: "toString" }),
  ev({ ts: "2026-09-10T08:00:00.000Z", sessionId: "s", toolId: "E", product: "cursor", verdict: "REQUIRE_APPROVE", reasonCode: "SHELL_EXEC", project: "__proto__" }),
];

const HTML = renderReceiptHtml(buildReceiptModel("s", EVENTS, {}));

const visible = (m: Mount): number => m.rows.filter((r) => !r.classList.contains("filtered-out")).length;
const row = (m: Mount, attr: string, value: string): FakeEl => {
  const r = m.rows.find((r) => r.getAttribute(attr) === value);
  expect(r, `row with ${attr}=${value}`).toBeTruthy();
  return r!;
};
const chip = (m: Mount, group: string, value: string): FakeEl => {
  const c = m.chips.find((c) => c.dataset.fgroup === group && c.dataset.fvalue === value);
  expect(c, `chip ${group}:${value}`).toBeTruthy();
  return c!;
};

describe("receipt filter engine (inline script, shimmed DOM)", () => {
  it("toggles chips, sets aria-pressed, ANDs across groups, ORs within a group", () => {
    const m = mount(HTML);
    expect(visible(m)).toBe(5);
    expect(m.clearBtn.hidden).toBe(true);

    chip(m, "product", "kimi").click();
    expect(visible(m)).toBe(2); // A + C
    expect(chip(m, "product", "kimi").getAttribute("aria-pressed")).toBe("true");
    expect(m.clearBtn.hidden).toBe(false);
    expect(m.location.hash).toBe("#f=product:kimi");

    chip(m, "verdict", "DENY").click();
    expect(visible(m)).toBe(1); // AND across groups: only A
    chip(m, "verdict", "ALLOW").click();
    expect(visible(m)).toBe(2); // OR within verdict: A + C
    chip(m, "product", "kimi").click(); // deselect -> verdict group only
    expect(visible(m)).toBe(4); // everything except E (REQUIRE_APPROVE)
  });

  it("does not let prototype-chain property names bypass an active filter", () => {
    const m = mount(HTML);
    chip(m, "project", "beta").click();
    expect(visible(m)).toBe(1); // only B
    // Regression pin: on plain-{} state maps these rows passed ANY filter via
    // Object.prototype.constructor / .toString.
    expect(row(m, "data-project", "constructor").classList.contains("filtered-out")).toBe(true);
    expect(row(m, "data-project", "toString").classList.contains("filtered-out")).toBe(true);
    // Same through the hash-parse path.
    const fromHash = mount(HTML, "#f=project:beta");
    expect(visible(fromHash)).toBe(1);
    expect(row(fromHash, "data-project", "constructor").classList.contains("filtered-out")).toBe(true);
    // '__proto__' as a value is an ordinary key on null-prototype maps.
    chip(m, "project", "__proto__").click();
    expect(visible(m)).toBe(2); // B + E
    expect(row(m, "data-project", "__proto__").classList.contains("filtered-out")).toBe(false);
  });

  it("hides a day-group header when all its rows are filtered out", () => {
    const m = mount(HTML);
    expect(m.days).toHaveLength(2);
    chip(m, "verdict", "DENY").click(); // only A (first day) survives
    expect(m.days[0]!.classList.contains("filtered-out")).toBe(false);
    expect(m.days[1]!.classList.contains("filtered-out")).toBe(true);
  });

  it("round-trips filter state through location.hash", () => {
    const first = mount(HTML);
    chip(first, "product", "kimi").click();
    chip(first, "verdict", "DENY").click();
    expect(first.location.hash).toBe("#f=product:kimi,verdict:DENY");

    const second = mount(HTML, first.location.hash);
    expect(visible(second)).toBe(1);
    expect(chip(second, "product", "kimi").getAttribute("aria-pressed")).toBe("true");
    expect(chip(second, "verdict", "DENY").getAttribute("aria-pressed")).toBe("true");
    expect(second.clearBtn.hidden).toBe(false);
  });

  it("ignores malformed hash segments and unknown groups", () => {
    const m = mount(HTML, "#f=zzz:x,%E0%A4%A,no-colon,product:,");
    expect(visible(m)).toBe(5); // unknown group 'zzz' must not hide every row
    expect(m.clearBtn.hidden).toBe(true);
    for (const c of m.chips) expect(c.getAttribute("aria-pressed")).toBe("false");
    // Valid segments after malformed ones still apply.
    const partial = mount(HTML, "#f=zzz:x,verdict:DENY");
    expect(visible(partial)).toBe(1);
  });

  it("clear-filters resets rows, chips, and the hash", () => {
    const m = mount(HTML);
    chip(m, "product", "kimi").click();
    chip(m, "verdict", "DENY").click();
    expect(visible(m)).toBe(1);
    m.clearBtn.click();
    expect(visible(m)).toBe(5);
    expect(m.location.hash).toBe("");
    expect(m.clearBtn.hidden).toBe(true);
    for (const c of m.chips) expect(c.getAttribute("aria-pressed")).toBe("false");
    for (const d of m.days) expect(d.classList.contains("filtered-out")).toBe(false);
  });
});
