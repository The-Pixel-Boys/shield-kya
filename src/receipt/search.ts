/**
 * Natural-language search over the activity feed.
 *
 * Pure-lexical BM25 with optional MiniLM semantic hybrid. The search module
 * has no runtime dependency on native ML libraries: fastembed is imported
 * lazily and only in the live server path.
 */
import { createHash } from "node:crypto";
import { clip } from "../dash/render.js";
import { mcpServerLabel, parseMcpToolId } from "../mcp-servers.js";
import { productLabel, type TrailEvent } from "../trail.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "as",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "from",
  "up",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "among",
  "within",
  "without",
  "against",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "can",
  "will",
  "just",
  "should",
  "now",
  "did",
  "does",
  "do",
  "has",
  "have",
  "had",
  "having",
  "get",
  "got",
  "gets",
  "make",
  "made",
  "makes",
  "use",
  "used",
  "uses",
  "using",
]);

/** Light stemmer: trailing "ing", "ed", and simple plural "s". */
function stem(token: string): string {
  if (token.length <= 3) return token;
  let s = token;
  if (s.endsWith("ing")) {
    const stem = s.slice(0, -3);
    if (/[aeiou]/.test(stem)) s = stem;
  } else if (s.endsWith("ed")) {
    const stem = s.slice(0, -2);
    if (/[aeiou]/.test(stem)) s = stem;
  } else if (s.endsWith("s") && !s.endsWith("ss")) {
    s = s.slice(0, -1);
  }
  if (s.length > 3 && /([bcdfghjklmnpqrstvwxz])\1$/.test(s)) {
    s = s.slice(0, -1);
  }
  return s.length >= 2 ? s : token;
}

/** Split camelCase, PascalCase, snake_case, kebab-case, and dot.case. */
function splitIdentifiers(token: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const char of token) {
    if (char === "_" || char === "-" || char === ".") {
      if (current) parts.push(current);
      current = "";
    } else if (/[A-Z]/.test(char)) {
      if (current && /[a-z]/.test(current[current.length - 1]!)) {
        parts.push(current);
        current = char.toLowerCase();
      } else {
        current += char.toLowerCase();
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Tokenize a query or document for BM25 matching. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^a-zA-Z0-9]+/)) {
    if (!raw) continue;
    for (const part of splitIdentifiers(raw)) {
      if (!part) continue;
      const s = stem(part.toLowerCase());
      if (STOPWORDS.has(s)) continue;
      out.push(s);
    }
  }
  return out;
}

/** Concatenate the searchable fields of a trail event. */
export function eventDocumentText(e: TrailEvent): string {
  const parsed = parseMcpToolId(e.toolId);
  const serverLabel = parsed ? mcpServerLabel(parsed.server) : "";
  const parts = [
    e.toolId,
    e.reasonCode,
    e.summary ?? "",
    e.project ?? "",
    productLabel(e.product),
    e.mode,
    serverLabel,
    e.targetPath ?? "",
  ];
  return parts.filter((p) => p).join(" ");
}

/** Stable SHA1 of the searchable document text; used to version embeddings. */
export function eventTextSha1(e: TrailEvent): string {
  return createHash("sha1").update(eventDocumentText(e)).digest("hex");
}

export interface Bm25Document {
  readonly id: string;
  readonly tokens: readonly string[];
  readonly fields: { readonly text: string; readonly weight: number }[];
}

export interface Bm25Score {
  readonly id: string;
  readonly score: number;
}

/**
 * Standard BM25 over field-weighted documents.
 *
 * k1 controls term saturation; b controls document-length normalization.
 */
export class Bm25Index {
  private docs: Map<string, Bm25Document> = new Map();
  private df: Map<string, number> = new Map();
  private totalDocLength = 0;

