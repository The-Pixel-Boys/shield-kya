/**
 * Map layout (the block between the kya-map-layout markers in src/map/page.ts and in the hosted copy
 * web/src/main/resources/static/js/kya-map.js). The tests run the real block text with new Function, on the busy
 * synthetic trail (test/support/map-busy-trail.ts) and on small hand-made inputs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMap } from "../src/map/build.js";
import { MAP_SCRIPT, TONE_COLOUR, drawModel } from "../src/map/page.js";
import { busyTrail } from "./support/map-busy-trail.js";

const PAGE_TS = join(import.meta.dirname, "..", "src", "map", "page.ts");
const HOSTED_JS = join(import.meta.dirname, "..", "..", "..", "web", "src", "main", "resources", "static", "js", "kya-map.js");
const BEGIN = "// kya-map-layout:begin";
const END = "// kya-map-layout:end";
// The hosted copy exists only in the private monorepo (it has .woodpecker at its root); the public mirror has no web/.
const inMonorepo = existsSync(join(import.meta.dirname, "..", "..", "..", ".woodpecker"));
const copies = () => (inMonorepo ? [MAP_SCRIPT, readFileSync(HOSTED_JS, "utf8")] : [MAP_SCRIPT]);

function block(text: string): string {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  expect(b).toBeGreaterThanOrEqual(0);
  expect(e).toBeGreaterThan(b);
  return text.slice(b, e + END.length);
}

interface LNode { data: Record<string, unknown> & { id: string; kind: string; text: string; col: number; count: number }; position: { x: number; y: number } }
interface LEdge { data: Record<string, unknown> & { id: string; source: string; target: string; count: number } }
interface Layout { nodes: LNode[]; edges: LEdge[]; rows: number; width: number; height: number }
interface Api {
  kyaMapLayout: (nodes: unknown[], edges: unknown[], colours: Record<string, string>) => Layout;
  kyaMapSize: (avail: number, lay: { width: number; height: number }) => { zoom: number; minWidth: number; height: number };
  KYA_LAYOUT: { kinds: string[]; colGap: number; rowGap: number; maxRows: number; maxLabel: number; minZoom: number };
}

function load(text: string): Api {
  return new Function(`${block(text)}\nreturn { kyaMapLayout: kyaMapLayout, kyaMapSize: kyaMapSize, KYA_LAYOUT: KYA_LAYOUT };`)() as Api;
}

const api = load(readFileSync(PAGE_TS, "utf8"));
const NOW = new Date("2026-11-05T12:00:00.000Z");
const model = drawModel(buildMap(busyTrail(NOW), { salt: "0".repeat(64), now: NOW, days: 3 }));
const run = () => api.kyaMapLayout(model.nodes, model.edges, TONE_COLOUR);

function column(lay: Layout, kind: string): LNode[] {
  return lay.nodes.filter((n) => n.data.kind === kind).sort((a, b) => a.position.y - b.position.y);
}

describe("map layout: parity and layout name", () => {
  it("the layout block is byte-identical in page.ts and in MAP_SCRIPT", () => {
    expect(block(MAP_SCRIPT)).toBe(block(readFileSync(PAGE_TS, "utf8")));
  });

  it.skipIf(!inMonorepo)("the layout block is byte-identical in page.ts, in MAP_SCRIPT and in the hosted kya-map.js", () => {
    const fromTs = block(readFileSync(PAGE_TS, "utf8"));
    expect(block(readFileSync(HOSTED_JS, "utf8"))).toBe(fromTs);
    expect(block(MAP_SCRIPT)).toBe(fromTs);
  });

  it("both copies use preset positions, never the cose force layout", () => {
    for (const text of copies()) {
      expect(text).not.toMatch(/cose/);
      expect(block(text)).toContain("layout: { name: 'preset'");
    }
  });

  it("both copies keep the 400-node guard before they draw", () => {
    for (const text of copies()) {
      expect(text).toContain("var MAX_DRAW_NODES = 400;");
      const guard = text.indexOf("> MAX_DRAW_NODES)");
      const drawCall = text.lastIndexOf("= kyaMapDraw(host, ");
      expect(guard).toBeGreaterThan(0);
      expect(drawCall).toBeGreaterThan(guard);
      expect(text).toMatch(/host\.textContent = 'Graph not drawn: '/);
    }
  });

  it("both copies never assign innerHTML, and the panel for a +N more node shows its detail without a Class prefix", () => {
    for (const text of copies()) {
      expect(text).not.toMatch(/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/);
      expect(text).toContain("add(panel, 'p', node.more ? node.detail : ");
    }
  });

  it("the live page draws again when the Map tab shows (a draw in a hidden tab measured a width of 0)", () => {
    const handler = MAP_SCRIPT.slice(MAP_SCRIPT.indexOf("addEventListener('hashchange'"));
    expect(handler.slice(0, handler.indexOf("});"))).toContain("setTimeout(draw, 0);");
  });
});

describe("map layout: positions", () => {
  it("the busy fixture has the shape it claims", () => {
    const kinds = (k: string) => model.nodes.filter((n) => n.kind === k).length;
    expect(kinds("device")).toBe(2);
    expect(kinds("agent")).toBe(23);
    expect(kinds("target")).toBeGreaterThan(20);
    expect(model.nodes.filter((n) => n.kind === "agent" && n.label === "gtm")).toHaveLength(6);
    expect(model.nodes.find((n) => n.id === "target:command:cd")?.count).toBe(2492);
  });

  it("four columns, left to right: device, agent, tool, target; one x per column", () => {
    const lay = run();
    const xs = api.KYA_LAYOUT.kinds.map((k) => [...new Set(column(lay, k).map((n) => n.position.x))]);
    for (const x of xs) expect(x).toHaveLength(1);
    const flat = xs.map((x) => x[0]!);
    expect([...flat].sort((a, b) => a - b)).toEqual(flat);
    expect(new Set(flat).size).toBe(4);
  });

  it("no two labels in a column are closer than the row gap (at least 24 px), and rows sort by count", () => {
    const lay = run();
    expect(api.KYA_LAYOUT.rowGap).toBeGreaterThanOrEqual(24);
    for (const k of api.KYA_LAYOUT.kinds) {
      const col = column(lay, k);
      for (let i = 1; i < col.length; i += 1) {
        expect(col[i]!.position.y - col[i - 1]!.position.y).toBeGreaterThanOrEqual(api.KYA_LAYOUT.rowGap);
        if (!col[i]!.data.more) expect(col[i]!.data.count).toBeLessThanOrEqual(col[i - 1]!.data.count);
      }
    }
  });

  it("labels between two columns fit in the column gap (11 px font, at most 6.6 px per character)", () => {
    const lay = run();
    const room = api.KYA_LAYOUT.colGap - 13 - 8 - 6;
    for (const n of lay.nodes) {
      if (n.data.col === 1 || n.data.col === 2) expect(n.data.text.length * 6.6).toBeLessThan(room);
      expect(n.data.text.length).toBeLessThanOrEqual(api.KYA_LAYOUT.maxLabel + 6);
    }
  });

  it("the layout height leaves room below the last row: at least one row gap plus the node radius", () => {
    const lay = run();
    const lowest = Math.max(...lay.nodes.map((n) => n.position.y));
    expect(lay.height).toBeGreaterThanOrEqual(lowest + api.KYA_LAYOUT.rowGap + 8);
  });

  it("is deterministic: the same input, in any order, gives the same output", () => {
    const a = run();
    const b = run();
    expect(b).toEqual(a);
    const c = api.kyaMapLayout([...model.nodes].reverse(), model.edges, TONE_COLOUR);
    const pos = (l: Layout) => Object.fromEntries(l.nodes.map((n) => [n.data.id, [n.position.x, n.position.y, n.data.text]]));
    expect(pos(c)).toEqual(pos(a));
  });
});

describe("map layout: labels", () => {
  it("duplicate labels in a column become unique; the six gtm sessions get their event count", () => {
    const lay = run();
    for (const k of api.KYA_LAYOUT.kinds) {
      const texts = column(lay, k).map((n) => n.data.text);
      expect(new Set(texts).size).toBe(texts.length);
    }
    const gtm = column(lay, "agent").filter((n) => n.data.label === "gtm");
    expect(gtm.length).toBeGreaterThan(1);
    for (const n of gtm) expect(n.data.text).toBe(`gtm · ${n.data.count} events`);
    for (const n of lay.nodes) expect(n.data.text.length).toBeLessThanOrEqual(28);
  });

  it("labels compare in full: a unique label gets no suffix, a long one is cut at 22, a full tie gets a number", () => {
    const v = { allow: 1, deny: 0, hold: 0, observed: 0 };
    const node = (id: string, label: string, count: number) => ({ id, kind: "agent", label, count, verdicts: v, firstTs: "2026-11-03T10:00:00Z" });
    const nodes = [
      node("agent:1", "gtm", 9),
      node("agent:2", "gtm", 9),
      node("agent:3", "gtm", 7),
      node("agent:4", "2026-11-03-signal-run-weekly-outreach", 6),
      node("agent:5", "2026-11-03-other-run", 5),
      node("agent:6", "2026-11-03-signal-run-weekly-outreach", 4),
      node("agent:7", "solo", 1),
    ];
    const texts = api.kyaMapLayout(nodes, [], TONE_COLOUR).nodes.map((n) => n.data.text);
    expect(texts).toEqual([
      "gtm · 9 events (1)",
      "gtm · 9 events (2)",
      "gtm · 7 events",
      "2026-11-03-signa… · 6 events",
      "2026-11-03-other-run",
      "2026-11-03-signa… · 4 events",
      "solo",
    ]);
    const cut = api.kyaMapLayout([node("agent:8", "a-very-long-project-name-over-forty-characters", 1)], [], TONE_COLOUR).nodes[0]!.data.text;
    expect(cut).toBe("a-very-long-project-n…");
  });

  it("two different labels that look the same after the cut, with equal counts, still draw different texts", () => {
    const v = { allow: 1, deny: 0, hold: 0, observed: 0 };
    const nodes = ["shield-agent-worktree-fix-aaa", "shield-agent-worktree-fix-bbb"].map((label, i) => ({ id: `agent:${i}`, kind: "agent", label, count: 1, verdicts: v }));
    const texts = api.kyaMapLayout(nodes, [], TONE_COLOUR).nodes.map((n) => n.data.text);
    expect(texts).toEqual(["shield-agent-… · 1 event (1)", "shield-agent-… · 1 event (2)"]);
    for (const t of texts) expect(Array.from(t).length).toBeLessThanOrEqual(28);
  });

  it("a cut never splits an emoji, and an empty label shared by two nodes draws as (no label) with the count", () => {
    const v = { allow: 1, deny: 0, hold: 0, observed: 0 };
    const emoji = "😀".repeat(30);
    const one = api.kyaMapLayout([{ id: "agent:e", kind: "agent", label: emoji, count: 1, verdicts: v }], [], TONE_COLOUR).nodes[0]!.data.text;
    expect(one).toBe(`${"😀".repeat(21)}…`);
    expect(one).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const empty = api.kyaMapLayout([
      { id: "agent:a", kind: "agent", label: "", count: 5, verdicts: v },
      { id: "agent:b", kind: "agent", label: "", count: 3, verdicts: v },
    ], [], TONE_COLOUR).nodes.map((n) => n.data.text);
    expect(empty).toEqual(["(no label) · 5 events", "(no label) · 3 events"]);
  });
});

describe("map layout: size of the graph box", () => {
  it("the zoom never goes below minZoom; a narrow box gets a minimum width and scrolls sideways", () => {
    const lay = run();
    const L = api.KYA_LAYOUT;
    expect(L.minZoom).toBeGreaterThanOrEqual(0.8);
    const narrow = api.kyaMapSize(520, lay);
    expect(narrow.zoom).toBe(L.minZoom);
    expect(narrow.minWidth).toBeGreaterThan(520);
    expect(narrow.minWidth).toBe(Math.ceil(lay.width * L.minZoom + 48));
    const wide = api.kyaMapSize(1400, lay);
    expect(wide.zoom).toBe(1);
    expect(wide.minWidth).toBeLessThan(1400);
    expect(api.kyaMapSize(900, lay).zoom).toBeCloseTo((900 - 48) / lay.width, 5);
    expect(api.kyaMapSize(0, lay).zoom).toBe(1);
    expect(narrow.height).toBe(Math.max(360, Math.ceil(lay.height * L.minZoom + 48)));
  });

  it("both copies give Cytoscape the same minimum zoom", () => {
    for (const text of copies()) expect(block(text)).toContain("minZoom: KYA_LAYOUT.minZoom,");
  });
});

describe("map layout: edge style (headless Cytoscape, the vendored library)", () => {
  const lib = readFileSync(join(import.meta.dirname, "..", "vendor", "cytoscape", "cytoscape.min.js"), "utf8");
  const mod: { exports: unknown } = { exports: {} };
  new Function("module", "exports", lib)(mod, mod.exports);
  const cytoscape = mod.exports as (opts: Record<string, unknown>) => {
    edges: () => Array<{ data: (k: string) => unknown; style: (k: string) => string; id: () => string }>;
    getElementById: (id: string) => { emit: (t: string) => void; closedNeighborhood: () => { edges: () => { length: number } } };
    elements: (s?: string) => { length: number };
    on: (...a: unknown[]) => void;
  };
  const styleApi = new Function(`${block(readFileSync(PAGE_TS, "utf8"))}\nreturn kyaMapStyle;`)() as () => unknown[];

  it("deny and hold edges stay strong by default; allow and observed edges are quiet", () => {
    const lay = run();
    const cy = cytoscape({ headless: true, styleEnabled: true, elements: { nodes: lay.nodes, edges: lay.edges }, style: styleApi() });
    const byTone: Record<string, number[]> = {};
    for (const e of cy.edges()) (byTone[String(e.data("tone"))] ??= []).push(Number(e.style("opacity")));
    for (const t of ["deny", "hold", "allow", "observed"]) expect(byTone[t]?.length, t).toBeGreaterThan(0);
    for (const o of [...byTone["deny"]!, ...byTone["hold"]!]) expect(o).toBeGreaterThanOrEqual(0.85);
    for (const o of [...byTone["allow"]!, ...byTone["observed"]!]) expect(o).toBeLessThanOrEqual(0.2);
  });
});

describe("map layout: row cap", () => {
  it("a column with more than 20 nodes shows the top 20 and one +N more node with the exact N and summed count", () => {
    const lay = run();
    for (const kind of ["agent", "target"]) {
      const all = model.nodes.filter((n) => n.kind === kind).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || (a.id < b.id ? -1 : 1));
      const col = column(lay, kind);
      expect(col).toHaveLength(api.KYA_LAYOUT.maxRows + 1);
      const more = col[col.length - 1]!;
      const hidden = all.slice(api.KYA_LAYOUT.maxRows);
      expect(more.data.more).toBe(hidden.length);
      expect(more.data.text).toBe(`+${hidden.length} more`);
      expect(more.data.count).toBe(hidden.reduce((s, n) => s + n.count, 0));
      const hiddenIds = new Set(hidden.map((n) => n.id));
      for (const e of lay.edges) {
        expect(hiddenIds.has(e.data.source)).toBe(false);
        expect(hiddenIds.has(e.data.target)).toBe(false);
      }
    }
  });

  it("a column of exactly 21 nodes shows all 21; a column of 22 shows 20 and +2 more", () => {
    const v = { allow: 1, deny: 0, hold: 0, observed: 0 };
    const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `tool:t${i}`, kind: "tool", label: `t${i}`, count: 100 - i, verdicts: v }));
    const a = api.kyaMapLayout(nodes(21), [], TONE_COLOUR).nodes;
    expect(a).toHaveLength(21);
    expect(a.some((n) => n.data.more)).toBe(false);
    const b = api.kyaMapLayout(nodes(22), [], TONE_COLOUR).nodes;
    expect(b).toHaveLength(21);
    expect(b[20]!.data.text).toBe("+2 more");
  });

  it("edges into hidden nodes move to the +N more node and keep their total count", () => {
    const lay = run();
    const total = (edges: Array<{ count: number }>) => edges.reduce((s, e) => s + e.count, 0);
    expect(total(lay.edges.map((e) => e.data))).toBe(total(model.edges));
    const ids = new Set(lay.nodes.map((n) => n.data.id));
    for (const e of lay.edges) {
      expect(ids.has(e.data.source)).toBe(true);
      expect(ids.has(e.data.target)).toBe(true);
    }
  });
});
