/**
 * Map page: one body renderer for `kya map --html` and the live report's Map tab, plus the browser draw script.
 * Every string from the trail is untrusted. Server HTML escapes it with esc(). The embedded JSON escapes `<`, `>`,
 * `&`, U+2028 and U+2029. The draw script writes labels through Cytoscape or textContent, never as HTML.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertNoSecrets } from "../dash/render.js";
import type { Heat } from "./heat.js";
import type { MapGraph, MapNode, Verdicts } from "./types.js";

/** The one line that says what the map is not. Shown on every map page. */
export const ADVISORY_LINE =
  "Recorded by KYA. The open source check is advisory; this map shows what was recorded, not what was enforced.";

/** Edge colours by dominant verdict. Deny beats hold, hold beats observed, observed beats allow (schema section 3). */
export const TONE_COLOUR = { deny: "#b42318", hold: "#b54708", observed: "#667085", allow: "#067647" } as const;
export type EdgeTone = keyof typeof TONE_COLOUR;

/** Tone of an edge from its verdict counts. Any deny makes the edge red. */
export function edgeTone(v: Verdicts): EdgeTone {
  if (v.deny > 0) return "deny";
  if (v.hold > 0) return "hold";
  if (v.observed > 0) return "observed";
  return "allow";
}

/** Edge width grows with log(count): 1 for one event, about 3 for 10, about 5 for 100. */
export function edgeWidth(count: number): number {
  return Math.round((1 + 2 * Math.log10(Math.max(1, count))) * 100) / 100;
}

/**
 * JSON for a `<script type="application/json">` body. `<`, `>` and `&` and the two line separators become
 * \u escapes, so the text can never close the script element or start a tag. JSON.parse reads them back unchanged.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Secret scan for map output. The shared keyword rule reads `secret:<family>` class labels as a secret assignment
 * (`secret:cloud-credential` is 16 characters), so those exact labels are masked first. Everything else is scanned.
 */
const SECRET_CLASS = /\bsecret:(ssh-key|cloud-credential|gpg|env-file|package-token|key-file|other)\b/g;
export function scanMapOutput(text: string): void {
  assertNoSecrets(text.replace(SECRET_CLASS, "secret-class:$1"));
}

/** HTML text and attribute escape. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Data the draw script reads: nodes with a label and detail, edges with tone and width (computed here, not in the browser). */
export function drawModel(graph: MapGraph) {
  return {
    colours: TONE_COLOUR,
    nodes: graph.nodes.map((n: MapNode) => ({
      id: n.id,
      kind: n.kind,
      label: n.label ?? n.id,
      detail: detailOf(n),
      count: n.count,
      verdicts: n.verdicts,
      firstTs: n.firstTs,
      lastTs: n.lastTs,
    })),
    edges: graph.edges.map((e, i) => {
      const tone = edgeTone(e.verdicts);
      return {
        id: `e${i}`,
        source: e.from,
        target: e.to,
        kind: e.kind,
        tool: e.tool ?? null,
        tone,
        colour: TONE_COLOUR[tone],
        width: edgeWidth(e.count),
        count: e.count,
        verdicts: e.verdicts,
        firstTs: e.firstTs,
        lastTs: e.lastTs,
      };
    }),
  };
}

function detailOf(n: MapNode): string {
  if (n.kind === "target") return n.class;
  if (n.kind === "tool") return n.toolId;
  if (n.kind === "agent") return n.legacy ? `${n.product} (legacy rows)` : n.product;
  return n.id;
}

const SHOWN_TARGETS = 5;

function sum(nums: readonly number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

/** Level 0 to 4 for a count, relative to the largest count on the page. */
function level(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((4 * count) / max));
}

function summaryHtml(graph: MapGraph): string {
  const devices = graph.nodes.filter((n) => n.kind === "device");
  const events = sum(devices.map((n) => n.count));
  const sessions = sum(graph.nodes.filter((n) => n.kind === "agent").map((n) => n.grouped ?? 1));
  const classes = graph.nodes
    .filter((n): n is Extract<MapNode, { kind: "target" }> => n.kind === "target" && n.grouped === undefined)
    .sort((a, b) => b.count - a.count || (a.class < b.class ? -1 : a.class > b.class ? 1 : 0))
    .slice(0, SHOWN_TARGETS);
  const top = classes.length
    ? `<ol class="map-top">${classes.map((c) => `<li><code>${esc(c.class)}</code> ${c.count}</li>`).join("")}</ol>`
    : `<p class="mute">No targets yet.</p>`;
  return `<div class="map-stats">
  <p><strong>${events}</strong> events · <strong>${sessions}</strong> sessions · <strong>${devices.length}</strong> device${devices.length === 1 ? "" : "s"}</p>
  <p class="small">Top ${SHOWN_TARGETS} target classes:</p>
  ${top}
</div>`;
}