  constructor(
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {}

  add(id: string, doc: Bm25Document): void {
    this.docs.set(id, doc);
    this.totalDocLength += doc.tokens.length;
    const seen = new Set<string>();
    for (const t of doc.tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  private avgDocLength(): number {
    return this.docs.size ? this.totalDocLength / this.docs.size : 0;
  }

  search(query: string): Bm25Score[] {
    const qTokens = [...new Set(tokenize(query))];
    if (qTokens.length === 0 || this.docs.size === 0) return [];
    const avg = this.avgDocLength();
    const results: Bm25Score[] = [];
    for (const doc of this.docs.values()) {
      // Field-weighted length normalization: sum(field tokens * weight).
      let weightedLength = 0;
      for (const f of doc.fields) {
        weightedLength += tokenize(f.text).length * f.weight;
      }
      let score = 0;
      for (const t of qTokens) {
        const df = this.df.get(t) ?? 0;
        if (df === 0) continue;
        // IDF with a floor so common terms still contribute a little.
        const idf = Math.log(1 + (this.docs.size - df + 0.5) / (df + 0.5));
        const tf = doc.tokens.filter((x) => x === t).length;
        if (tf === 0) continue;
        const denom = tf + this.k1 * (1 - this.b + (this.b * weightedLength) / Math.max(avg, 1));
        score += idf * ((tf * (this.k1 + 1)) / denom);
      }
      if (score > 0) results.push({ id: doc.id, score });
    }
    return results.sort((a, b) => b.score - a.score);
  }
}

export interface FacetHints {
  readonly verdict?: readonly string[];
  readonly server?: readonly string[];
  readonly product?: readonly string[];
  readonly mode?: readonly string[];
}

const SERVER_ALIASES: Record<string, string[]> = {
  github: ["GitHub"],
  gitlab: ["GitLab"],
  postgres: ["PostgreSQL"],
  postgresql: ["PostgreSQL"],
  slack: ["Slack"],
  notion: ["Notion"],
  jira: ["Jira"],
  confluence: ["Confluence"],
  linear: ["Linear"],
  playwright: ["Playwright"],
  browser: ["Playwright"],
  puppeteer: ["Puppeteer"],
  stripe: ["Stripe"],
  vercel: ["Vercel"],
  aws: ["AWS"],
  gcp: ["GCP"],
  google: ["GCP"],
  azure: ["Azure"],
};

const PRODUCT_ALIASES: Record<string, string[]> = {
  cursor: ["cursor"],
  claude: ["claude"],
  codex: ["codex"],
  grok: ["grok"],
  kimi: ["kimi"],
};

/** Map natural-language terms to known facet values for soft boosting. */
export function extractFacetHints(query: string): FacetHints {
  const q = ` ${query.toLowerCase()} `;
  const hints: { verdict: string[]; server: string[]; product: string[]; mode: string[] } = {
    verdict: [],
    server: [],
    product: [],
    mode: [],
  };

  if (/\b(deny|denied|blocked|rejected|forbidden)\b/.test(q)) hints.verdict.push("DENY");
  if (/\b(approve|review|hold)\b/.test(q)) hints.verdict.push("REQUIRE_APPROVE");
  if (/\ballow(ed)?\b/.test(q)) hints.verdict.push("ALLOW");
  if (/\bnever\b/.test(q)) hints.verdict.push("NEVER_EVENT");

  for (const [alias, labels] of Object.entries(SERVER_ALIASES)) {
    if (q.includes(` ${alias} `)) hints.server.push(...labels);
  }

  for (const [alias, ids] of Object.entries(PRODUCT_ALIASES)) {
    if (q.includes(` ${alias} `)) hints.product.push(...ids);
  }

  if (/\b(observe|observed)\b/.test(q)) hints.mode.push("observe");
  if (/\bhold\b/.test(q)) hints.mode.push("hold");
  if (/\boffline\b/.test(q)) hints.mode.push("offline");

  const out: { -readonly [K in keyof FacetHints]: FacetHints[K] } = {};
  if (hints.verdict.length) out.verdict = hints.verdict;
  if (hints.server.length) out.server = hints.server;
  if (hints.product.length) out.product = hints.product;
  if (hints.mode.length) out.mode = hints.mode;
  return out;
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface RankedEvent {
  readonly event: TrailEvent;
  readonly score: number;
}

/**
 * Reciprocal Rank Fusion of two ranked lists. Each list is expected in
 * descending order by score; ranks are 1-based.
 */
export function rrfMerge(bm25Ranks: readonly Bm25Score[], semanticRanks: readonly Bm25Score[], k = 60): Bm25Score[] {
  const map = new Map<string, number>();
  for (let i = 0; i < bm25Ranks.length; i++) {
    const r = bm25Ranks[i]!;
    map.set(r.id, (map.get(r.id) ?? 0) + 1 / (k + i + 1));
  }
  for (let i = 0; i < semanticRanks.length; i++) {
    const r = semanticRanks[i]!;
    map.set(r.id, (map.get(r.id) ?? 0) + 1 / (k + i + 1));
  }
  return [...map.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/** Build a BM25 index from trail events with weighted fields. */
export function buildEventIndex(events: readonly TrailEvent[]): Bm25Index {
  const index = new Bm25Index();
  for (const e of events) {
    const parsed = parseMcpToolId(e.toolId);
    const serverLabel = parsed ? mcpServerLabel(parsed.server) : "";
    const fields = [
      { text: e.toolId, weight: 2 },
      { text: e.reasonCode, weight: 1 },
      { text: e.summary ?? "", weight: 2 },
      { text: e.project ?? "", weight: 1 },
      { text: productLabel(e.product), weight: 1 },
      { text: e.mode, weight: 1 },
      { text: serverLabel, weight: 1 },
      { text: e.targetPath ?? "", weight: 1 },
    ].filter((f) => f.text);
    const tokens: string[] = [];
    for (const f of fields) {
      for (let i = 0; i < f.weight; i++) {
        tokens.push(...tokenize(f.text));
      }
    }
    index.add(eventKey(e), { id: eventKey(e), tokens, fields });
  }
  return index;
}

export function eventKey(e: TrailEvent): string {
  return `${e.ts}::${e.sessionId}::${e.toolId}`;
}

export interface SearchOptions {
  readonly query: string;
  readonly filters?: { readonly [group: string]: readonly string[] };
  /** Cached embeddings keyed by event key. */
  readonly embeddings?: ReadonlyMap<string, number[]>;
  /** Optional query embedding for semantic ranking. */
  readonly queryEmbedding?: number[];
  /** Soft-boost events whose facets match hinted values. */
  readonly facetBoost?: number;
}

/**
 * Rank events by query relevance. Chip filters are applied first; BM25 ranks
 * the survivors; optional semantic embeddings are merged with RRF.
 */
export function rankEvents(events: readonly TrailEvent[], options: SearchOptions): RankedEvent[] {
  const { query, filters, embeddings, queryEmbedding, facetBoost = 0.05 } = options;
  const q = query.trim();
  const hints = extractFacetHints(q);

  const filtered = applyChipFilters(events, filters ?? {});
  const index = buildEventIndex(filtered);

  const bm25 = index.search(q);
  const byId = new Map(filtered.map((e) => [eventKey(e), e]));

  let merged: Bm25Score[] = bm25;
  if (embeddings && embeddings.size > 0 && q.length > 0 && queryEmbedding) {
    const semantic: Bm25Score[] = [];
    for (const e of filtered) {
      const vec = embeddings.get(eventKey(e));
      if (!vec) continue;
      const sim = cosine(queryEmbedding, vec);
      if (sim > 0) semantic.push({ id: eventKey(e), score: sim });
    }
    merged = rrfMerge(bm25, semantic.sort((a, b) => b.score - a.score));
  }

  const ranked: RankedEvent[] = [];
  for (const s of merged) {
    const event = byId.get(s.id);
    if (event) ranked.push({ event, score: s.score });
  }
  return applyFacetBoost(ranked, byId, hints, facetBoost);
}

function applyFacetBoost(
  ranked: RankedEvent[],
  byId: Map<string, TrailEvent>,
  hints: FacetHints,
  boost: number,
): RankedEvent[] {
  if (!hints.verdict && !hints.server && !hints.product && !hints.mode) return ranked;
  return ranked.map((r) => {
    const e = byId.get(eventKey(r.event));
    if (!e) return r;
    let b = 0;
    if (hints.verdict?.includes(e.verdict.toUpperCase())) b += boost;
    const parsed = parseMcpToolId(e.toolId);
    if (parsed && hints.server?.includes(mcpServerLabel(parsed.server))) b += boost;
    if (hints.product?.includes(e.product ?? "other")) b += boost;
    if (hints.mode?.includes(e.mode)) b += boost;
    return b > 0 ? { event: r.event, score: r.score + b } : r;
  });
}

export function applyChipFilters(
  events: readonly TrailEvent[],
  filters: { readonly [group: string]: readonly string[] },
): TrailEvent[] {
  const groups = Object.entries(filters)
    .map(([group, vals]) => [group, vals.filter((v) => v !== "")] as const)
    .filter(([, vals]) => vals.length > 0);
  if (groups.length === 0) return [...events];
  return events.filter((e) =>
    groups.every(([group, vals]) => vals.some((v) => eventMatchesFilter(e, group, v))),
  );
}

export function eventMatchesFilter(e: TrailEvent, group: string, value: string): boolean {
  switch (group) {
    case "verdict":
      return e.verdict.toUpperCase() === value;
    case "never":
      return (e.neverEvent || e.reasonCode === "NEVER_EVENT") && value === "1";
    case "mode":
      return e.mode === value;
    case "plane":
      return (e.host?.trim() || "unknown") === value;
    case "product":
      return (e.product ?? "other") === value;
    case "project":
      if (value === "") return false;
      return (e.project?.trim() ?? "") === value;
    case "tool":
      return clip(e.toolId, 60) === value;
    case "session":
      return (e.sessionId || "unknown") === value;
    case "server": {
      const parsed = parseMcpToolId(e.toolId);
      return parsed != null && mcpServerLabel(parsed.server) === value;
    }
    default:
      return false;
  }
}
