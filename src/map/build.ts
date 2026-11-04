import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { classifyTarget, type TargetFamily } from "./target-class.js";
import {
  MAP_SCHEMA_VERSION,
  type AgentNode,
  type MapEdge,
  type MapGraph,
  type MapNode,
  type TargetNode,
  type ToolClass,
  type ToolNode,
  type TrailEventLike,
  type Verdicts,
} from "./types.js";

export interface BuildOptions {
  /** Per-install salt for sessionHash. Tests pass a fixed value. */
  salt: string;
  /** Needed when `days` is set. The builder reads no clock. */
  now?: Date;
  /** Hard node cap per view (schema section 7). Default 100. */
  maxNodes?: number;
  /** Keep only rows at or after now minus `days`. */
  days?: number;
  /** Full export: no grouping, no caps. */
  uncapped?: boolean;
  /** Counts from readTrailFile, added to the view. */
  read?: { rowsRead: number; rowsSkipped: number; rowsOutOfWindow: number };
}

export interface TrailRead {
  events: TrailEventLike[];
  rowsRead: number;
  rowsSkipped: number;
  rowsOutOfWindow: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_MAX_NODES = 100;
const EDGE_CAP = 250;
const MODES = new Set(["observe", "hold", "offline"]);
const WRITE_VERB = /^(write|edit|update|create|put|patch|delete|rm|remove)$/;
const READ_VERB = /^(read|grep|glob|search)$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FAMILIES = new Set<string>(["network", "secret", "tmp", "system", "project", "home", "command", "none"]);
const KIND_ORDER = { device: 0, agent: 1, tool: 2, target: 3 } as const;

type Bucket = keyof Verdicts;

/** Shape check for one row. Bad rows are skipped and counted, never thrown. */
export function isTrailRow(x: unknown): x is TrailEventLike {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.ts === "string" &&
    !Number.isNaN(Date.parse(r.ts)) &&
    typeof r.sessionId === "string" &&
    typeof r.toolId === "string" &&
    typeof r.verdict === "string" &&
    typeof r.reasonCode === "string" &&
    typeof r.mode === "string" &&
    MODES.has(r.mode)
  );
}

/** Verdict bucket, schema section 3. First match wins. */
export function bucketOf(e: TrailEventLike): Bucket {
  if (e.verdict === "DENY") return "deny";
  if (e.shadow === true) return "observed";
  if (e.verdict === "REQUIRE_APPROVE" && e.mode === "hold") return "hold";
  if (e.verdict === "ALLOW") return "allow";
  return "observed";
}

/** Tool class, schema 4.1. First match wins. */
export function toolClassOf(e: TrailEventLike): ToolClass {
  const id = e.toolId;
  const low = id.toLowerCase();
  const last = id.split(/[./]/).filter(Boolean).pop()?.toLowerCase() ?? "";
  if (id.startsWith("kya:")) return "kya";
  if (id.includes("__")) return "mcp";
  if ((e.summary ?? "").startsWith("shell ") || /shell|exec|bash/.test(low)) return "shell";
  if (e.targetPath && URL_SCHEME.test(e.targetPath)) return "network";
  if (WRITE_VERB.test(last) || /write|edit/.test(low)) return "write";
  if (READ_VERB.test(last) || /read|grep|glob|search/.test(low)) return "read";
  return "other";
}

/** Family from a class string (the part before the colon). Unknown heads are `other`. */
function familyOf(cls: string): TargetFamily {
  const head = cls.split(":")[0] ?? "";
  return (FAMILIES.has(head) ? head : "other") as TargetFamily;
}

/** A stored class is trusted only when it has the shape the writer produces: short, printable, `family:rest` or `none`. */
export const SAFE_CLASS = /^(?:none|[a-z]+:[\x20-\x7e]{0,120})$/;

export function targetOf(e: TrailEventLike): { cls: string; family: TargetFamily } {
  if (typeof e.targetClass === "string" && e.targetClass.length <= 128 && SAFE_CLASS.test(e.targetClass)) {
    return { cls: e.targetClass, family: familyOf(e.targetClass) };
  }
  const t = classifyTarget({ toolId: e.toolId, targetPath: e.targetPath, summary: e.summary, project: e.project });
  return { cls: t.class, family: t.family };
}

