/**
 * Map page (src/map/page.ts): escaping, the CSP, the draw script rules, edge tone and width, the heat tables.
 * The hostile fixture uses markup in tool ids, project names and target classes (the untrusted strings of a trail).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMap } from "../src/map/build.js";
import { buildHeat } from "../src/map/heat.js";
import {
  ADVISORY_LINE,
  MAP_CSP,
  MAP_SCRIPT,
  TONE_COLOUR,
  cytoscapeSource,
  drawModel,
  edgeTone,
  edgeWidth,
  esc,
  jsonForScript,
  renderMapBody,
  renderMapPage,
  scanMapOutput,
} from "../src/map/page.js";
import type { TrailEventLike } from "../src/map/types.js";

const SALT = "0".repeat(64);
const NOW = new Date("2026-11-02T12:00:00.000Z");
const HOSTILE_TOOL = "<img src=x onerror=alert(1)>";
const HOSTILE_PROJECT = "</script><script>alert(1)</script>";
const HOSTILE_CLASS = 'network:evil"><svg onload=alert(1)>';

function hostileRows(): TrailEventLike[] {
  const ts = new Date(NOW.getTime() - 60_000).toISOString();
  return [
    { ts, sessionId: "s-hostile", host: 'evil"><svg onload=alert(1)>', product: "claude", project: HOSTILE_PROJECT, toolId: HOSTILE_TOOL, verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" },
    { ts, sessionId: "s-hostile", product: "claude", project: HOSTILE_PROJECT, toolId: "Bash", targetClass: HOSTILE_CLASS, verdict: "DENY", reasonCode: "NEVER_EVENT", mode: "offline" },
  ];
}

function denyRows(): TrailEventLike[] {
  const ts = new Date(NOW.getTime() - 30 * 60_000).toISOString();
  return [
    { ts, sessionId: "s1", product: "claude", project: "demo", toolId: "Bash", summary: "shell git (+2 args)", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" },
    { ts, sessionId: "s1", product: "claude", project: "demo", toolId: "Bash", summary: "shell git (+2 args)", verdict: "DENY", reasonCode: "NEVER_EVENT", mode: "offline" },
  ];
}

function build(events: TrailEventLike[]) {
  const graph = buildMap(events, { salt: SALT, now: NOW, days: 3 });
  const heat = buildHeat(events, { now: NOW, days: 7, tzOffsetMinutes: 0 });
  return { graph, heat };
}

describe("kya map page: escaping", () => {
  it("jsonForScript escapes markup and the two line separators, and parses back to the same value", () => {
    const value = { a: "</script><script>alert(1)</script>", b: "x\u2028y\u2029z", c: "<!--&-->", d: 'q"\\' };
    const out = jsonForScript(value);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual(value);
  });

  it("esc neutralises markup in text and attributes", () => {
    const out = esc(`<img src=x onerror="alert(1)">'&`);
    expect(out).not.toMatch(/[<>"']/);
    expect(out).toContain("&lt;img");
  });

  it("the hostile fixture: no raw markup in the page, and the embedded data parses back to the original strings", () => {
    const { graph, heat } = build(hostileRows());
    const page = renderMapPage({ graph, heat, days: 3, title: "t" });
    expect(page).not.toContain(HOSTILE_TOOL);
    expect(page).not.toContain(HOSTILE_PROJECT);
    expect(page).not.toContain(HOSTILE_CLASS);
    expect(page).not.toMatch(/<img|<svg|<\/script><script>alert/);
    const data = /<script type="application\/json" id="kya-map-data">([\s\S]*?)<\/script>/.exec(page);
    expect(data).not.toBeNull();
    const parsed = JSON.parse(data![1]!);
    expect(parsed.nodes.map((n: { label: string }) => n.label)).toContain(HOSTILE_TOOL);
    expect(parsed.nodes.map((n: { label: string }) => n.label)).toContain(HOSTILE_PROJECT);
    expect(parsed.nodes.map((n: { detail: string }) => n.detail)).toContain(HOSTILE_CLASS);
  });

  it("the secret scan lets exact class labels through and still refuses a real secret shape", () => {
    expect(() => scanMapOutput("target:secret:cloud-credential network:example.com")).not.toThrow();
    expect(() => scanMapOutput("password: abcdefghijklmnopqrstu")).toThrow();
  });
});

describe("kya map page: CSP, network and the draw script", () => {
  it("the standalone page carries the Content Security Policy and nothing else", () => {
    const { graph, heat } = build(denyRows());
    const page = renderMapPage({ graph, heat, days: 3, title: "t" });
    expect(MAP_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:");
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${MAP_CSP}"/>`);
    expect(page).toContain(ADVISORY_LINE);
  });

  it("no http or https string outside the vendored library, which keeps its licence header", () => {
    const { graph, heat } = build(denyRows());
    const page = renderMapPage({ graph, heat, days: 3, title: "t" });
    expect(page).toContain('<script id="kya-cytoscape">');
    expect(page).toContain("Cytoscape Consortium");
    const outside = page.replace(/<script id="kya-cytoscape">[\s\S]*?<\/script>/, "");
    expect(outside).not.toMatch(/https?:\/\//);
  });

  it("the draw script never uses innerHTML and writes its text with textContent", () => {
    expect(MAP_SCRIPT).not.toContain("innerHTML");
    expect(MAP_SCRIPT).toContain("textContent");
  });

  it("the vendored library is Cytoscape.js 3.34.4 (sha256 pinned) and cannot end its script element", () => {
    const file = join(import.meta.dirname, "..", "vendor", "cytoscape", "cytoscape.min.js");
    const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(sha).toBe("081591ab735b2b6a3b31a3c60f8f3a3e2fee8c92939e0c7820ad1208571b6cd8");
    expect(cytoscapeSource()).not.toMatch(/<\/script/i);
  });
});

describe("kya map page: edge tone and width", () => {
  it("any deny makes the edge red, even next to allows (deny beats hold, hold beats observed, observed beats allow)", () => {
    expect(edgeTone({ allow: 5, deny: 1, hold: 0, observed: 0 })).toBe("deny");
    expect(edgeTone({ allow: 0, deny: 0, hold: 2, observed: 9 })).toBe("hold");
    expect(edgeTone({ allow: 3, deny: 0, hold: 0, observed: 1 })).toBe("observed");
    expect(edgeTone({ allow: 4, deny: 0, hold: 0, observed: 0 })).toBe("allow");
    expect(TONE_COLOUR.deny).toBe("#b42318");
  });

  it("the drawn edge for a denied step carries the red colour", () => {
    const { graph } = build(denyRows());
    const model = drawModel(graph);
    const red = model.edges.filter((e) => e.verdicts.deny > 0);
    expect(red.length).toBeGreaterThan(0);
    for (const e of red) {
      expect(e.tone).toBe("deny");
      expect(e.colour).toBe("#b42318");
    }
  });

  it("edge width grows with the count", () => {
    expect(edgeWidth(1)).toBe(1);
    expect(edgeWidth(10)).toBeGreaterThan(edgeWidth(1));
    expect(edgeWidth(100)).toBeGreaterThan(edgeWidth(10));
  });
});

describe("kya map page: heat views and empty state", () => {
  it("the When table marks a deny hour with the red outline class, and the Where table shows the deny column", () => {
    const { graph, heat } = build(denyRows());
    const body = renderMapBody(graph, heat, 3);
    expect(body).toMatch(/<td class="l\d deny"/);
    expect(body).toContain('class="map-heat map-when"');
    expect(body).toContain('class="map-heat map-where"');
    const whenRows = (body.split('class="map-heat map-when"')[1] ?? "").split("</table>")[0]!.match(/<tr><th scope="row">/g) ?? [];
    expect(whenRows).toHaveLength(7);
  });

  it("an empty trail renders the empty line and no graph container", () => {
    const { graph, heat } = build([]);
    const body = renderMapBody(graph, heat, 3);
    expect(body).toContain("No events in the last 3 days.");
    expect(body).not.toContain('id="kya-map-graph"');
    expect(body).toContain(ADVISORY_LINE);
  });
});

describe("renderMapBody: very large graphs (review item 4)", () => {
  it("the draw script refuses to lay out more than 400 nodes and says so in text", () => {
    expect(MAP_SCRIPT).toContain("var MAX_DRAW_NODES = 400;");
    expect(MAP_SCRIPT).toContain("Graph not drawn: ");
    // the message goes in through textContent, never innerHTML
    expect(MAP_SCRIPT).toMatch(/host\.textContent = 'Graph not drawn: '/);
  });
});