function whenTable(heat: Heat): string {
  const head = heat.when.hours.map((h) => `<th scope="col">${String(h).padStart(2, "0")}</th>`).join("");
  const rows = heat.when.days.map((day, d) => {
    const cells = heat.when.cells[d]!.map((count, h) => {
      const v = heat.when.verdictCells[d]![h]!;
      const deny = v.deny > 0 ? " deny" : "";
      const title = `${day} ${String(h).padStart(2, "0")}:00 - ${count} event${count === 1 ? "" : "s"}${v.deny > 0 ? `, ${v.deny} denied` : ""}`;
      return `<td class="l${level(count, heat.when.max)}${deny}" title="${esc(title)}">${count || ""}</td>`;
    });
    return `<tr><th scope="row">${esc(day)}</th>${cells.join("")}</tr>`;
  });
  return `<table class="map-heat map-when">
  <caption>When: events per hour, last 7 days (local time). A red outline marks an hour with a deny.</caption>
  <thead><tr><th scope="col">Day</th>${head}</tr></thead>
  <tbody>${rows.join("")}</tbody>
</table>`;
}

function whereTable(heat: Heat): string {
  const rows = heat.where.rows.map((r) => {
    const cell = (count: number, col: string) =>
      `<td class="l${level(count, heat.where.max)}${col === "deny" && count > 0 ? " deny" : ""}">${count || ""}</td>`;
    const name = r.grouped !== undefined ? `${r.class} (${r.grouped})` : r.class;
    return `<tr><th scope="row"><code>${esc(name)}</code></th>${cell(r.allow, "allow")}${cell(r.deny, "deny")}${cell(r.hold, "hold")}${cell(r.observed, "observed")}</tr>`;
  });
  return `<table class="map-heat map-where">
  <caption>Where: events per target class and verdict.</caption>
  <thead><tr><th scope="col">Target class</th><th scope="col">Allow</th><th scope="col">Deny</th><th scope="col">Hold</th><th scope="col">Observed</th></tr></thead>
  <tbody>${rows.join("") || `<tr><td colspan="5" class="mute">No targets.</td></tr>`}</tbody>
</table>`;
}

/**
 * The page body: summary, graph container, side panel, both heat tables, and the data. Used inside the standalone
 * file and as the live report's Map fragment. The graph is drawn by MAP_SCRIPT from the data element.
 */
export function renderMapBody(graph: MapGraph, heat: Heat, days: number): string {
  const events = sum(graph.nodes.filter((n) => n.kind === "device").map((n) => n.count));
  const empty = events === 0 ? `<p class="map-empty">No events in the last ${days} days.</p>` : "";
  const graphBlock =
    events === 0
      ? ""
      : `<div class="map-canvas">
  <div id="kya-map-graph" class="map-graph" aria-label="Map of agent actions"></div>
  <aside id="kya-map-panel" class="map-panel" aria-live="polite"><p class="mute">Click a node to see its class, counts and first and last time.</p></aside>
</div>
<p class="map-legend small">Edges: red = deny, amber = hold, grey = observed (recorded, not enforced), green = allow. Width grows with the count.</p>`;
  return `<div class="map-body">
  <p class="map-advisory">${esc(ADVISORY_LINE)}</p>
  ${summaryHtml(graph)}
  ${empty}
  ${graphBlock}
  <h2>When</h2>
  <div class="map-scroll">${whenTable(heat)}</div>
  <h2>Where</h2>
  <div class="map-scroll">${whereTable(heat)}</div>
  <script type="application/json" id="kya-map-data">${jsonForScript(drawModel(graph))}</script>
</div>`;
}

const LIBRARY_PATH = new URL("../../vendor/cytoscape/cytoscape.min.js", import.meta.url);
let librarySource: string | undefined;

/** The vendored Cytoscape.js (MIT, see vendor/cytoscape/LICENSE). `</script` is broken so it cannot end the element. */
export function cytoscapeSource(): string {
  if (librarySource === undefined) {
    librarySource = readFileSync(fileURLToPath(LIBRARY_PATH), "utf8").replace(/<\/(script)/gi, "<\\/$1");
  }
  return librarySource;
}

/** Content-Security-Policy for the standalone file. No network: default-src none. */
export const MAP_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

/**
 * The browser part. Labels go to Cytoscape (canvas) or textContent. The live body is parsed with DOMParser (the body
 * has no executable script), so this file never assigns innerHTML.
 */