interface Agg {
  count: number;
  v: Verdicts;
  first: string;
  firstMs: number;
  last: string;
  lastMs: number;
}

function aggNew(): Agg {
  return { count: 0, v: { allow: 0, deny: 0, hold: 0, observed: 0 }, first: "", firstMs: Infinity, last: "", lastMs: -Infinity };
}

function aggAdd(a: Agg, bucket: Bucket, ts: string, ms: number): void {
  a.count += 1;
  a.v[bucket] += 1;
  if (ms < a.firstMs || (ms === a.firstMs && ts < a.first)) {
    a.firstMs = ms;
    a.first = ts;
  }
  if (ms > a.lastMs || (ms === a.lastMs && ts > a.last)) {
    a.lastMs = ms;
    a.last = ts;
  }
}

function aggMerge(a: Agg, b: Agg): void {
  a.count += b.count;
  a.v.allow += b.v.allow;
  a.v.deny += b.v.deny;
  a.v.hold += b.v.hold;
  a.v.observed += b.v.observed;
  if (b.firstMs < a.firstMs || (b.firstMs === a.firstMs && b.first < a.first)) {
    a.firstMs = b.firstMs;
    a.first = b.first;
  }
  if (b.lastMs > a.lastMs || (b.lastMs === a.lastMs && b.last > a.last)) {
    a.lastMs = b.lastMs;
    a.last = b.last;
  }
}

/** One node or edge endpoint in the aggregate. `kind` is the node kind. */
interface Ent {
  id: string;
  kind: "device" | "agent" | "tool" | "target";
  agg: Agg;
  /** Agent: project basename of the latest row that has one. */
  label: string | null;
  labelMs: number;
  product?: string;
  sessionHash?: string;
  legacy?: boolean;
  toolId?: string;
  toolClasses?: Map<ToolClass, number>;
  cls?: string;
  family?: TargetFamily;
}

interface EdgeRec {
  from: string;
  to: string;
  kind: "runs" | "uses" | "touches";
  tool?: string;
  agg: Agg;
}

interface Model {
  ents: Map<string, Ent>;
  edges: Map<string, EdgeRec>;
  legacyRows: number;
}

function edgeKey(from: string, to: string, kind: string, tool: string | undefined): string {
  return `${from}\u0001${to}\u0001${kind}\u0001${tool ?? ""}`;
}

function getEnt(m: Model, id: string, init: () => Ent): Ent {
  let e = m.ents.get(id);
  if (!e) {
    e = init();
    m.ents.set(id, e);
  }
  return e;
}

function getEdge(m: Model, from: string, to: string, kind: EdgeRec["kind"], tool?: string): EdgeRec {
  const key = edgeKey(from, to, kind, tool);
  let r = m.edges.get(key);
  if (!r) {
    r = { from, to, kind, tool, agg: aggNew() };
    m.edges.set(key, r);
  }
  return r;
}

/** Salted hash of one session (16 hex). The raw session id can be a host product id, so it never leaves the machine. */
export function sessionHash(salt: string, product: string, sessionId: string): string {
  return createHash("sha256").update(`${salt}|${product}|${sessionId}`).digest("hex").slice(0, 16);
}

