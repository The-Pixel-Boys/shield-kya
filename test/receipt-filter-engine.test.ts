import { describe, expect, it } from "vitest";
import { buildReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

/**
 * Engine tests for the report's inline chip-filter <script>: the script is
 * extracted from real renderReceiptHtml() output and evaluated against a
 * minimal hand-rolled DOM (no jsdom dependency). Chips and feed rows are
 * parsed from the rendered markup, so the wiring between data-fgroup/data-*
 * attributes and the engine is covered end to end. Filter state persists in
 * the ?f= query param (the hash belongs to the :target tabs); legacy #f=
 * hashes are still parsed read-only.
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
function mount(html: string, url: { search?: string; hash?: string } = {}): Mount {
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

  const location = { hash: url.hash ?? "", pathname: "/receipt.html", search: url.search ?? "" };
  const history = {
    replaceState: (_a: unknown, _b: unknown, next: string) => {
      const i = next.indexOf("#");
      const pre = i >= 0 ? next.slice(0, i) : next;
      location.hash = i >= 0 ? next.slice(i) : "";
      const q = pre.indexOf("?");
      location.search = q >= 0 ? pre.slice(q) : "";
      location.pathname = q >= 0 ? pre.slice(0, q) : pre;
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
const fullUrl = (m: Mount): string =>
  `${m.location.pathname}${m.location.search}${m.location.hash}`;
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
    expect(m.location.search).toBe("?f=product:kimi");
    expect(m.location.hash).toBe("");

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
    // Same through the legacy hash-parse path.
    const fromHash = mount(HTML, { hash: "#f=project:beta" });
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

  it("round-trips filter state through the ?f= query param", () => {
    const first = mount(HTML);
    chip(first, "product", "kimi").click();
    chip(first, "verdict", "DENY").click();
    expect(first.location.search).toBe("?f=product:kimi,verdict:DENY");

    const second = mount(HTML, { search: first.location.search });
    expect(visible(second)).toBe(1);
    expect(chip(second, "product", "kimi").getAttribute("aria-pressed")).toBe("true");
    expect(chip(second, "verdict", "DENY").getAttribute("aria-pressed")).toBe("true");
    expect(second.clearBtn.hidden).toBe(false);
  });

  it("keeps the tab hash across a chip toggle (?f= and #activity coexist)", () => {
    const m = mount(HTML, { hash: "#activity" });
    chip(m, "verdict", "DENY").click();
    expect(visible(m)).toBe(1);
    expect(m.location.search).toBe("?f=verdict:DENY");
    expect(m.location.hash).toBe("#activity");
    expect(fullUrl(m)).toContain("?f=");
    expect(fullUrl(m)).toContain("#activity");
  });

  it("applies filters from ?f= while a tab hash is present (?f=verdict:DENY#activity)", () => {
    const m = mount(HTML, { search: "?f=verdict:DENY", hash: "#activity" });
    expect(visible(m)).toBe(1);
    expect(chip(m, "verdict", "DENY").getAttribute("aria-pressed")).toBe("true");
    expect(m.location.hash).toBe("#activity");
  });

  it("parses legacy #f= hashes read-only; the next save migrates to ?f=", () => {
    const legacy = mount(HTML, { hash: "#f=verdict:DENY" });
    expect(visible(legacy)).toBe(1);
    expect(chip(legacy, "verdict", "DENY").getAttribute("aria-pressed")).toBe("true");

    // A chip toggle rewrites the state into the query and drops the legacy
    // fragment (it is not a tab hash and must not ride along).
    chip(legacy, "product", "kimi").click();
    expect(legacy.location.search).toBe("?f=verdict:DENY,product:kimi");
    expect(legacy.location.hash).toBe("");
    expect(fullUrl(legacy)).not.toContain("#f=");
  });

  it("preserves other query params (the live page's ?t= token) across saves", () => {
    const m = mount(HTML, { search: "?t=tok-abc123" });
    chip(m, "verdict", "DENY").click();
    expect(m.location.search).toBe("?t=tok-abc123&f=verdict:DENY");
    m.clearBtn.click();
    expect(m.location.search).toBe("?t=tok-abc123");
  });

  it("ignores malformed query segments and unknown groups", () => {
    const m = mount(HTML, { search: "?f=zzz:x,%E0%A4%A,no-colon,product:," });
    expect(visible(m)).toBe(5); // unknown group 'zzz' must not hide every row
    expect(m.clearBtn.hidden).toBe(true);
    for (const c of m.chips) expect(c.getAttribute("aria-pressed")).toBe("false");
    // Valid segments after malformed ones still apply.
    const partial = mount(HTML, { search: "?f=zzz:x,verdict:DENY" });
    expect(visible(partial)).toBe(1);
  });

  it("filters feed rows by tool via the query param and dashboard tool rows", () => {
    // Query path: ?f=tool:A keeps only the row with data-tool="A".
    const fromQuery = mount(HTML, { search: "?f=tool:A" });
    expect(visible(fromQuery)).toBe(1);
    expect(row(fromQuery, "data-tool", "A").classList.contains("filtered-out")).toBe(false);
    expect(row(fromQuery, "data-tool", "B").classList.contains("filtered-out")).toBe(true);
    expect(chip(fromQuery, "tool", "A").getAttribute("aria-pressed")).toBe("true");

    // Click path: dashboard's top-tools row toggles like any other chip.
    const m = mount(HTML);
    chip(m, "tool", "A").click();
    expect(visible(m)).toBe(1);
    expect(m.location.search).toBe("?f=tool:A");
    chip(m, "tool", "B").click(); // OR within the tool group
    expect(visible(m)).toBe(2);
    m.clearBtn.click();
    expect(visible(m)).toBe(5);
  });

  it("clear-filters resets rows, chips, and the query but keeps the tab hash", () => {
    const m = mount(HTML, { hash: "#activity" });
    chip(m, "product", "kimi").click();
    chip(m, "verdict", "DENY").click();
    expect(visible(m)).toBe(1);
    m.clearBtn.click();
    expect(visible(m)).toBe(5);
    expect(m.location.search).toBe("");
    expect(m.location.hash).toBe("#activity");
    expect(m.clearBtn.hidden).toBe(true);
    for (const c of m.chips) expect(c.getAttribute("aria-pressed")).toBe("false");
    for (const d of m.days) expect(d.classList.contains("filtered-out")).toBe(false);
  });

  it("decodes percent-encoded delimiters in values and re-encodes on save", () => {
    const ENC_EVENTS: TrailEvent[] = [
      ev({ ts: "2026-09-11T10:00:00.000Z", sessionId: "s", toolId: "P1", project: "foo,bar" }),
      ev({ ts: "2026-09-11T09:00:00.000Z", sessionId: "s", toolId: "P2", project: "a:b" }),
      ev({ ts: "2026-09-11T08:00:00.000Z", sessionId: "s", toolId: "P3", project: "plain" }),
    ];
    const ENC_HTML = renderReceiptHtml(buildReceiptModel("s", ENC_EVENTS, {}));

    // %2C decodes to a comma INSIDE the value — it must not split segments.
    const comma = mount(ENC_HTML, { search: "?f=project:foo%2Cbar" });
    expect(visible(comma)).toBe(1);
    expect(row(comma, "data-project", "foo,bar").classList.contains("filtered-out")).toBe(false);
    expect(chip(comma, "project", "foo,bar").getAttribute("aria-pressed")).toBe("true");

    // %3A decodes to a colon inside the value (only the first ':' separates).
    const colon = mount(ENC_HTML, { search: "?f=project:a%3Ab" });
    expect(visible(colon)).toBe(1);
    expect(row(colon, "data-project", "a:b").classList.contains("filtered-out")).toBe(false);

    // Round-trip: toggling the chip re-encodes the delimiters.
    const m = mount(ENC_HTML);
    chip(m, "project", "foo,bar").click();
    expect(m.location.search).toBe("?f=project:foo%2Cbar");
    chip(m, "project", "a:b").click(); // OR within the project group
    expect(m.location.search).toBe("?f=project:foo%2Cbar,project:a%3Ab");
    expect(visible(m)).toBe(2);
  });

  it("takes the first f= param on parse and self-heals to exactly one on save", () => {
    // First f= wins; the duplicate is ignored.
    const m = mount(HTML, { search: "?f=product:kimi&f=verdict:DENY" });
    expect(visible(m)).toBe(2); // product:kimi only (A + C), not ANDed with DENY
    expect(chip(m, "product", "kimi").getAttribute("aria-pressed")).toBe("true");
    expect(chip(m, "verdict", "DENY").getAttribute("aria-pressed")).toBe("false");

    // The next save strips every legacy f= param and writes exactly one.
    chip(m, "verdict", "ALLOW").click();
    expect(m.location.search).toBe("?f=product:kimi,verdict:ALLOW");
    expect(m.location.search.match(/f=/g)).toHaveLength(1);
  });

  it("drops malformed segments in legacy #f= hashes, keeps valid ones", () => {
    const allBad = mount(HTML, { hash: "#f=zzz:x,bad" });
    expect(visible(allBad)).toBe(5);
    expect(allBad.clearBtn.hidden).toBe(true);
    const partial = mount(HTML, { hash: "#f=zzz:x,bad,verdict:DENY" });
    expect(visible(partial)).toBe(1);
    expect(chip(partial, "verdict", "DENY").getAttribute("aria-pressed")).toBe("true");
  });

  it("filters feed rows by MCP server via the server group", () => {
    const MCP_EVENTS: TrailEvent[] = [
      ev({ ts: "2026-09-11T10:00:00.000Z", sessionId: "s", toolId: "mcp__github__get_issue" }),
      ev({ ts: "2026-09-11T09:00:00.000Z", sessionId: "s", toolId: "mcp__github__create_issue" }),
      ev({ ts: "2026-09-11T08:00:00.000Z", sessionId: "s", toolId: "mcp__slack__post_message" }),
      ev({ ts: "2026-09-11T07:00:00.000Z", sessionId: "s", toolId: "mcp__acme-internal__do_thing" }),
    ];
    const MCP_HTML = renderReceiptHtml(buildReceiptModel("s", MCP_EVENTS, {}));

    // Query path: server is a KNOWN group, so ?f=server:GitHub filters rows.
    const fromQuery = mount(MCP_HTML, { search: "?f=server:GitHub" });
    expect(visible(fromQuery)).toBe(2);
    expect(row(fromQuery, "data-tool", "mcp__github__get_issue").classList.contains("filtered-out")).toBe(false);
    expect(row(fromQuery, "data-tool", "mcp__slack__post_message").classList.contains("filtered-out")).toBe(true);

    // Click path: the Servers chip group toggles like any other chip.
    const m = mount(MCP_HTML);
    chip(m, "server", "GitHub").click();
    expect(visible(m)).toBe(2);
    expect(m.location.search).toBe("?f=server:GitHub");
    chip(m, "server", "Slack").click(); // OR within the server group
    expect(visible(m)).toBe(3);
    // The unknown-server row has no data-server facet and never matches.
    expect(row(m, "data-tool", "mcp__acme-internal__do_thing").classList.contains("filtered-out")).toBe(true);
    m.clearBtn.click();
    expect(visible(m)).toBe(4);
  });
});