export const MAP_SCRIPT = `(function () {
  'use strict';
  var cy = null;
  var last = null;
  var live = !!document.querySelector('main[data-live-token]');
  function token() {
    var m = /(?:^|[?&])t=([^&]*)/.exec(location.search);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  function model() {
    var el = document.getElementById('kya-map-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent || 'null'); } catch (e) { return null; }
  }
  function add(parent, tag, text) {
    var n = document.createElement(tag);
    n.textContent = String(text);
    parent.appendChild(n);
    return n;
  }
  function showNode(node) {
    var panel = document.getElementById('kya-map-panel');
    if (!panel) return;
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    add(panel, 'h3', node.kind + ': ' + node.label);
    add(panel, 'p', 'Class: ' + node.detail);
    var list = document.createElement('dl');
    panel.appendChild(list);
    [['Events', node.count], ['Allow', node.verdicts.allow], ['Deny', node.verdicts.deny], ['Hold', node.verdicts.hold],
     ['Observed', node.verdicts.observed], ['First seen', node.firstTs || '-'], ['Last seen', node.lastTs || '-']]
      .forEach(function (r) { add(list, 'dt', r[0]); add(list, 'dd', r[1]); });
  }
  function style(d) {
    var out = [
      { selector: 'node', style: { 'label': 'data(label)', 'font-size': 10, 'text-wrap': 'ellipsis', 'text-max-width': 130, 'min-zoomed-font-size': 9,
        'text-background-color': '#ffffff', 'text-background-opacity': 0.8, 'text-background-padding': 1,
        'width': 18, 'height': 18, 'background-color': '#98a2b3', 'color': '#101828' } },
      { selector: 'node[kind = "device"]', style: { 'background-color': '#344054', 'shape': 'round-rectangle', 'width': 34, 'height': 34 } },
      { selector: 'node[kind = "agent"]', style: { 'background-color': '#1d4ed8' } },
      { selector: 'node[kind = "tool"]', style: { 'background-color': '#7a5af8', 'shape': 'round-rectangle' } },
      { selector: 'node[kind = "target"]', style: { 'background-color': '#0e9384' } },
      { selector: 'edge', style: { 'width': 'data(width)', 'line-color': 'data(colour)', 'target-arrow-color': 'data(colour)',
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'opacity': 0.9 } }
    ];
    return out;
  }
  var MAX_DRAW_NODES = 400;
  function draw() {
    var host = document.getElementById('kya-map-graph');
    var d = model();
    if (cy) { cy.destroy(); cy = null; }
    if (!host || !d || !window.cytoscape || !d.nodes || !d.nodes.length) return;
    // A force layout on thousands of nodes hangs the tab. The JSON and both heat views still hold everything.
    if (d.nodes.length > MAX_DRAW_NODES) {
      host.textContent = 'Graph not drawn: ' + d.nodes.length + ' nodes is too many for the page. Use a shorter window (kya map --days 1) or kya map --json.';
      return;
    }
    cy = window.cytoscape({
      container: host,
      elements: {
        nodes: d.nodes.map(function (n) { return { data: n }; }),
        edges: d.edges.map(function (e) { return { data: e }; })
      },
      style: style(d),
      layout: { name: 'cose', animate: false, randomize: true, fit: true, padding: 24, numIter: 900, nodeRepulsion: function () { return 9000; }, idealEdgeLength: function () { return 80; }, nodeOverlap: 14, gravity: 0.35 }
    });
    cy.on('tap', 'node', function (evt) { showNode(evt.target.data()); });
    cy.fit();
  }
  function refresh() {
    if (!live) return;
    var host = document.getElementById('frag-map');
    if (!host) return;
    fetch('/fragments?t=' + encodeURIComponent(token()), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"map":true}'
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.fragments || typeof j.fragments.mapBody !== 'string') return;
        if (j.fragments.mapBody === last) return;
        last = j.fragments.mapBody;
        var doc = new DOMParser().parseFromString(j.fragments.mapBody, 'text/html');
        var nodes = Array.prototype.slice.call(doc.body.childNodes);
        while (host.firstChild) host.removeChild(host.firstChild);
        nodes.forEach(function (n) { host.appendChild(n); });
        draw();
      })
      .catch(function (err) { console.error('KYA map refresh failed', err); });
  }
  // Live only: fetch the vendored library with the token from this page's URL, then run it as a script element.
  function loadLibrary(next) {
    if (window.cytoscape) { next(); return; }
    fetch('/vendor/cytoscape.min.js?t=' + encodeURIComponent(token()))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (text) {
        var s = document.createElement('script');
        s.id = 'kya-cytoscape';
        s.textContent = text;
        document.head.appendChild(s);
        next();
      })
      .catch(function (err) { console.error('KYA map library failed', err); });
  }
  window.kyaMapRefresh = refresh;
  window.addEventListener('hashchange', function () {
    if (location.hash !== '#map') return;
    refresh();
    setTimeout(function () { if (cy) { cy.resize(); cy.fit(); } }, 0);
  });
  if (live) loadLibrary(refresh); else draw();
})();`;