/** Fills the aggregate from the rows that pass the shape check and the window. */
function collect(events: Iterable<TrailEventLike>, opts: BuildOptions, cutoff: number): { m: Model; kept: number; invalid: number; outOfWindow: number } {
  const m: Model = { ents: new Map(), edges: new Map(), legacyRows: 0 };
  const hashes = new Map<string, string>();
  let kept = 0;
  let invalid = 0;
  let outOfWindow = 0;
  for (const e of events) {
    if (!isTrailRow(e)) {
      invalid += 1;
      continue;
    }
    const ms = Date.parse(e.ts);
    if (ms < cutoff) {
      outOfWindow += 1;
      continue;
    }
    kept += 1;
    const bucket = bucketOf(e);
    const product = e.product ?? "unknown";
    const cacheKey = `${product}\u0000${e.sessionId}`;
    let sh = hashes.get(cacheKey);
    if (sh === undefined) {
      sh = sessionHash(opts.salt, product, e.sessionId);
      hashes.set(cacheKey, sh);
    }
    if (e.product === undefined) m.legacyRows += 1;

    const devId = typeof e.deviceId === "string" && /^[0-9a-f]{16}$/.test(e.deviceId) ? `device:${e.deviceId}` : "device:local";
    const dev = getEnt(m, devId, () => ({ id: devId, kind: "device", agg: aggNew(), label: null, labelMs: -Infinity }));
    aggAdd(dev.agg, bucket, e.ts, ms);

    const agentId = `agent:${sh}`;
    const agent = getEnt(m, agentId, () => ({
      id: agentId,
      kind: "agent",
      agg: aggNew(),
      label: null,
      labelMs: -Infinity,
      product,
      sessionHash: sh,
      legacy: e.product === undefined,
    }));
    aggAdd(agent.agg, bucket, e.ts, ms);
    if (e.project && (ms > agent.labelMs || (ms === agent.labelMs && e.project > (agent.label ?? "")))) {
      agent.labelMs = ms;
      agent.label = e.project;
    }

    const toolId = `tool:${e.toolId}`;
    const tool = getEnt(m, toolId, () => ({ id: toolId, kind: "tool", agg: aggNew(), label: e.toolId, labelMs: 0, toolId: e.toolId, toolClasses: new Map() }));
    aggAdd(tool.agg, bucket, e.ts, ms);
    const tc = toolClassOf(e);
    tool.toolClasses!.set(tc, (tool.toolClasses!.get(tc) ?? 0) + 1);

    const tgt = targetOf(e);
    const targetId = `target:${tgt.cls}`;
    const target = getEnt(m, targetId, () => ({ id: targetId, kind: "target", agg: aggNew(), label: tgt.cls, labelMs: 0, cls: tgt.cls, family: tgt.family }));
    aggAdd(target.agg, bucket, e.ts, ms);

    aggAdd(getEdge(m, devId, agentId, "runs").agg, bucket, e.ts, ms);
    aggAdd(getEdge(m, agentId, toolId, "uses").agg, bucket, e.ts, ms);
    aggAdd(getEdge(m, agentId, targetId, "touches", e.toolId).agg, bucket, e.ts, ms);
  }
  return { m, kept, invalid, outOfWindow };
}