/**
 * Live report: the draw script, in the page shell (not in the swapped fragment). The script reads the token from its
 * own URL and fetches the library from /vendor/cytoscape.min.js, so the token never appears in the HTML.
 */
export function liveMapScripts(): string {
  return `<script id="kya-map">${MAP_SCRIPT}</script>`;
}

/** Map components. Shared by the standalone file and the live report, so it uses the report's tokens (--line, --mute, --fg, --bg). */
export const MAP_CSS = `
  .map-body .map-advisory { border-left: 3px solid var(--line, #d0d5dd); padding: 4px 10px; font-weight: 600; }
  .map-body .mute { color: var(--mute, #667085); }
  .map-stats p { margin: 4px 0; }
  .map-top { margin: 4px 0 12px 20px; padding: 0; }
  .map-canvas { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 12px; margin: 12px 0; }
  .map-graph { height: 60vh; min-height: 360px; border: 1px solid var(--line, #d0d5dd); border-radius: 6px; }
  .map-panel { border: 1px solid var(--line, #d0d5dd); border-radius: 6px; padding: 8px 12px; overflow: auto; }
  .map-panel dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
  .map-panel dt { color: var(--mute, #667085); }
  .map-panel dd { margin: 0; }
  .map-scroll { overflow-x: auto; }
  .map-heat { border-collapse: collapse; font-size: 12px; margin-bottom: 12px; }
  .map-heat caption { text-align: left; color: var(--mute, #667085); padding: 4px 0; }
  .map-heat th, .map-heat td { border: 1px solid var(--line, #d0d5dd); padding: 3px 5px; text-align: right; min-width: 22px; }
  .map-heat th { text-align: left; font-weight: 600; }
  .map-heat td.l0 { background: transparent; }
  .map-heat td.l1 { background: #d1fadf; color: #101828; }
  .map-heat td.l2 { background: #75e0a7; color: #101828; }
  .map-heat td.l3 { background: #12b76a; color: #fff; }
  .map-heat td.l4 { background: #027a48; color: #fff; }
  .map-heat td.deny { outline: 2px solid #b42318; outline-offset: -2px; }
  .map-empty { font-weight: 600; }
  @media (max-width: 760px) { .map-canvas { grid-template-columns: 1fr; } }
`;

/** Live report: the Map zone shows only on its tab (same :target rule as the other zones). */
export const MAP_LIVE_ZONE_CSS = `
  @supports selector(body:has(*)) {
    #map { display: none; }
    #map:target { display: block; }
    body:has(#map:target) #overview { display: none; }
    body:has(#map:target) .nav-link[href="#map"] { color: var(--fg); background: var(--bg); border-color: var(--line); }
  }
`;

/** Standalone file only: its own tokens and page frame (the live report has its own). */
export const MAP_PAGE_CSS = `
  :root { --fg: #101828; --mute: #667085; --line: #d0d5dd; --bg: #ffffff; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --fg: #f2f4f7; --mute: #98a2b3; --line: #344054; --bg: #101828; } }
  :root[data-theme="dark"] { --fg: #f2f4f7; --mute: #98a2b3; --line: #344054; --bg: #101828; }
  body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0; }
  .map-page { max-width: 1100px; margin: 0 auto; padding: 16px; }
`;

/** Standalone file: one page, no network, CSP on. */
export function renderMapPage(input: { graph: MapGraph; heat: Heat; days: number; title: string }): string {
  const body = renderMapBody(input.graph, input.heat, input.days);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="${MAP_CSP}"/>
<meta name="referrer" content="no-referrer"/>
<title>${esc(input.title)}</title>
<style>${MAP_PAGE_CSS}${MAP_CSS}</style>
</head>
<body>
<main class="map-page">
<header>
  <h1>Map of agent actions</h1>
  <p class="mute">Last ${input.days} days · local only</p>
</header>
${body}
</main>
<script id="kya-cytoscape">${cytoscapeSource()}</script>
<script id="kya-map">${MAP_SCRIPT}</script>
</body>
</html>
`;
}