/** Rank: count desc, then last seen desc, then id asc. */
function rank(a: Ent, b: Ent): number {
  return b.agg.count - a.agg.count || b.agg.lastMs - a.agg.lastMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface Caps {
  agents: number;
  tools: number;
  targets: number;
}

interface Group {
  id: string;
  kind: "agent" | "tool" | "target";
  product?: string;
  toolClass?: ToolClass;
  family?: TargetFamily;
  agg: Agg;
  members: number;
}

interface Layout {
  nodes: MapNode[];
  edges: MapEdge[];
  grouped: { agents: number; tools: number; targets: number };
}

function verdictsOut(v: Verdicts): Verdicts {
  return { allow: v.allow, deny: v.deny, hold: v.hold, observed: v.observed };
}

function nodeFromEnt(e: Ent): MapNode {
  const common = { id: e.id, label: e.label, count: e.agg.count, verdicts: verdictsOut(e.agg.v), firstTs: e.agg.first, lastTs: e.agg.last };
  if (e.kind === "device") {
    const label = e.id === "device:local" ? "this machine" : e.id.slice("device:".length);
    return { kind: "device", ...common, label };
  }
  if (e.kind === "agent") {
    return { kind: "agent", ...common, product: e.product!, sessionHash: e.sessionHash!, legacy: e.legacy! } satisfies AgentNode;
  }
  if (e.kind === "tool") {
    let best: ToolClass = "other";
    let bestN = -1;
    for (const [cls, n] of [...e.toolClasses!].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (n > bestN) {
        best = cls;
        bestN = n;
      }
    }
    return { kind: "tool", ...common, toolId: e.toolId!, toolClass: best } satisfies ToolNode;
  }
  return { kind: "target", ...common, class: e.cls!, family: e.family! } satisfies TargetNode;
}

function nodeFromGroup(g: Group): MapNode {
  const common = { count: g.agg.count, verdicts: verdictsOut(g.agg.v), firstTs: g.agg.first, lastTs: g.agg.last, grouped: g.members };
  if (g.kind === "agent") {
    return { kind: "agent", id: g.id, label: `other agents (${g.members})`, product: g.product!, sessionHash: null, legacy: false, ...common };
  }
  if (g.kind === "tool") {
    const cls = g.toolClass!;
    return { kind: "tool", id: g.id, label: `other ${cls} tools (${g.members})`, toolId: `other:${cls}`, toolClass: cls, ...common };
  }
  return { kind: "target", id: g.id, label: `other ${g.family} (${g.members})`, class: `other:${g.family}`, family: g.family!, ...common };
}

/** One layout for given caps. Shown items keep their id; the rest fold into one group node per product, class or family. */
function layout(m: Model, caps: Caps): Layout {
  const all = [...m.ents.values()];
  const agents = all.filter((e) => e.kind === "agent").sort(rank);
  const tools = all.filter((e) => e.kind === "tool").sort(rank);
  const targets = all.filter((e) => e.kind === "target").sort(rank);
  const shown = new Set<string>();
  agents.forEach((e, i) => {
    if (i < caps.agents || e.agg.v.deny > 0) shown.add(e.id);
  });
  tools.forEach((e, i) => {
    if (i < caps.tools) shown.add(e.id);
  });
  targets.forEach((e, i) => {
    if (i < caps.targets || e.agg.v.deny > 0 || e.agg.v.hold > 0 || e.family === "secret") shown.add(e.id);
  });

  const groups = new Map<string, Group>();
  const grouped = { agents: 0, tools: 0, targets: 0 };
  const groupIdOf = new Map<string, string>();
  for (const e of all) {
    if (e.kind === "device" || shown.has(e.id)) continue;
    let gid: string;
    let g: Group;
    if (e.kind === "agent") {
      gid = `agent:other:${e.product}`;
      grouped.agents += 1;
      g = groups.get(gid) ?? { id: gid, kind: "agent", product: e.product, agg: aggNew(), members: 0 };
    } else if (e.kind === "tool") {
      const cls = [...e.toolClasses!].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
      gid = `tool:other:${cls}`;
      grouped.tools += 1;
      g = groups.get(gid) ?? { id: gid, kind: "tool", toolClass: cls, agg: aggNew(), members: 0 };
    } else {
      gid = `target:other:${e.family}`;
      grouped.targets += 1;
      g = groups.get(gid) ?? { id: gid, kind: "target", family: e.family, agg: aggNew(), members: 0 };
    }
    aggMerge(g.agg, e.agg);
    g.members += 1;
    groups.set(gid, g);
    groupIdOf.set(e.id, gid);
  }

  const mapId = (id: string): string => groupIdOf.get(id) ?? id;
  const merged = new Map<string, EdgeRec>();
  for (const r of m.edges.values()) {
    const from = mapId(r.from);
    const to = mapId(r.to);
    let tool: string | undefined;
    if (r.kind === "touches") {
      const gid = groupIdOf.get(`tool:${r.tool}`);
      tool = gid === undefined ? r.tool : `other:${gid.slice("tool:other:".length)}`;
    }
    const key = edgeKey(from, to, r.kind, tool);
    let mr = merged.get(key);
    if (!mr) {
      mr = { from, to, kind: r.kind, tool, agg: aggNew() };
      merged.set(key, mr);
    }
    aggMerge(mr.agg, r.agg);
  }

  const nodes: MapNode[] = [];
  for (const e of all) if (e.kind === "device" || shown.has(e.id)) nodes.push(nodeFromEnt(e));
  for (const g of groups.values()) nodes.push(nodeFromGroup(g));

  const edges: MapEdge[] = [...merged.values()].map((r) => ({
    from: r.from,
    to: r.to,
    kind: r.kind,
    ...(r.tool !== undefined ? { tool: r.tool } : {}),
    count: r.agg.count,
    verdicts: verdictsOut(r.agg.v),
    firstTs: r.agg.first,
    lastTs: r.agg.last,
  }));
  return { nodes, edges, grouped };
}

function sortNodes(nodes: MapNode[]): MapNode[] {
  return nodes.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortEdges(edges: MapEdge[]): MapEdge[] {
  const k = (e: MapEdge) => `${e.from}\u0001${e.to}\u0001${e.kind}\u0001${e.tool ?? ""}`;
  return edges.sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
}

/**
 * Builds the map graph from trail rows. Pure: same rows and options give the same JSON.
 * Caps (schema section 7): 25 agents, 20 tools, 40 targets shown; the rest fold into "other" nodes.
 * Deny, hold and secret targets are always shown. The node and edge caps shrink the per-type caps until they fit.
 */
export function buildMap(events: Iterable<TrailEventLike>, opts: BuildOptions): MapGraph {
  if (opts.days !== undefined && !opts.now) throw new Error("buildMap: days needs now (the builder reads no clock)");
  const cutoff = opts.days !== undefined ? opts.now!.getTime() - opts.days * DAY_MS : -Infinity;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const uncapped = opts.uncapped === true;
  const { m, kept, invalid, outOfWindow } = collect(events, opts, cutoff);

  let lay: Layout;
  if (uncapped) {
    lay = layout(m, { agents: Infinity, tools: Infinity, targets: Infinity });
  } else {
    // Step k shrinks targets (40), then tools (20), then agents (25). Binary search for the smallest step that fits.
    const fits = (l: Layout) => l.nodes.length <= maxNodes && l.edges.length <= EDGE_CAP;
    const at = (k: number): Caps => ({
      targets: Math.max(0, 40 - k),
      tools: Math.max(0, 20 - Math.max(0, k - 40)),
      agents: Math.max(0, 25 - Math.max(0, k - 60)),
    });
    lay = layout(m, at(85));
    if (fits(lay)) {
      let lo = 0;
      let hi = 85;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const l = layout(m, at(mid));
        if (fits(l)) {
          hi = mid;
          lay = l;
        } else lo = mid + 1;
      }
    }
  }
  let edges = lay.edges;
  let edgesDropped = 0;
  if (!uncapped && edges.length > EDGE_CAP) {
    // Sort by key first, so ties in the rank below never depend on input order.
    const ranked = sortEdges([...edges]).sort((a, b) => {
      const pa = a.verdicts.deny + a.verdicts.hold > 0 ? 0 : 1;
      const pb = b.verdicts.deny + b.verdicts.hold > 0 ? 0 : 1;
      return pa - pb || b.count - a.count || (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0);
    });
    edgesDropped = ranked.length - EDGE_CAP;
    edges = ranked.slice(0, EDGE_CAP);
  }
  const nodes = sortNodes(lay.nodes);
  const groupedTotal = lay.grouped.agents + lay.grouped.tools + lay.grouped.targets;
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    view: {
      source: "trail",
      rowsRead: opts.read ? opts.read.rowsRead : kept + invalid + outOfWindow,
      rowsSkipped: (opts.read?.rowsSkipped ?? 0) + invalid,
      rowsOutOfWindow: (opts.read?.rowsOutOfWindow ?? 0) + outOfWindow,
      legacyRows: m.legacyRows,
      truncated: groupedTotal > 0 || edgesDropped > 0,
      capExceeded: !uncapped && nodes.length > maxNodes,
      grouped: lay.grouped,
      edgesDropped,
    },
    nodes,
    edges: sortEdges(edges),
  };
}

/** Lines split on "\n" only. readline also splits on U+2028 and U+2029, so a tool name holding one would hide its own rows. */
async function* jsonlLines(path: string): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const parts = (rest + (chunk as string)).split("\n");
    rest = parts.pop() ?? "";
    yield* parts;
  }
  if (rest !== "") yield rest;
}

/**
 * Streams the whole trail file line by line. Unlike readTrail (tail read, 1 MB), this reads every row.
 * Bad lines (not JSON, or wrong shape) are skipped and counted. Rows older than `days` are counted, not kept.
 * A filter, not a stop: the file is not sorted (import rows dated 2025 come first).
 */
export async function readTrailFile(path: string, opts: { days?: number; now?: Date } = {}): Promise<TrailRead> {
  await stat(path);
  const cutoff = opts.days !== undefined ? (opts.now ?? new Date()).getTime() - opts.days * DAY_MS : -Infinity;
  const events: TrailEventLike[] = [];
  let rowsRead = 0;
  let rowsSkipped = 0;
  let rowsOutOfWindow = 0;
  for await (const line of jsonlLines(path)) {
    if (line.trim() === "") continue;
    rowsRead += 1;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      rowsSkipped += 1;
      continue;
    }
    if (!isTrailRow(row)) {
      rowsSkipped += 1;
      continue;
    }
    if (Date.parse(row.ts) < cutoff) {
      rowsOutOfWindow += 1;
      continue;
    }
    events.push(row);
  }
  return { events, rowsRead, rowsSkipped, rowsOutOfWindow };
}
