/**
 * Activity feed HTML/MD for local trail events.
 */
import { assertNoSecrets, clip, stripEscapes } from "../dash/render.js";
import { clipMultiline, DIFF_MAX_TOTAL_CHARS } from "../diff-preview.js";
import { DOMAIN_LABELS, domainOrder } from "../certify/render.js";
import type {
  CertifyRequirementResult,
  RequirementStatus,
} from "../certify/evaluate.js";
import { productLabel, readTrail, readTrailSince, type TrailEvent, type TrailImportFormat, type TrailProduct } from "../trail.js";
import { mcpServerLabel, parseMcpToolId } from "../mcp-servers.js";
import type { KyaFileConfig } from "../config.js";
import {
  loadInvestigateLastRun,
  type InvestigateLastRun,
} from "../investigate/last-run.js";
import {
  readNotifyLog,
  summarizeNotifyLog,
  type NotifyLogSummary,
} from "../notify/log.js";
import { readOtelStats, type OtelStats } from "../otel/stats.js";
import {
  loadCertifyCard,
  loadIdentity,
  loadOrrCard,
  loadSandboxes,
  loadShowbackCard,
  loadWiredHosts,
  type CertifyCard,
  type OrrCard,
  type SandboxCard,
  type WiredHostRow,
} from "./enrich.js";
import {
  SHOWBACK_DISCLAIMER,
  type ShowbackReport,
} from "../showback/cost-per-task.js";
import { summarizeTrailUsage } from "../showback/trail-usage.js";
import { computeDashboard, type Dashboard, type DashboardRow, type ToolWorst } from "./dashboard.js";
import { buildChangesModel, type ChangesModel } from "./changes.js";
import {
  GATE_NOT_SETUP_QUICKSTART,
  loadGatePage,
  toolNameFromToolId,
  toolServerPrefix,
  type GateCard,
  type GatePage,
} from "./gate-page.js";
import { receiptCss } from "./receipt-css.js";
import { applyChipFilters, rankEvents } from "./search.js";

export const PAGE_SIZE = 50;

export function clampPage(page: number, total: number): number {
  if (total === 0) return 1;
  const p = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  return Math.min(p, total);
}

export interface ReceiptModel {
  readonly title: string;
  readonly rangeLabel: string;
  readonly generatedAt: string;
  readonly events: readonly TrailEvent[];
  readonly spend?: {
    readonly tokens?: number;
    readonly usdEstimate?: number;
  };
  readonly mcpSeen?: readonly { readonly server?: string; readonly toolId: string }[];
  /** When true, page connects to /events SSE for live refresh. */
  readonly live?: boolean;
  /** Loopback SSE token - set only by the live server, never in static renders. */
  readonly liveToken?: string;
  /** Page number for the Activity feed (1-based). */
  readonly page: number;
  /** Natural-language search query for the Activity feed. */
  readonly searchQuery?: string;
  /** Local identity from .kya/config.json (inert text; never a link). */
  readonly identity?: KyaFileConfig;
  /** Sandbox state + configured KYA_SANDBOX backend. */
  readonly sandboxes?: SandboxCard;
  /** Per-host wiring status across the connect registry. */
  readonly wiredHosts?: readonly WiredHostRow[];
  /** Local gateway state + per-server activity in the window. */
  readonly gate?: GatePage;
  /** Slim ORR card from orr-report/report.json. */
  readonly orr?: OrrCard;
  /** Live Agent Trust Baseline card, recomputed on every model load. */
  readonly certify?: CertifyCard;
  /** Observe-only showback from .kya/usage.json. */
  readonly showback?: ShowbackReport;
  /** Trace imports (host "import" events), aggregated over the full trail. */
  readonly imports?: ImportCard;
  /** Last `kya investigate` run summary from .kya/investigate-last.json. */
  readonly investigate?: InvestigateLastRun;
  /** Per-target alert delivery rollup from .kya/notify-log.jsonl. */
  readonly alerts?: NotifyLogSummary;
  /** Persisted OTLP export counters from .kya/otel-stats.json. */
  readonly otel?: OtelStats;
}

function esc(s: string): string {
  return stripEscapes(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sanitize untrusted text for the Markdown artifact: strip ANSI/control and
 * bidi/zero-width chars (stripEscapes), then escape the MD/HTML-significant
 * characters so values cannot break formatting or inject raw HTML/links.
 */
function mdText(s: string): string {
  return stripEscapes(s)
    .replace(/`/g, "\\`")
    .replace(/([[\]<>])/g, "\\$1");
}

/** Fence one tilde longer than the longest run in content (min 4). */
function mdFence(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/~+/g)) {
    longest = Math.max(longest, m[0].length);
  }
  return "~".repeat(Math.max(4, longest + 1));
}

/**
 * Sanitize a value for an inline `code span`: backslash-escapes are literal
 * inside code spans, so backticks are replaced outright (they would still
 * terminate the span); brackets/angles need no escaping inside a span.
 */
function mdInline(s: string): string {
  return stripEscapes(s).replace(/`/g, "'");
}

function countVerdicts(events: readonly TrailEvent[]) {
  let allow = 0;
  let deny = 0;
  let require = 0;
  let never = 0;
  for (const e of events) {
    const v = e.verdict.toUpperCase();
    if (e.neverEvent || e.reasonCode === "NEVER_EVENT") never++;
    if (v === "ALLOW") allow++;
    else if (v === "DENY") deny++;
    else if (v === "REQUIRE_APPROVE") require++;
  }
  return { allow, deny, require, never };
}

function relativeTime(ts: string, nowMs: number): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  const sec = Math.round((nowMs - t) / 1000);
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 86400 * 2) return "yesterday";
  return `${Math.round(sec / 86400)}d ago`;
}

function localDayKey(ts: string | number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(key: string, nowMs: number): string {
  const today = localDayKey(nowMs);
  const y = localDayKey(nowMs - 86400000);
  if (key === today) return "Today";
  if (key === y) return "Yesterday";
  return key;
}

function clock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function tone(verdict: string): "ok" | "bad" | "warn" | "mute" {
  const v = verdict.toUpperCase();
  if (v === "ALLOW") return "ok";
  if (v === "DENY") return "bad";
  if (v === "REQUIRE_APPROVE") return "warn";
  return "mute";
}

function verdictWord(verdict: string): string {
  const v = verdict.toUpperCase();
  if (v === "REQUIRE_APPROVE") return "REVIEW";
  return v;
}

export type WorstVerdict = "never" | "deny" | "hold" | "allow";

export interface SessionAggregate {
  readonly sessionId: string;
  readonly events: number;
  readonly deny: number;
  readonly hold: number;
  readonly never: number;
  readonly lastTs: string;
  /** never > deny > hold > allow. */
  readonly worst: WorstVerdict;
}

export interface CountRow {
  readonly label: string;
  readonly count: number;
  /** Raw filter value when it differs from the display label (products). */
  readonly value?: string;
}

export interface EventAggregates {
  readonly modes: { readonly observe: number; readonly hold: number; readonly offline: number };
  readonly planes: { readonly ide: number; readonly runtime: number };
  /** Top 8 sessions by recency. */
  readonly sessions: readonly SessionAggregate[];
  /** Top 8 reason codes by count. */
  readonly reasons: readonly CountRow[];
  /** Counts by productLabel, sorted desc; value carries the raw product id. */
  readonly products: readonly CountRow[];
  /** Top 8 projects by count, sorted desc then label asc. */
  readonly projects: readonly CountRow[];
  /** Counts by recognized MCP server label, sorted desc then label asc. */
  readonly servers: readonly CountRow[];
}

/** Pure rollup of trail events for the report's stat chips and sections. */
export function aggregateEvents(events: readonly TrailEvent[]): EventAggregates {
  const modes = { observe: 0, hold: 0, offline: 0 };
  const planes = { ide: 0, runtime: 0 };
  const reasonCounts = new Map<string, number>();
  const productCounts = new Map<TrailProduct, number>();
  const projectCounts = new Map<string, number>();
  const serverCounts = new Map<string, number>();
  const bySession = new Map<
    string,
    { events: number; deny: number; hold: number; never: number; lastTs: string }
  >();

  for (const e of events) {
    if (e.mode === "observe") modes.observe++;
    else if (e.mode === "hold") modes.hold++;
    else if (e.mode === "offline") modes.offline++;
    if (e.host === "ide") planes.ide++;
    else if (e.host === "runtime") planes.runtime++;
    reasonCounts.set(e.reasonCode, (reasonCounts.get(e.reasonCode) ?? 0) + 1);
    const pv = e.product ?? "other";
    productCounts.set(pv, (productCounts.get(pv) ?? 0) + 1);
    const project = e.project?.trim();
    if (project) projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
    const server = parseMcpToolId(e.toolId);
    if (server) {
      const label = mcpServerLabel(server.server);
      serverCounts.set(label, (serverCounts.get(label) ?? 0) + 1);
    }

    const sid = e.sessionId || "unknown";
    let s = bySession.get(sid);
    if (!s) {
      s = { events: 0, deny: 0, hold: 0, never: 0, lastTs: e.ts };
      bySession.set(sid, s);
    }
    s.events++;
    if (e.neverEvent || e.reasonCode === "NEVER_EVENT") s.never++;
    const v = e.verdict.toUpperCase();
    if (v === "DENY") s.deny++;
    else if (v === "REQUIRE_APPROVE") s.hold++;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
  }

  const sessions: SessionAggregate[] = [...bySession.entries()]
    .map(([sessionId, s]) => ({
      sessionId,
      ...s,
      worst: (s.never > 0
        ? "never"
        : s.deny > 0
          ? "deny"
          : s.hold > 0
            ? "hold"
            : "allow") as WorstVerdict,
    }))
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
    .slice(0, 8);

  const reasons: CountRow[] = [...reasonCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 8);

  const products: CountRow[] = [...productCounts.entries()]
    .map(([value, count]) => ({ label: productLabel(value), count, value }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const projects: CountRow[] = [...projectCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 8);

  const servers: CountRow[] = [...serverCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { modes, planes, sessions, reasons, products, projects, servers };
}

export interface ImportFormatRow {
  readonly format: string;
  readonly imported: number;
  readonly errors: number;
}

/** Rollup of imported trace events for the Import hero card. */
export interface ImportCard {
  readonly total: number;
  readonly errors: number;
  readonly formats: readonly ImportFormatRow[];
  /** ts of the newest imported event ("" when none parse). */
  readonly lastTs: string;
}

const IMPORT_REASONS = new Set<string>(["IMPORTED", "IMPORTED_ERROR"]);
const IMPORT_FORMAT_RE = /^import-(langsmith|langfuse|phoenix|otel)-/;

/** Legacy fallback: pre-importFormat trails carry the format in the fallback session id. */
function legacyImportFormat(sessionId: string): TrailImportFormat | undefined {
  const m = IMPORT_FORMAT_RE.exec(sessionId);
  return m ? (m[1] as TrailImportFormat) : undefined;
}

/**
 * Aggregate host "import" trail events (written by kya import; reasonCode
 * IMPORTED / IMPORTED_ERROR) per source format. Undefined when the trail has
 * no imported events - the report section stays hidden on fresh installs.
 */
export function aggregateImports(events: readonly TrailEvent[]): ImportCard | undefined {
  const byFormat = new Map<string, { imported: number; errors: number }>();
  let total = 0;
  let errors = 0;
  let lastTs = "";
  for (const e of events) {
    if (e.host !== "import" || !IMPORT_REASONS.has(e.reasonCode)) continue;
    const isError = e.reasonCode === "IMPORTED_ERROR";
    total++;
    if (isError) errors++;
    if (e.ts > lastTs) lastTs = e.ts;
    const format = e.importFormat ?? legacyImportFormat(e.sessionId) ?? "other";
    const row = byFormat.get(format) ?? { imported: 0, errors: 0 };
    if (isError) row.errors++;
    else row.imported++;
    byFormat.set(format, row);
  }
  if (total === 0) return undefined;
  const formats: ImportFormatRow[] = [...byFormat.entries()]
    .map(([format, r]) => ({ format, imported: r.imported, errors: r.errors }))
    .sort((a, b) => b.imported + b.errors - (a.imported + a.errors) || a.format.localeCompare(b.format));
  return { total, errors, formats, lastTs };
}

export function buildReceiptModel(
  sessionId: string,
  events: readonly TrailEvent[],
  extras?: Partial<Omit<ReceiptModel, "title" | "events" | "generatedAt" | "rangeLabel">>,
): ReceiptModel {
  const filtered = events.filter((e) => e.sessionId === sessionId);
  return {
    title: "Agent activity",
    rangeLabel: `session ${sessionId}`,
    generatedAt: new Date().toISOString(),
    events: filtered,
    page: extras?.page ?? 1,
    spend: extras?.spend,
    mcpSeen: extras?.mcpSeen,
    live: extras?.live,
    liveToken: extras?.liveToken,
    searchQuery: extras?.searchQuery,
    identity: extras?.identity,
    sandboxes: extras?.sandboxes,
    wiredHosts: extras?.wiredHosts,
    gate: extras?.gate,
    orr: extras?.orr,
    certify: extras?.certify,
    showback: extras?.showback,
    imports: extras?.imports,
    investigate: extras?.investigate,
    alerts: extras?.alerts,
    otel: extras?.otel,
  };
}

export function buildWindowReceiptModel(
  events: readonly TrailEvent[],
  days: number,
  extras?: Partial<Omit<ReceiptModel, "title" | "events" | "generatedAt" | "rangeLabel">>,
): ReceiptModel {
  const n = days > 0 ? days : 3;
  return {
    title: "Agent activity",
    rangeLabel: `last ${n} day${n === 1 ? "" : "s"}`,
    generatedAt: new Date().toISOString(),
    events,
    page: extras?.page ?? 1,
    spend: extras?.spend,
    mcpSeen: extras?.mcpSeen,
    live: extras?.live,
    liveToken: extras?.liveToken,
    searchQuery: extras?.searchQuery,
    identity: extras?.identity,
    sandboxes: extras?.sandboxes,
    wiredHosts: extras?.wiredHosts,
    gate: extras?.gate,
    orr: extras?.orr,
    certify: extras?.certify,
    showback: extras?.showback,
    imports: extras?.imports,
    investigate: extras?.investigate,
    alerts: extras?.alerts,
    otel: extras?.otel,
  };
}

/** Shared loader for static artifacts and the live loopback server. */
export function loadReceiptModel(input: {
  readonly cwd: string;
  readonly sessionId?: string;
  readonly days: number;
  readonly live?: boolean;
  readonly liveToken?: string;
  readonly page?: number;
  readonly searchQuery?: string;
  readonly env?: NodeJS.ProcessEnv;
}): ReceiptModel {
  const days = input.days > 0 ? Math.floor(input.days) : 3;
  const env = input.env ?? process.env;
  const showback = loadShowbackCard(input.cwd);
  const events = input.sessionId
    ? readTrail(input.cwd, env)
    : readTrailSince(input.cwd, new Date(Date.now() - days * 24 * 60 * 60 * 1000), env);
  // The Import card aggregates the full trail, not just the window: imported
  // spans keep their foreign timestamps and would fall out of a short window.
  const importEvents = input.sessionId ? events : readTrail(input.cwd, env);
  const extras = {
    page: input.page ?? 1,
    live: input.live,
    liveToken: input.liveToken,
    searchQuery: input.searchQuery,
    identity: loadIdentity(input.cwd),
    sandboxes: loadSandboxes(input.cwd),
    wiredHosts: loadWiredHosts(input.cwd),
    gate: loadGatePage(events),
    orr: loadOrrCard(input.cwd),
    certify: loadCertifyCard(input.cwd),
    showback,
    imports: aggregateImports(importEvents),
    investigate: loadInvestigateLastRun(env),
    alerts: summarizeNotifyLog(readNotifyLog(env)),
    otel: readOtelStats(env),
    spend: showback
      ? {
          tokens: showback.totalTokensIn + showback.totalTokensOut,
          usdEstimate: showback.estimatedUsd ?? undefined,
        }
      : undefined,
  };
  if (input.sessionId) {
    return buildReceiptModel(input.sessionId, events, extras);
  }
  return buildWindowReceiptModel(events, days, extras);
}

interface FilterFacetEvent {
  readonly verdict: string;
  readonly neverEvent?: boolean;
  readonly reasonCode?: string;
  readonly mode: TrailEvent["mode"];
  readonly host?: string;
  readonly product?: string;
  readonly project?: string;
  readonly toolId: string;
}

/**
 * Build the data-* filter facet attribute string shared by feed articles and
 * change entries. `sessionId` is passed explicitly because change entries roll
 * up under their session heading.
 */
function filterDataAttrs(e: FilterFacetEvent, sessionId: string): string {
  const never = e.neverEvent || e.reasonCode === "NEVER_EVENT";
  const project = e.project?.trim();
  const server = parseMcpToolId(e.toolId);
  return (
    `data-verdict="${esc(e.verdict.toUpperCase())}"` +
    (never ? ` data-never="1"` : "") +
    ` data-mode="${esc(e.mode)}"` +
    ` data-plane="${esc(e.host?.trim() || "unknown")}"` +
    ` data-product="${esc(e.product ?? "other")}"` +
    ` data-tool="${esc(clip(e.toolId, 60))}"` +
    ` data-session="${esc(sessionId)}"` +
    (server ? ` data-server="${esc(mcpServerLabel(server.server))}"` : "") +
    (project ? ` data-project="${esc(project)}"` : "")
  );
}

function modeBadge(mode: TrailEvent["mode"] | undefined): string {
  const letter = mode === "observe" ? "O" : mode === "hold" ? "H" : mode === "offline" ? "X" : "";
  if (!letter) return "";
  return `<span class="modeb" title="${letter === "O" ? "observe" : letter === "H" ? "hold" : "offline"} mode">${letter}</span>`;
}

// project is attacker-controllable (trail files are user-editable) - always escaped.
function projectMeta(project: string | undefined): string {
  const p = project?.trim();
  if (!p) return "";
  return `
      <span class="dot">-</span>
      <span class="project">${esc(clip(p, 40))}</span>`;
}

function renderFeed(events: readonly TrailEvent[], nowMs: number, live?: boolean, preserveOrder?: boolean): string {
  if (events.length === 0) {
    const hint = live
      ? "No events yet - evaluate a tool call with <code>kya wrap</code> and this page will refresh."
      : "No events yet - evaluate a tool call with <code>kya wrap</code>, then regenerate this receipt.";
    return `<p class="empty">${hint}</p>`;
  }

  const ordered = preserveOrder ? [...events] : [...events].sort((a, b) => b.ts.localeCompare(a.ts));
  const parts: string[] = [];
  let lastDay = "";

  for (const e of ordered) {
    const key = localDayKey(e.ts);
    if (key !== lastDay) {
      lastDay = key;
      parts.push(`<div class="day" role="presentation">${esc(dayLabel(key, nowMs))}</div>`);
    }
    const t = tone(e.verdict);
    const never = e.neverEvent || e.reasonCode === "NEVER_EVENT";
    const summary = e.summary?.trim()
      ? `<div class="summary">${esc(e.summary.trim())}</div>`
      : "";
    const preview = e.diffPreview?.trim()
      ? `<details class="diff"><summary>Change preview</summary><pre>${esc(e.diffPreview.trim())}</pre></details>`
      : "";
    // Filter facets for the chip bar and dashboard: raw values (project is
    // attacker-controlled but esc() is attribute-safe); data-project is
    // omitted when there is none. data-tool is clipped to 60 chars and must
    // match the tool filter values stamped on dashboard rows. data-server is
    // the recognized MCP server label, omitted for non-MCP or unknown servers.
    const dataAttrs = filterDataAttrs(e, e.sessionId || "unknown");
    parts.push(`<article class="ev ${t}${never ? " never" : ""}" ${dataAttrs}>
  <div class="rail" aria-hidden="true"><span class="tick"></span></div>
  <div class="main">
    <div class="top">
      <span class="verdict">${esc(verdictWord(e.verdict))}</span>${modeBadge(e.mode)}
      <code class="tool">${esc(e.toolId)}</code>
      <time class="when" datetime="${esc(e.ts)}" title="${esc(e.ts)}">${esc(clock(e.ts))} <span class="rel">${esc(relativeTime(e.ts, nowMs))}</span></time>
    </div>
    ${summary}
    ${preview}
    <div class="meta">
      <span class="product">${esc(productLabel(e.product))}</span>
      <span class="dot">-</span>
      <span class="reason">${esc(e.reasonCode)}</span>${projectMeta(e.project)}
    </div>
  </div>
</article>`);
  }
  return parts.join("\n");
}

/** Worst-change pill tone, reusing the pill palette: allow ok, review amber, deny/never red. */
function changeWorstPill(worst: ToolWorst): string {
  const cls = worst === "allow" ? "ok" : worst === "review" ? "orr-amber" : "orr-red";
  return `<span class="pill ${cls}">${worst}</span>`;
}

/**
 * Changes tab body: session → file → chronological entries, each entry
 * carrying the same clipped preview the feed renders. Entries are stamped
 * with the full filter facet set (like feed articles) so the chip engine
 * filters them; file/session groups are collapsed client-side when every
 * entry inside is filtered out.
 */
function changesPanel(changes: ChangesModel, nowMs: number): string {
  if (changes.sessions.length === 0) {
    return `<p class="empty">No recorded changes yet - write/edit tool calls will show up here.</p>`;
  }
  return changes.sessions
    .map((s) => {
      const files = s.files
        .map((f) => {
          const entries = f.entries
            .map((e) => {
              const t = tone(e.verdict);
              const dataAttrs = filterDataAttrs(e, s.sessionId);
              return `      <div class="chg-entry ${t}${e.never ? " never" : ""}" ${dataAttrs}>
        <div class="top">
          <span class="verdict">${esc(verdictWord(e.verdict))}</span>${modeBadge(e.mode)}
          <code class="tool">${esc(e.toolId)}</code>
          <time class="when" datetime="${esc(e.ts)}" title="${esc(e.ts)}">${esc(clock(e.ts))} <span class="rel">${esc(relativeTime(e.ts, nowMs))}</span></time>
        </div>
        <details class="diff"><summary>Change preview</summary><pre>${esc(e.preview)}</pre></details>
      </div>`;
            })
            .join("\n");
          return `    <div class="chg-file">
      <div class="chg-file-head">
        <code class="path" title="${esc(f.path)}">${esc(clip(f.path, 80))}</code>
        <span class="cnt">${f.writes} write${f.writes === 1 ? "" : "s"}</span>
        ${changeWorstPill(f.worst)}
      </div>
${entries}
    </div>`;
        })
        .join("\n");
      return `  <div class="chg-session">
    <div class="chg-sess-head">
      <code class="sid" title="${esc(s.sessionId)}">${esc(clip(s.sessionId, 24))}</code>
      <span class="cnt">${s.fileCount} file${s.fileCount === 1 ? "" : "s"} · ${s.changeCount} change${s.changeCount === 1 ? "" : "s"}</span>
      <span class="rel">${esc(relativeTime(s.lastTs, nowMs))}</span>
    </div>
${files}
  </div>`;
    })
    .join("\n");
}

function identityLine(identity: KyaFileConfig | undefined): string {
  if (!identity) return "";
  const nameId =
    identity.agentName && identity.agentId
      ? `${identity.agentName}/${identity.agentId}`
      : (identity.agentName ?? identity.agentId);
  const bits = [nameId, identity.host, identity.baseUrl].filter(
    (b): b is string => typeof b === "string" && b.trim().length > 0,
  );
  if (bits.length === 0) return "";
  // baseUrl is inert text here - never an anchor.
  return `<div class="identity">${esc(clip(bits.join(" · "), 160))}</div>`;
}

function navItem(
  href: string,
  label: string,
  count: number | undefined,
  runningDot?: boolean,
): string {
  const countSpan = count !== undefined ? `<span class="nav-count">${count}</span>` : "";
  const dot = runningDot ? '<span class="status-dot" aria-hidden="true"></span>' : "";
  return `<a class="nav-link" id="tab-${href.slice(1)}" href="${href}">
  <span class="nav-label">${dot}${esc(label)}</span>
  ${countSpan}
</a>`;
}

function navGroup(label: string, runningDot?: boolean): string {
  const dot = runningDot ? '<span class="status-dot" aria-hidden="true"></span>' : "";
  return `<div class="nav-group">
  <span class="nav-group-label">${dot}${esc(label)}</span>
</div>`;
}

function navSubItem(href: string, label: string, count: number | undefined): string {
  const countSpan = count !== undefined ? `<span class="nav-count">${count}</span>` : "";
  return `<a class="nav-link nav-sub" id="tab-${href.slice(1)}" href="${href}">
  <span class="nav-label">${esc(label)}</span>
  ${countSpan}
</a>`;
}

function statChips(agg: EventAggregates): {
  modes: string;
  planes: string;
  products: string;
  projects: string;
  servers: string;
} {
  // Chips are filter toggles: native buttons keep identical styling via .stat.
  const chip = (label: string, n: number, group: string, value: string, cls = ""): string =>
    n > 0
      ? `<button type="button" class="stat${cls ? ` ${cls}` : ""}" data-fgroup="${group}" data-fvalue="${esc(value)}" aria-pressed="false" title="Filter: ${esc(label)}">${esc(label)}<b>${n}</b></button>`
      : "";
  const countRowChips = (rows: readonly CountRow[], ariaLabel: string, group: string): string =>
    rows.length >= 2
      ? `<div class="stats" aria-label="${ariaLabel}">${rows
          .map(
            (r) =>
              `<button type="button" class="stat" data-fgroup="${group}" data-fvalue="${esc(r.value ?? r.label)}" aria-pressed="false" title="Filter: ${esc(clip(r.label, 40))}">${esc(clip(r.label, 40))}<b>${r.count}</b></button>`,
          )
          .join("")}</div>`
      : "";
  return {
    modes:
      chip("Mode: observe", agg.modes.observe, "mode", "observe") +
      chip("Mode: hold", agg.modes.hold, "mode", "hold", "warn") +
      chip("Mode: offline", agg.modes.offline, "mode", "offline"),
    planes:
      chip("IDE", agg.planes.ide, "plane", "ide") +
      chip("Runtime", agg.planes.runtime, "plane", "runtime"),
    products: countRowChips(agg.products, "Products", "product"),
    projects: countRowChips(agg.projects, "Projects", "project"),
    servers: countRowChips(agg.servers, "Servers", "server"),
  };
}

function sessionsPanel(agg: EventAggregates, nowMs: number, changes: ChangesModel): string {
  if (agg.sessions.length === 0) return "";
  const filesBySession = new Map(changes.sessions.map((s) => [s.sessionId, s.fileCount]));
  // Rows are filter toggles on the same data-fgroup/data-fvalue contract as
  // the header chips and dashboard rows (see statChips).
  const rows = agg.sessions
    .map((s) => {
      const files = filesBySession.get(s.sessionId) ?? 0;
      const filesMeta =
        files > 0
          ? `<span class="cnt">${files} file${files === 1 ? "" : "s"} changed</span>`
          : "";
      return `<li>
      <button type="button" class="sess-item" data-fgroup="session" data-fvalue="${esc(s.sessionId)}" aria-pressed="false" title="Filter: session ${esc(clip(s.sessionId, 24))}">
        <span class="wdot ${s.worst}" title="worst verdict: ${s.worst}"></span>
        <code class="sid" title="${esc(s.sessionId)}">${esc(clip(s.sessionId, 24))}</code>
        <span class="cnt">${s.events} event${s.events === 1 ? "" : "s"}</span>
        ${filesMeta}
        <span class="rel">${esc(relativeTime(s.lastTs, nowMs))}</span>
      </button>
    </li>`;
    })
    .join("\n");
  return `<section class="panel" aria-label="Sessions">
  <h2>Sessions</h2>
  <ul class="rows">
${rows}
  </ul>
</section>`;
}

function reasonsPanel(agg: EventAggregates): string {
  if (agg.reasons.length === 0) return "";
  const chips = agg.reasons
    .map((r) => `<span class="chip"><code>${esc(clip(r.label, 60))}</code> × ${r.count}</span>`)
    .join("\n    ");
  return `<section class="panel" aria-label="Reasons">
  <h2>Reasons</h2>
  <div class="chiprow">
    ${chips}
  </div>
</section>`;
}

/** Worst-verdict → CSS var tone: never/deny are bad, review warns, allow is ok. */
function worstTone(worst: ToolWorst): "ok" | "warn" | "bad" {
  if (worst === "never" || worst === "deny") return "bad";
  if (worst === "review") return "warn";
  return "ok";
}

/**
 * Analytics dashboard: four cards in a 2×2 grid. Every data row except the
 * timeline is a filter toggle on the same data-fgroup/data-fvalue contract as
 * the header chips - the engine picks them up via the [data-fgroup] query.
 */
function dashboardPanel(db: Dashboard): string {
  if (db.verdictMix.total === 0) return "";
  const total = db.verdictMix.total;
  const pct = (n: number): number => Math.round((n / total) * 100);

  // Horizontal bar row that doubles as a feed filter. data-fvalue for tool
  // rows is clip(toolId, 60) to match the feed's data-tool attribute.
  const barRow = (
    label: string,
    group: string,
    value: string,
    widthPct: number,
    num: string,
    fill: "ok" | "warn" | "bad",
  ): string =>
    `<button type="button" class="db-item" data-fgroup="${group}" data-fvalue="${esc(value)}" aria-pressed="false" title="Filter: ${esc(clip(label, 40))}">
      <span class="db-label">${esc(clip(label, 40))}</span>
      <span class="db-bar"><span class="db-fill ${fill}" style="width:${widthPct}%"></span></span>
      <span class="db-num">${esc(num)}</span>
    </button>`;

  // Zero-count rows are hidden, consistent with the header chips.
  const mixRow = (
    label: string,
    group: string,
    value: string,
    count: number,
    fill: "ok" | "warn" | "bad",
  ): string =>
    count > 0 ? barRow(label, group, value, pct(count), `${pct(count)}%`, fill) : "";
  const mixCard = `<div class="db-card">
    <h3>Verdict mix</h3>
    ${mixRow("Allow", "verdict", "ALLOW", db.verdictMix.allow, "ok")}
    ${mixRow("Review", "verdict", "REQUIRE_APPROVE", db.verdictMix.review, "warn")}
    ${mixRow("Deny", "verdict", "DENY", db.verdictMix.deny, "bad")}
    ${mixRow("Never", "never", "1", db.verdictMix.never, "bad")}
  </div>`;

  const buckets = db.activity.buckets;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const tlCols = buckets
    .map((b) => {
      const h = b.count === 0 ? 0 : Math.max(6, Math.round((b.count / maxCount) * 100));
      return `<div class="col" title="${esc(b.label)} - ${b.count} event${b.count === 1 ? "" : "s"}"><span class="db-vbar" style="height:${h}%"></span><span class="lab">${esc(b.label)}</span></div>`;
    })
    .join("\n      ");
  const timelineCard = `<div class="db-card">
    <h3>Activity · ${db.activity.granularity === "hour" ? "hourly" : "daily"}</h3>
    ${
      buckets.length === 0
        ? `<p class="mute small">No parseable timestamps.</p>`
        : `<div class="db-tl">
      ${tlCols}
    </div>`
    }
  </div>`;

  const topCount = db.topTools[0]?.count ?? 1;
  const toolsCard = `<div class="db-card">
    <h3>Top tools</h3>
    ${db.topTools
      .map((t) =>
        barRow(
          t.toolId,
          "tool",
          clip(t.toolId, 60),
          Math.max(3, Math.round((t.count / topCount) * 100)),
          String(t.count),
          worstTone(t.worst),
        ),
      )
      .join("\n    ")}
  </div>`;

  const hotspotRows = (rows: readonly DashboardRow[], group: string): string => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return rows
      .map((r) =>
        barRow(
          r.label,
          group,
          r.value ?? r.label,
          Math.max(3, Math.round((r.count / max) * 100)),
          String(r.count),
          "bad",
        ),
      )
      .join("\n    ");
  };
  const hotspotsCard =
    db.productHotspots.length === 0 &&
    db.projectHotspots.length === 0 &&
    db.serverHotspots.length === 0
      ? ""
      : `<div class="db-card">
    <h3>Risk hotspots <span class="mute">deny + never</span></h3>
    ${db.productHotspots.length > 0 ? `<p class="sub">Products</p>\n    ${hotspotRows(db.productHotspots, "product")}` : ""}
    ${db.projectHotspots.length > 0 ? `<p class="sub">Projects</p>\n    ${hotspotRows(db.projectHotspots, "project")}` : ""}
    ${db.serverHotspots.length > 0 ? `<p class="sub">Servers</p>\n    ${hotspotRows(db.serverHotspots, "server")}` : ""}
  </div>`;

  return `<section class="panel" id="dashboard" aria-label="Analytics">
  <h2>Analytics</h2>
  <div class="db-grid">
  ${mixCard}
  ${timelineCard}
  ${toolsCard}
  ${hotspotsCard}
  </div>
</section>`;
}


function wiredHostsPanel(hosts: readonly WiredHostRow[] | undefined): string {
  if (!hosts || hosts.length === 0) return "";
  if (!hosts.some((h) => h.wired !== "none")) return "";
  const rank = (h: WiredHostRow): number =>
    h.wired !== "none" ? 0 : h.recipeOnly ? 1 : 2;
  const rows = [...hosts]
    .sort((a, b) => rank(a) - rank(b))
    .map((h) => {
      if (h.recipeOnly) {
        return `<li class="mute">${esc(h.label)} - manual setup <span class="hint" title="${esc(h.recipeOnly)}">docs recipe</span></li>`;
      }
      if (h.wired === "none") {
        return `<li class="mute">${esc(h.label)} - not wired</li>`;
      }
      const reload = h.reload ? ` · ${esc(h.reload.reload)}` : "";
      const running = h.running ? "running" : "not running";
      return `<li>${esc(h.label)} - wired (${h.wired})${reload} · ${running}</li>`;
    })
    .join("\n    ");
  return `<section class="panel" aria-label="Wired hosts">
  <h2>Wired hosts</h2>
  <ul class="rows">
    ${rows}
  </ul>
</section>`;
}

/**
 * System-tab gateway summary: a single status row that links to the dedicated
 * Gateway section. Detail lives in the Gateway pages so the System tab stays
 * focused on host/runtime state.
 */
function gatePanel(card: GateCard | undefined, nowMs: number): string {
  if (!card) return "";
  if (card.state === "not-set-up") {
    return `<section class="panel gate" aria-label="Gateway">
  <h2>Gateway</h2>
  <div class="orrline">
    <span class="pill">not set up</span>
    <span class="mute"><a href="#gateway-home">Open Gateway</a> to configure</span>
  </div>
</section>`;
  }
  const binary = card.binaryPresent
    ? `binary ${card.binaryVersion ? esc(clip(card.binaryVersion, 40)) : "installed"}`
    : "binary missing - kya gate setup";
  const uptime = card.startedAt ? ` · up since ${esc(relativeTime(card.startedAt, nowMs))}` : "";
  const pill =
    card.state === "running"
      ? `<span class="pill ok">running</span>`
      : `<span class="pill">stopped</span>`;
  const detail =
    card.state === "running"
      ? `${card.url ? `<code>${esc(clip(card.url, 60))}</code>` : ""}${uptime} · ${card.servers.length} server${card.servers.length === 1 ? "" : "s"} · ${card.events} event${card.events === 1 ? "" : "s"}`
      : `${card.servers.length} server${card.servers.length === 1 ? "" : "s"} configured · ${binary}`;
  return `<section class="panel gate" aria-label="Gateway">
  <h2>Gateway</h2>
  <div class="orrline">
    ${pill}
    <span class="mute">${detail}</span>
    <span class="mute"><a href="#gateway-home">Open Gateway</a></span>
  </div>
</section>`;
}

/**
 * Full Gateway dashboard for the #gateway zone. Extends the compact System-tab
 * panel with stat cards, listener details, targets table, policy cards, a dry-run
 * playground, quick actions, and a gateway-native events table. All user-controlled
 * values (server ids, commands, urls, tool names) are escaped.
 */
function gateStatusHeader(page: GatePage, nowMs: number): string {
  const listenerStatus =
    page.state === "running"
      ? `<span class="pill ok">running</span>`
      : `<span class="pill">stopped</span>`;
  const bindBadge = page.bindScope.loopbackOnly
    ? `<span class="pill ok" title="${esc(page.bindScope.detail)}">loopback-only</span>`
    : `<span class="pill warn" title="${esc(page.bindScope.detail)}">not loopback-only</span>`;
  const uptime = page.startedAt
    ? ` · up since <time datetime="${esc(page.startedAt)}">${esc(relativeTime(page.startedAt, nowMs))}</time>`
    : "";
  const urlLine = page.url ? ` <code>${esc(clip(page.url, 80))}</code>` : "";
  return `<div class="gate-status-header">
  <span class="gate-status-title">Gateway</span>
  <span class="gate-status-meta">${listenerStatus}${urlLine}${uptime} · ${bindBadge}</span>
</div>`;
}

function gateQuickActions(page: GatePage): string {
  const buttons =
    page.state === "not-set-up"
      ? `<button type="button" class="stat" data-action="doctor">Doctor</button>`
      : page.state === "configured-stopped"
        ? `<button type="button" class="stat ok" data-action="start">Start</button>
  <button type="button" class="stat" data-action="doctor">Doctor</button>`
        : `<button type="button" class="stat bad" data-action="stop">Stop</button>
  <button type="button" class="stat warn" data-action="restart">Restart</button>
  <button type="button" class="stat" data-action="doctor">Doctor</button>`;
  return `<div class="quick-actions">${buttons}</div><div id="gate-doctor-result"></div>`;
}

function gateStatCards(page: GatePage): string {
  const denyCount = page.gateEvents.filter(
    (e) => e.verdict.toUpperCase() === "DENY" || e.neverEvent || e.reasonCode === "NEVER_EVENT",
  ).length;
  return `<div class="stat-cards">
  <div class="stat-card">
    <span class="lab">Listeners</span>
    <span class="num">${page.listeners.length}</span>
  </div>
  <div class="stat-card">
    <span class="lab">Backends</span>
    <span class="num">${page.servers.length}</span>
  </div>
  <div class="stat-card">
    <span class="lab">Events</span>
    <span class="num">${page.gateEvents.length}</span>
  </div>
  <div class="stat-card">
    <span class="lab">Denies</span>
    <span class="num${denyCount > 0 ? " bad" : ""}">${denyCount}</span>
  </div>
</div>`;
}

function gateEventsTable(events: readonly TrailEvent[], nowMs: number): string {
  if (events.length === 0) {
    return `<div class="card">
  <h3>Gateway events</h3>
  <p class="empty small">No gateway events in this window.</p>
</div>`;
  }
  const rows = [...events]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 25)
    .map((e) => {
      const server = toolServerPrefix(e.toolId) ?? "";
      const tool = toolNameFromToolId(e.toolId) ?? e.toolId;
      const t = tone(e.verdict);
      const never = e.neverEvent || e.reasonCode === "NEVER_EVENT";
      return `      <tr>
        <td><time datetime="${esc(e.ts)}" title="${esc(e.ts)}">${esc(clock(e.ts))} <span class="rel">${esc(relativeTime(e.ts, nowMs))}</span></time></td>
        <td><a href="?f=server:${esc(mcpServerLabel(server))}#activity">${esc(server)}</a></td>
        <td><code>${esc(tool)}</code></td>
        <td><span class="pill ${t}${never ? " orr-red" : ""}">${esc(verdictWord(e.verdict))}${never ? " · never" : ""}</span></td>
      </tr>`;
    })
    .join("\n");
  return `<div class="card">
  <h3>Gateway events <span class="mute">latest 25</span></h3>
  <table class="tbl">
    <thead><tr><th>Time</th><th>Server</th><th>Tool</th><th>Verdict</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>`;
}

function gateHomePage(page: GatePage, nowMs: number): string {
  if (page.state === "not-set-up") {
    return `<section class="zone gate-zone" id="gateway-home" aria-labelledby="tab-gateway-home">
  ${gateStatusHeader(page, nowMs)}
  <p class="page-sub">Local MCP gate - every proxied tool call is evaluated and audited.</p>
  <div class="card">
    <span class="pill">not set up</span>
    <p class="line">${esc(GATE_NOT_SETUP_QUICKSTART)}</p>
    ${gateQuickActions(page)}
  </div>
</section>`;
  }
  return `<section class="zone gate-zone" id="gateway-home" aria-labelledby="tab-gateway-home">
  ${gateStatusHeader(page, nowMs)}
  <p class="page-sub">Local MCP gate - every proxied tool call is evaluated and audited.</p>
  ${gateStatCards(page)}
  <div class="card-grid">
    <div class="card">
      <h3>Listener</h3>
      <p class="line">${page.url ? `<code>${esc(clip(page.url, 80))}</code>` : `Listener port ${page.port ?? 3930}`} · ${page.state}</p>
      <p class="line">OTLP receiver port ${page.otlpPort}</p>
      <p class="line">Failure mode <span class="pill">${esc(page.failureMode)}</span></p>
      ${page.binaryPresent ? `<p class="line">Binary <code>${page.binaryVersion ? esc(clip(page.binaryVersion, 40)) : "installed"}</code></p>` : `<p class="line">Binary missing - <code>kya gate setup</code></p>`}
    </div>
    <div class="card">
      <h3>Quick actions</h3>
      ${gateQuickActions(page)}
    </div>
  </div>
  ${gateEventsTable(page.gateEvents, nowMs)}
</section>`;
}

function gateListenersPage(page: GatePage): string {
  const rows = page.listeners
    .map(
      (l) =>
        `      <tr>
        <td><span class="pill ${l.state === "running" ? "ok" : ""}">${esc(l.state)}</span></td>
        <td>${esc(l.name)}</td>
        <td>${esc(l.protocol)}</td>
        <td><code>${esc(l.address)}</code></td>
        <td>${l.uptime ? `<time datetime="${esc(l.uptime)}">${esc(relativeTime(l.uptime, Date.now()))}</time>` : '<span class="mute">-</span>'}</td>
        <td>${esc(l.detail ?? "")}</td>
      </tr>`,
    )
    .join("\n");
  return `<section class="zone gate-zone" id="gateway-listeners" aria-labelledby="tab-gateway-listeners">
  <h2 class="page-title">Listeners</h2>
  <p class="page-sub">MCP listener and OTLP receiver configured by the gateway.</p>
  <div class="card">
    <table class="tbl">
      <thead><tr><th>State</th><th>Name</th><th>Protocol</th><th>Address</th><th>Since</th><th>Detail</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>`;
}

function gateRoutesPage(page: GatePage): string {
  if (page.routes.length === 0) {
    return `<section class="zone gate-zone" id="gateway-routes" aria-labelledby="tab-gateway-routes">
  <h2 class="page-title">Routes</h2>
  <p class="page-sub">One route per configured backend server.</p>
  <div class="card">
    <p class="empty small">No servers configured - add one to .kya/gateways.json or run <code>kya gate init</code>.</p>
  </div>
</section>`;
  }
  const rows = page.routes
    .map((r) => {
      const dot = r.worst === "none" ? "" : `<span class="wdot ${r.worst}"></span>`;
      const denied =
        r.deniedTools.length === 0
          ? '<span class="mute">-</span>'
          : r.deniedTools.map((t) => `<span class="chip bad">${esc(t)}</span>`).join("");
      return `      <tr data-server="${esc(r.backendLabel)}">
        <td><code>${esc(r.pattern)}</code></td>
        <td>${esc(r.backendLabel)}</td>
        <td><span class="pill">${esc(r.tier ?? "unknown")}</span></td>
        <td>${r.denyCount}</td>
        <td>${dot} ${r.events}</td>
        <td>${denied}</td>
      </tr>`;
    })
    .join("\n");
  return `<section class="zone gate-zone" id="gateway-routes" aria-labelledby="tab-gateway-routes">
  <h2 class="page-title">Routes</h2>
  <p class="page-sub">One route per configured backend server. Pattern matches proxied tool calls.</p>
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Pattern</th><th>Backend</th><th>Tier</th><th>Deny patterns</th><th>Events</th><th>Denied tools</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>`;
}

function gateBackendsPage(page: GatePage): string {
  if (page.servers.length === 0) {
    return `<section class="zone gate-zone" id="gateway-backends" aria-labelledby="tab-gateway-backends">
  <h2 class="page-title">Backends</h2>
  <p class="page-sub">Configured upstream MCP servers.</p>
  <div class="card">
    <p class="empty small">No servers configured - add one to .kya/gateways.json or run <code>kya gate init</code>.</p>
  </div>
</section>`;
  }
  const rows = page.servers
    .map((s) => {
      const transport =
        s.transport === "stdio"
          ? `<code title="${esc(s.cmd?.join(" ") ?? "")}">${esc(clip(s.cmd?.join(" ") ?? s.transport, 60))}</code>`
          : `<code title="${esc(s.url ?? "")}">${esc(clip(s.url ?? s.transport, 60))}</code>`;
      const provenance = s.importedFrom.map((h) => `<span class="chip">${esc(h)}</span>`).join("");
      const dot = s.worst === "none" ? "" : `<span class="wdot ${s.worst}"></span>`;
      const denied =
        s.deniedTools.length === 0
          ? '<span class="mute">-</span>'
          : s.deniedTools.map((t) => `<span class="chip bad">${esc(t)}</span>`).join("");
      return `      <tr data-server="${esc(s.serverFacet)}">
        <td><span class="wdot ${s.worst === "none" ? "mute" : s.worst}"></span> <code>${esc(s.id)}</code></td>
        <td>${esc(s.transport)}</td>
        <td>${transport}</td>
        <td>${provenance}</td>
        <td><span class="pill">${esc(s.policy.defaultTier ?? "unknown")}</span></td>
        <td>${dot} ${s.events}</td>
        <td>${denied}</td>
      </tr>`;
    })
    .join("\n");
  return `<section class="zone gate-zone" id="gateway-backends" aria-labelledby="tab-gateway-backends">
  <h2 class="page-title">Backends</h2>
  <p class="page-sub">Configured upstream MCP servers and their connection details.</p>
  <div class="card">
    <table class="tbl targets-table">
      <thead><tr><th>Server</th><th>Transport</th><th>Target</th><th>Provenance</th><th>Policy</th><th>Events</th><th>Denied tools</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
</section>`;
}

function gatePoliciesPage(page: GatePage): string {
  const { policySummary } = page;
  const mixTotal =
    policySummary.verdicts.allow +
    policySummary.verdicts.deny +
    policySummary.verdicts.hold +
    policySummary.verdicts.never;
  const pct = (n: number): number => (mixTotal > 0 ? Math.round((n / mixTotal) * 100) : 0);
  const mixRow = (label: string, n: number, fill: "ok" | "warn" | "bad") =>
    n > 0
      ? `<div class="mix-row"><span class="mix-lab">${esc(label)}</span><span class="mix-bar"><span class="mix-fill ${fill}" style="width:${pct(n)}%"></span></span><span class="mix-num">${n}</span></div>`
      : "";
  const verdictMix = `<div class="card">
  <h3>Verdict mix</h3>
  ${mixRow("Allow", policySummary.verdicts.allow, "ok")}
  ${mixRow("Review", policySummary.verdicts.hold, "warn")}
  ${mixRow("Deny", policySummary.verdicts.deny, "bad")}
  ${mixRow("Never", policySummary.verdicts.never, "bad")}
  <p class="mute small">${mixTotal} gateway event${mixTotal === 1 ? "" : "s"} in this window</p>
</div>`;
  const denyCards =
    page.servers.length === 0
      ? '<div class="card"><h3>Per-server deny patterns</h3><p class="mute small">No servers configured.</p></div>'
      : page.servers
          .map(
            (s) =>
              `<div class="card">
  <h3><code>${esc(s.id)}</code> · ${s.policy.denyPatterns.length} pattern${s.policy.denyPatterns.length === 1 ? "" : "s"}</h3>
  ${s.policy.denyPatterns.length === 0 ? '<p class="mute small">No deny patterns - all tools observed.</p>' : `<pre><code>${esc(s.policy.denyPatterns.join("\n"))}</code></pre>`}
</div>`,
          )
          .join("\n");
  return `<section class="zone gate-zone" id="gateway-policies" aria-labelledby="tab-gateway-policies">
  <h2 class="page-title">Policies</h2>
  <p class="page-sub">Network rule, failure mode, and per-server deny patterns.</p>
  <div class="card-grid">
    <div class="card">
      <h3>Network rule</h3>
      <pre><code>${esc(policySummary.networkRule)}</code></pre>
      <h3>Failure mode</h3>
      <p class="line"><span class="pill">${esc(policySummary.failureMode)}</span></p>
      <p class="mute small">Total policies evaluated: ${policySummary.totalPolicies}</p>
    </div>
    ${verdictMix}
  </div>
  ${denyCards}
</section>`;
}

function gatePlaygroundPage(page: GatePage): string {
  const serverOptions = page.servers
    .map((s) => `<option value="${esc(s.id)}">${esc(s.id)}</option>`)
    .join("");
  const samples =
    page.playgroundSamples.length === 0
      ? ""
      : `<p class="mute small">Recent tools: ${page.playgroundSamples.map((t) => `<code>${esc(t)}</code>`).join(" ")}</p>`;
  return `<section class="zone gate-zone" id="gateway-playground" aria-labelledby="tab-gateway-playground">
  <h2 class="page-title">Playground</h2>
  <p class="page-sub">Dry-run a tool call against the generated policy - no tool is executed.</p>
  <div class="card">
    <form class="playground-form" id="gate-play-form">
      <label class="sr-only" for="gate-play-server">Server</label>
      <select id="gate-play-server" name="server" required>
        <option value="" disabled selected>Server</option>
        ${serverOptions}
      </select>
      <label class="sr-only" for="gate-play-tool">Tool</label>
      <input id="gate-play-tool" name="tool" type="text" placeholder="tool_name" required />
      <button type="submit" class="stat">Evaluate</button>
    </form>
    ${samples}
    <div id="gate-play-result"></div>
  </div>
</section>`;
}

function gatePagePanel(page: GatePage | undefined, nowMs: number): string {
  if (!page) {
    return `<section class="zone" id="gateway-home" aria-labelledby="tab-gateway-home">
    <p class="mute small zone-empty">Gateway details will appear here after setup.</p>
  </section>`;
  }
  return [
    gateHomePage(page, nowMs),
    page.state === "not-set-up" ? "" : gateListenersPage(page),
    page.state === "not-set-up" ? "" : gateRoutesPage(page),
    page.state === "not-set-up" ? "" : gateBackendsPage(page),
    page.state === "not-set-up" ? "" : gatePoliciesPage(page),
    page.state === "not-set-up" ? "" : gatePlaygroundPage(page),
  ].join("\n");
}

function sandboxesPanel(card: SandboxCard | undefined, nowMs: number): string {
  if (!card) return "";
  if (card.sandboxes.length === 0 && !card.backend) return "";
  const backend = card.backend
    ? `<p class="sub">Configured backend: <code>${esc(clip(card.backend, 40))}</code></p>`
    : "";
  const tbl =
    card.sandboxes.length === 0
      ? ""
      : `<table class="tbl">
    <thead><tr><th>id</th><th>backend</th><th>status</th><th>created</th></tr></thead>
    <tbody>
${card.sandboxes
  .map(
    (s) => `      <tr>
        <td><code title="${esc(s.sandboxId)}">${esc(clip(s.sandboxId, 20))}</code></td>
        <td>${esc(s.backend)}</td>
        <td><span class="pill ${s.status === "running" ? "ok" : "mute"}">${esc(s.status)}</span></td>
        <td>${esc(relativeTime(s.createdAt, nowMs))}</td>
      </tr>`,
  )
  .join("\n")}
    </tbody>
  </table>`;
  return `<section class="panel" aria-label="Sandboxes">
  <h2>Sandboxes</h2>
  ${backend}
  ${tbl}
</section>`;
}

function orrPanel(orr: OrrCard | undefined, nowMs: number): string {
  if (!orr) return "";
  const target = orr.targetName
    ? `<span class="mute">target ${esc(clip(orr.targetName, 60))}</span>`
    : "";
  const failure = orr.primaryFailureMode
    ? `<p class="line">Primary failure mode: ${esc(clip(orr.primaryFailureMode, 200))}</p>`
    : "";
  const fix = orr.mostUrgentFix
    ? `<p class="line">Most urgent fix: ${esc(clip(orr.mostUrgentFix, 200))}</p>`
    : "";
  const when = orr.generatedAt ? ` · ${esc(relativeTime(orr.generatedAt, nowMs))}` : "";
  return `<section class="panel" aria-label="ORR">
  <h2>Operational readiness</h2>
  <div class="orrline">
    <span class="pill orr-${esc(orr.overall)}">${esc(orr.overall)}</span>
    <span class="disp">${esc(orr.disposition.replace(/_/g, " "))}</span>
    ${target}
  </div>
  ${failure}
  ${fix}
  <p class="mute small">scorecards: ${orr.scorecards.pass} pass · ${orr.scorecards.fail} fail · ${orr.scorecards.partial} partial · ${orr.scorecards.notEvaluated} n/e${when}</p>
</section>`;
}

function usdText(usd: number | null): string {
  return usd === null ? "USD n/a" : `~$${usd.toFixed(2)}`;
}

/** KPI tile: big tabular number over a small caps label. The tone class is
 * only applied above zero - a zero count never reads as a signal. */
function kpiTile(label: string, value: string | number, cls = ""): string {
  const v = typeof value === "number" ? value : esc(value);
  const toned = typeof value === "number" && value > 0 && cls ? ` ${cls}` : "";
  return `<div class="kpi"><span class="kpi-num${toned}">${v}</span><span class="kpi-lab">${label}</span></div>`;
}

/**
 * Hero Certify panel: purpose-built rich card for the live Agent Trust
 * Baseline. The section carries the result state (`hero-certify pass|gap|
 * none`) for the accent border; an absent card is a fail-closed neutral
 * state that must never read as a pass.
 */
function heroCertifyPanel(certify: CertifyCard | undefined): string {
  if (!certify) {
    return `<section class="panel hero-certify none" aria-label="Certify">
  <h2>Certify - Agent Trust Baseline</h2>
  <div class="orrline">
    <span class="pill">not evaluated</span>
  </div>
  <p class="mute small">No live evaluation available - wrap tool calls and run kya certify to build the baseline.</p>
</section>`;
  }
  const state = certify.result === "pass" ? "pass" : "gap";
  // Status legend as a definition list so each counter is explained on first
  // glance, not hidden in a dense sentence.
  const legend = `<dl class="cert-legend">
    <div><dt>Gap</dt><dd>requirement is failing - this is your work plan</dd></div>
    <div><dt>Insufficient</dt><dd>not enough local evidence to evaluate (never counts as a pass)</dd></div>
    <div><dt>Attested</dt><dd>your signed statement, unverified until audited</dd></div>
  </dl>`;
  // Attested summary: the hero's gap rows are gap-status only, so attestations
  // surface as one line naming the first attested requirement (+N more) with
  // its attestation text.
  const firstAttested = certify.requirements.find((r) => r.status === "attested");
  const attestedLine =
    certify.attested === 0
      ? ""
      : firstAttested
        ? `<div class="att-line">attested: <code>${esc(firstAttested.id)}</code>${
            certify.attested > 1 ? ` (+${certify.attested - 1} more)` : ""
          } - "${expandableText(
            "att-quote",
            firstAttested.attestation?.text ?? firstAttested.evidence,
            100,
          )}"</div>`
        : `<p class="att-line">attested: ${certify.attested} - your signed statement, unverified</p>`;
  // topGaps arrives severity-ordered from the loader; cap defensively at 5.
  // Each gap is an expandable <details> row: summary stays compact, the body
  // reveals the full requirement title, what the status means, the unclipped
  // evidence, and the exact CLI command to close the gap.
  const gaps =
    certify.topGaps.length === 0
      ? ""
      : `<div class="cert-rows">
${certify.topGaps
  .slice(0, 5)
  .map((g) => {
    const cmd = `kya certify --attest ${g.id} --text "…"`;
    return `    <details class="req-row">
      <summary><code>${esc(g.id)}</code> - ${esc(g.title)} <span class="sev ${esc(g.severity)}">${esc(g.severity)}</span></summary>
      <div class="req-body">
        <p class="req-mean">Gap means this requirement is currently failing against the local evidence in the ${certify.windowDays}-day window.</p>
        ${g.evidence ? `<p class="req-evi"><strong>Evidence:</strong> ${esc(g.evidence)}</p>` : ""}
        <p class="req-cta"><strong>Close it:</strong> <code>${esc(cmd)}</code> <span class="req-hint">(replace "…" with your accountable statement or fix the underlying control)</span></p>
      </div>
    </details>`;
  })
  .join("\n")}
  </div>`;
  // Call-to-action: one primary command and one secondary link to the detail tab.
  const cta = `<div class="cert-cta">
    <a class="btn" href="#certify">Open full requirement table</a>
    <span class="mute small">or run <code>kya certify --open</code> for the signed bundle</span>
  </div>`;
  // Pill tones reuse the ORR palette: pass is green, gap is amber.
  return `<section class="panel hero-certify ${state}" aria-label="Certify">
  <h2>Certify - Agent Trust Baseline</h2>
  <div class="orrline">
    <span class="pill orr-${state === "pass" ? "green" : "amber"}">${esc(certify.result)}</span>
  </div>
  <div class="kpi-row">
    ${kpiTile("Pass", certify.pass, "ok")}
    ${kpiTile("Gap", certify.gap, "warn")}
    ${kpiTile("Insufficient", certify.insufficientEvidence, "mute")}
    ${kpiTile("Attested", certify.attested, "mute")}
  </div>
  ${legend}
  ${attestedLine}
  ${gaps}
  ${cta}
  <p class="mute small">live evaluation - window ${certify.windowDays}d, ${certify.trailEvents} trail events · the Certify tab has the complete gap report · <code>kya certify</code> writes the signed evidence bundle</p>
</section>`;
}

/** Detail-table pill tones, reusing the existing pill/tone system: pass is
 * green, gap is amber, insufficient evidence keeps the neutral mute default,
 * attested gets the neutral-foreground .att tone. */
const DETAIL_PILL_TONE: Record<RequirementStatus, string> = {
  pass: "ok",
  gap: "orr-amber",
  insufficient_evidence: "",
  attested: "att",
};

const CERTIFY_DETAIL_CLIP = 160;

/**
 * Long evidence/attestation text renders in full behind a Read more toggle;
 * at or under the preview length it stays a plain inline span. The preview
 * keeps the old clip length, so collapsed rows look exactly as before.
 */
function expandableText(cls: string, text: string, previewLen = CERTIFY_DETAIL_CLIP): string {
  const clean = stripEscapes(text).replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ").trim();
  if (clean.length <= previewLen) return `<span class="${cls}">${esc(clean)}</span>`;
  return `<details class="req-more ${cls}"><summary>${esc(
    clip(clean, previewLen),
  )}</summary><div class="full">${esc(clean)}</div></details>`;
}

/**
 * Certify tab body: the full live requirement table - every evaluated
 * requirement grouped by domain, domains in catalog order (the card's
 * requirements arrive in catalog order, so first-seen order IS the catalog
 * order). Each domain gets a heading row with mini-counts, then one row per
 * requirement: status pill, id, title, and a muted evidence line beneath -
 * or the attestation text for attested rows. Empty input yields "" so the
 * caller falls back to the zone-empty hint (fail-closed: no table without
 * data).
 */
function certifyDetailPanel(
  requirements: readonly CertifyRequirementResult[],
): string {
  if (requirements.length === 0) return "";
  const sections = domainOrder(requirements)
    .map((domain) => {
      const rows = requirements.filter((r) => r.domain === domain);
      const counts = { pass: 0, gap: 0, insufficient: 0, attested: 0 };
      for (const r of rows) {
        if (r.status === "pass") counts.pass++;
        else if (r.status === "gap") counts.gap++;
        else if (r.status === "attested") counts.attested++;
        else counts.insufficient++;
      }
      const items = rows
        .map((r) => {
          const tone = DETAIL_PILL_TONE[r.status];
          const pill = `<span class="pill${tone ? ` ${tone}` : ""}">${esc(
            r.status.replace(/_/g, " "),
          )}</span>`;
          const detail = r.attestation
            ? expandableText("att", `attested ${r.attestation.at} - "${r.attestation.text}"`)
            : r.evidence
              ? expandableText("evi", r.evidence)
              : "";
          return `      <li>${pill} <code>${esc(r.id)}</code> - ${esc(r.title)}${detail}</li>`;
        })
        .join("\n");
      const label = DOMAIN_LABELS[domain] ?? domain;
      return `  <section class="dom" aria-label="${esc(label)}">
    <div class="dom-head"><h3>${esc(label)}</h3><span class="cnt">${counts.pass} pass · ${counts.gap} gap · ${counts.insufficient} insufficient · ${counts.attested} attested</span></div>
    <ul class="rows">
${items}
    </ul>
  </section>`;
    })
    .join("\n");
  return `<section class="panel certify-detail" aria-label="Certify detail">
  <h2>Every requirement - live evaluation</h2>
${sections}
</section>`;
}

/** Hero KPI cards: compact, non-interactive rollups (filters live in the
 * Activity zone's chip bar). Numbers keep tabular-nums via .mix-num/.kpi-num. */
function verdictsHeroCard(
  c: {
    readonly allow: number;
    readonly deny: number;
    readonly require: number;
    readonly never: number;
  },
  total: number,
): string {
  // Base 100% = total events, matching dashboard.ts's verdictMix contract:
  // verdict is a free-form string from untrusted JSONL, so an event may land
  // in no bucket (bogus verdict) while still counting in `never` - only the
  // raw event count keeps every bar inside the base the Overview card uses.
  const pct = (n: number): number => (total > 0 ? Math.round((n / total) * 100) : 0);
  const mixRow = (label: string, n: number, fill: "ok" | "warn" | "bad"): string =>
    `<div class="mix-row"><span class="mix-lab">${label}</span><span class="mix-bar"><span class="mix-fill ${fill}" style="width:${pct(n)}%"></span></span><span class="mix-num">${n}</span></div>`;
  return `<section class="panel" aria-label="Verdicts">
  <h2>Verdicts</h2>
  <div class="mix">
    ${mixRow("Allow", c.allow, "ok")}
    ${mixRow("Deny", c.deny, "bad")}
    ${mixRow("Review", c.require, "warn")}
    ${mixRow("Never", c.never, "bad")}
  </div>
</section>`;
}

const SPARK_BARS = 7;
const SPARK_H = 24;

/**
 * Inline 7-bar sparkline (no JS): the last 7 activity buckets, left-padded
 * with zeros, heights normalized so the max bucket is full height. Empty
 * input renders a flat baseline - heights are guarded, never NaN/Infinity.
 */
function activitySparkline(activity: Dashboard["activity"]): string {
  const counts = activity.buckets.slice(-SPARK_BARS).map((b) => b.count);
  while (counts.length < SPARK_BARS) counts.unshift(0);
  const max = Math.max(0, ...counts);
  const rects = counts
    .map((n, i) => {
      const h = max > 0 ? Math.round((n / max) * SPARK_H) : 0;
      return `<rect x="${i * 10}" y="${SPARK_H - h}" width="8" height="${h}" rx="1"></rect>`;
    })
    .join("");
  const unit = activity.granularity === "hour" ? "hours" : "days";
  return `<svg class="spark" viewBox="0 0 68 ${SPARK_H}" role="img" aria-label="Activity, last ${SPARK_BARS} ${unit}">${rects}<line class="base" x1="0" y1="${SPARK_H - 0.5}" x2="68" y2="${SPARK_H - 0.5}"></line></svg>`;
}

function activityHeroCard(agg: EventAggregates, db: Dashboard, total: number): string {
  return `<section class="panel" aria-label="Activity">
  <h2>Activity</h2>
  <div class="kpi-row">
    ${kpiTile("Events", total)}
  </div>
  ${activitySparkline(db.activity)}
  <p class="mute small">observe ${agg.modes.observe} · hold ${agg.modes.hold} · offline ${agg.modes.offline} · IDE ${agg.planes.ide} · runtime ${agg.planes.runtime}</p>
</section>`;
}

/** Hero-styled showback: same fields as the old panel (tokens in/out, est.
 * USD, top runs, disclaimer), omitted entirely when no report exists. When
 * window events carry host-reported token usage, a line states how much of
 * the total is real vs the static per-event estimate. */
function showbackHeroCard(
  report: ShowbackReport | undefined,
  events: readonly TrailEvent[] = [],
): string {
  if (!report) return "";
  const usage = summarizeTrailUsage(events);
  const realLine =
    usage.realUsageEvents === 0
      ? ""
      : `<p class="mute small">real host-reported usage on ${usage.realUsageEvents} of ${usage.events} window events (${usage.realTokensIn} in / ${usage.realTokensOut} out tokens); the rest is priced at the static estimate</p>`;
  const topRuns = [...report.perRun]
    .sort((a, b) => (b.estimatedUsd ?? -1) - (a.estimatedUsd ?? -1))
    .slice(0, 5);
  const runs =
    topRuns.length === 0
      ? ""
      : `<ul class="rows">
${topRuns
  .map(
    (r) => `    <li><code title="${esc(r.runId)}">${esc(clip(r.runId, 32))}</code> - ${r.steps} step${r.steps === 1 ? "" : "s"} · ${esc(usdText(r.estimatedUsd))}</li>`,
  )
  .join("\n")}
  </ul>`;
  return `<section class="panel" aria-label="Showback">
  <h2>Showback (observe only)</h2>
  <div class="kpi-row">
    ${kpiTile("Tokens in", report.totalTokensIn)}
    ${kpiTile("Tokens out", report.totalTokensOut)}
    ${kpiTile("Est. USD", usdText(report.estimatedUsd))}
  </div>
  ${runs}
  ${realLine}
  <p class="mute small">${esc(SHOWBACK_DISCLAIMER)}</p>
</section>`;
}

export function gatewayHeroCard(page: GatePage | undefined, _nowMs: number): string {
  if (!page) return "";

  const statePill =
    page.state === "running"
      ? `<span class="pill ok">running</span>`
      : page.state === "not-set-up"
        ? `<span class="pill">not set up</span>`
        : `<span class="pill">stopped</span>`;

  const binary = page.binaryPresent
    ? `binary ${page.binaryVersion ? esc(clip(page.binaryVersion, 40)) : "installed"}`
    : "binary missing - kya gate setup";

  const detail =
    page.state === "running"
      ? `${page.url ? `<code>${esc(clip(page.url, 60))}</code>` : `port ${page.port ?? 3930}`} · ${page.listeners.length} listener${page.listeners.length === 1 ? "" : "s"} · ${page.servers.length} backend${page.servers.length === 1 ? "" : "s"}`
      : `${page.servers.length} backend${page.servers.length === 1 ? "" : "s"} configured · ${binary}`;

  const denyCount = page.gateEvents.filter(
    (e) => e.verdict.toUpperCase() === "DENY" || e.neverEvent || e.reasonCode === "NEVER_EVENT",
  ).length;

  return `<section class="panel" aria-label="Gateway">
  <h2>Gateway</h2>
  <div class="orrline">
    ${statePill}
    <span class="mute">${detail}</span>
  </div>
  <div class="kpi-row">
    ${kpiTile("Listeners", page.listeners.length)}
    ${kpiTile("Backends", page.servers.length)}
    ${kpiTile("Events", page.gateEvents.length)}
    ${kpiTile("Denies", denyCount, denyCount > 0 ? "bad" : "")}
  </div>
  <p class="mute small"><a href="#gateway-home">Open Gateway</a></p>
</section>`;
}

/**
 * Hero Import card: per-format rollup of imported trace events. Hidden when
 * the trail has no host "import" events (fresh installs render unchanged).
 */
function importHeroCard(card: ImportCard | undefined, nowMs: number): string {
  if (!card) return "";
  const chips = card.formats
    .map(
      (f) =>
        `<span class="chip"><code>${esc(f.format)}</code> × ${f.imported}${f.errors > 0 ? ` · ${f.errors} err` : ""}</span>`,
    )
    .join("\n    ");
  const last = card.lastTs ? `latest imported event ${esc(relativeTime(card.lastTs, nowMs))} · ` : "";
  return `<section class="panel" aria-label="Import">
  <h2>Import</h2>
  <div class="kpi-row">
    ${kpiTile("Imported", card.total)}
    ${kpiTile("Errors", card.errors, "bad")}
  </div>
  <div class="chiprow">
    ${chips}
  </div>
  <p class="mute small">${last}add more with <code>kya import --from langsmith|langfuse|phoenix|otel FILE</code></p>
</section>`;
}

/** Severity pill tone for investigate findings, reusing the pill palette. */
function severityPill(severity: string): string {
  const cls = severity === "critical" ? " orr-red" : severity === "high" ? " orr-amber" : "";
  return `<span class="pill${cls}">${esc(severity)}</span>`;
}

/**
 * Hero Investigations card: the persisted summary of the last kya investigate
 * run. Hidden when no summary file exists; a clean run (zero findings) still
 * renders, since the run itself is the data.
 */
function investigateHeroCard(card: InvestigateLastRun | undefined, nowMs: number): string {
  if (!card) return "";
  const findingCount = card.findings.reduce((n, f) => n + f.count, 0);
  const rows =
    card.findings.length === 0
      ? `<p class="line">No findings - the trail looks clean for all detectors.</p>`
      : `<ul class="rows">
${card.findings
  .map(
    (f) =>
      `    <li>${severityPill(f.severity)} <code>${esc(f.detectorId)}</code> - ${esc(f.title)} <span class="cnt">× ${f.count}</span></li>`,
  )
  .join("\n")}
  </ul>`;
  const brief = card.briefSnippet
    ? `<details class="diff"><summary>Top fix brief</summary><pre>${esc(card.briefSnippet)}</pre></details>`
    : "";
  return `<section class="panel" aria-label="Investigations">
  <h2>Investigations</h2>
  <div class="kpi-row">
    ${kpiTile("Findings", findingCount, findingCount > 0 ? "warn" : "")}
    ${kpiTile("Incidents", card.incidents, card.incidents > 0 ? "warn" : "")}
  </div>
  ${rows}
  ${brief}
  <p class="mute small">ran ${esc(relativeTime(card.ranAt, nowMs))} · window ${card.windowDays}d · <code>kya investigate</code> for the full report</p>
</section>`;
}

/**
 * System-tab Alerts panel: per-target delivery rollup from the notify ledger.
 * Hidden when no delivery has been attempted yet.
 */
function alertsPanel(card: NotifyLogSummary | undefined, nowMs: number): string {
  if (!card) return "";
  const rows = card.targets
    .map((t) => {
      const status = t.lastOk
        ? `<span class="pill ok">delivered</span>`
        : `<span class="pill orr-red">failed</span>`;
      const detail = t.lastDetail ? ` <span class="mute">${esc(t.lastDetail)}</span>` : "";
      return `      <tr>
        <td><code>${esc(t.target)}</code></td>
        <td>${t.delivered}</td>
        <td>${t.failed}</td>
        <td><time datetime="${esc(t.lastTs)}" title="${esc(t.lastTs)}">${esc(relativeTime(t.lastTs, nowMs))}</time></td>
        <td>${status}${detail}</td>
      </tr>`;
    })
    .join("\n");
  return `<section class="panel" aria-label="Alerts">
  <h2>Alerts</h2>
  <table class="tbl">
    <thead><tr><th>Target</th><th>Delivered</th><th>Failed</th><th>Last attempt</th><th>Status</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="mute small">webhook deliveries for DENY / REQUIRE_APPROVE verdicts · configure <code>notify.webhooks</code> in .kya/config.json</p>
</section>`;
}

/**
 * System-tab OTel panel: persisted OTLP export counters. Hidden until the
 * first export attempt lands in .kya/otel-stats.json.
 */
function otelPanel(stats: OtelStats | undefined, nowMs: number): string {
  if (!stats) return "";
  const endpoint = stats.endpoint ? `<code>${esc(stats.endpoint)}</code>` : '<span class="mute">unknown endpoint</span>';
  const last = stats.lastExportAt
    ? `last export ${esc(relativeTime(stats.lastExportAt, nowMs))} · `
    : "";
  return `<section class="panel" aria-label="OTel export">
  <h2>OTel export</h2>
  <div class="orrline">${endpoint}</div>
  <div class="kpi-row">
    ${kpiTile("Spans sent", stats.spansSent)}
    ${kpiTile("Spans failed", stats.spansFailed, "bad")}
  </div>
  <p class="mute small">${last}configure <code>otlpExport.endpoint</code> in .kya/config.json or KYA_OTLP_EXPORT_ENDPOINT</p>
</section>`;
}

/**
 * Defensive normalization for untrusted trail fields before rendering.
 * clip() flattens newlines (single-line contexts: code spans, headers);
 * diffPreview keeps them via clipMultiline so <pre>/fenced diffs survive.
 */
function normalizeTrailEvents(events: readonly TrailEvent[]): TrailEvent[] {
  return events.map((e) => ({
    ...e,
    toolId: clip(e.toolId, 160),
    reasonCode: clip(e.reasonCode, 80),
    summary: e.summary ? clip(e.summary, 120) : undefined,
    diffPreview: e.diffPreview ? clipMultiline(e.diffPreview, DIFF_MAX_TOTAL_CHARS) : undefined,
    targetPath: e.targetPath ? clip(e.targetPath, 80) : undefined,
  }));
}

export interface FeedFilters {
  readonly [group: string]: readonly string[];
}

export interface FeedPageResult {
  readonly feedHtml: string;
  readonly paginationHtml: string;
  readonly total: number;
  readonly page: number;
  readonly pages: number;
}

export function renderFeedPage(
  events: readonly TrailEvent[],
  filters: FeedFilters,
  page: number,
  nowMs: number,
  live: boolean,
  query?: string,
  embeddings?: ReadonlyMap<string, number[]>,
  queryEmbedding?: number[],
): FeedPageResult {
  const q = query?.trim();
  let ordered: TrailEvent[];
  let total: number;
  if (q) {
    const ranked = rankEvents(events, {
      query: q,
      filters,
      embeddings,
      queryEmbedding,
      facetBoost: 0.05,
    });
    ordered = ranked.map((r) => r.event);
    total = ranked.length;
  } else {
    const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts));
    ordered = applyChipFilters(sorted, filters);
    total = ordered.length;
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = clampPage(page, pages);
  const start = (p - 1) * PAGE_SIZE;
  const pageEvents = ordered.slice(start, start + PAGE_SIZE);

  return {
    feedHtml: renderFeed(pageEvents, nowMs, live, !!q),
    paginationHtml: paginationBar(total, p, pages),
    total,
    page: p,
    pages,
  };
}

function paginationBar(total: number, page: number, pages: number): string {
  if (pages <= 1 && total === 0) {
    return `<div class="pagination-bar"><span class="mute">${total} events</span></div>`;
  }
  if (pages <= 1) {
    return `<div class="pagination-bar"><span class="mute">Page ${page} of ${pages} · ${total} event${total === 1 ? "" : "s"}</span></div>`;
  }

  const prev = `<button type="button" class="stat" data-page="prev" ${page <= 1 ? "disabled" : ""}>Previous</button>`;
  const next = `<button type="button" class="stat" data-page="next" ${page >= pages ? "disabled" : ""}>Next</button>`;

  const maxWindow = 7;
  let startPage = Math.max(1, page - Math.floor(maxWindow / 2));
  let endPage = Math.min(pages, startPage + maxWindow - 1);
  if (endPage - startPage + 1 < maxWindow) {
    startPage = Math.max(1, endPage - maxWindow + 1);
  }

  const numbers: string[] = [];
  for (let i = startPage; i <= endPage; i++) {
    const active = i === page ? " active" : "";
    numbers.push(`<button type="button" class="stat${active}" data-page="${i}" ${i === page ? "disabled" : ""}>${i}</button>`);
  }

  return `<div class="pagination-bar">\n  ${prev}\n  ${numbers.join("\n  ")}\n  ${next}\n  <span class="mute">Page ${page} of ${pages} · ${total} event${total === 1 ? "" : "s"}</span>\n</div>`;
}

export function renderReceiptHtml(model: ReceiptModel): string {
  const nowMs = Date.now();
  const events = normalizeTrailEvents(model.events);
  // Pagination + live filtering are only meaningful when the report is served
  // by the loopback live server (liveToken present). Static on-disk artifacts
  // render the full event list so nothing is hidden behind inactive buttons.
  const livePaged = !!model.liveToken;
  const currentPage = livePaged
    ? clampPage(model.page ?? 1, Math.max(1, Math.ceil(events.length / PAGE_SIZE)))
    : 1;
  const initialFeed = livePaged
    ? renderFeedPage(events, {}, currentPage, nowMs, model.live ?? false, model.searchQuery)
    : {
        feedHtml: renderFeed(events, nowMs, model.live ?? false),
        paginationHtml: `<div class="pagination-bar"><span class="mute">${events.length} event${events.length === 1 ? "" : "s"}</span></div>`,
        total: events.length,
        page: 1,
        pages: 1,
      };

  const c = countVerdicts(events);
  const agg = aggregateEvents(events);
  const chips = statChips(agg);
  const dashboard = computeDashboard(events);
  const changes = buildChangesModel(events);
  const blocked = events.filter((e) => e.neverEvent || e.reasonCode === "NEVER_EVENT");
  const tools =
    model.mcpSeen && model.mcpSeen.length > 0
      ? model.mcpSeen.map((m) => m.toolId)
      : [...new Set(events.map((e) => e.toolId))];

  const blockedBanner =
    blocked.length === 0
      ? ""
      : `<aside class="alert" aria-label="Blocked never-events">
  <strong>${blocked.length} blocked</strong>
  <span>${blocked.map((e) => `<code>${esc(e.toolId)}</code>`).join(" ")}</span>
</aside>`;

  const toolsHtml =
    tools.length === 0
      ? ""
      : `<footer class="tools">
  <span class="label">Tools</span>
  ${tools.map((t) => `<code>${esc(t)}</code>`).join("")}
</footer>`;

  // liveToken is minted base64url by the live server - safe in a JS string
  // literal; static renders omit it. No post-hoc html.replace (spoofable).
  const eventsUrl = model.liveToken ? `/events?t=${encodeURIComponent(model.liveToken)}` : "/events";
  const liveScript = model.live
    ? `<script>
(function(){
  var pill = document.querySelector('.live');
  var es = new EventSource('${eventsUrl}');
  es.onmessage = function(){ location.reload(); };
  es.onerror = function(){
    if (pill) { pill.textContent = 'Offline'; pill.classList.add('off'); }
  };
})();
</script>`
    : "";

  // Client-side chip filters, pagination, and search: only emitted for live
  // reports (liveToken present). Static receipts render a separate BM25-only
  // search script below. State maps are null-prototype: attacker-controlled
  // values (project names) must never resolve via Object.prototype. The id lets
  // tests extract just this script. KNOWN is space-delimited so
  // `indexOf(' '+g+' ')` doubles as a prototype-safe whitelist ('constructor'
  // etc. never match). Filter state persists in the ?f= QUERY param, not the
  // hash: the hash is owned by the pure-CSS :target tabs, so a hash-based
  // filter would hide the Activity zone on every chip toggle. Legacy #f= hashes
  // are still parsed on load (read-only); the next save writes the ?f= form and
  // drops the legacy fragment.
  const filterScript = model.liveToken
    ? `<script id="kya-filters">
(function(){
  var feed = document.getElementById('feed');
  if (!feed) return;
  var chg = document.getElementById('changes-list');
  var bar = document.getElementById('pagination-bar');
  var searchInput = document.getElementById('feed-search');
  var searchMeta = document.querySelector('.feed-search-meta');
  var KNOWN = ' verdict never mode plane product project tool session server ';
  var state = Object.create(null);
  var page = 1;
  var q = '';
  var LIVE = !!(document.querySelectorAll && document.querySelectorAll('main[data-live-token]').length);
  var clearBtn = document.getElementById('clear-filters');
  var chips = document.querySelectorAll('[data-fgroup]');
  function readToken(){
    var s = location.search;
    if (s.indexOf('?') !== 0) return '';
    var params = s.slice(1).split('&');
    for (var i = 0; i < params.length; i++) {
      if (params[i].indexOf('t=') === 0) {
        try { return decodeURIComponent(params[i].slice(2)); } catch(e){ return params[i].slice(2); }
      }
    }
    return '';
  }
  function parse(){
    state = Object.create(null);
    page = 1;
    q = '';
    var raw = null;
    var s = location.search;
    if (s.indexOf('?') === 0) {
      var params = s.slice(1).split('&');
      for (var i = 0; i < params.length; i++) {
        if (raw === null && params[i].indexOf('f=') === 0) { raw = params[i].slice(2); }
        else if (params[i].indexOf('q=') === 0) {
          try { q = decodeURIComponent(params[i].slice(2).replace(/\\+/g, ' ')); } catch(e){ q = params[i].slice(2); }
        }
        else if (params[i].indexOf('page=') === 0) {
          var p = parseInt(params[i].slice(5), 10);
          if (p > 0) page = p;
        }
      }
    }
    if (raw === null) {
      var legacy = location.hash;
      if (legacy.indexOf('#f=') === 0) raw = legacy.slice(3);
    }
    if (raw === null) return;
    raw.split(',').forEach(function(seg){
      var i = seg.indexOf(':');
      if (i < 1) return;
      var g = seg.slice(0, i);
      if (!/^[a-z]+$/.test(g) || KNOWN.indexOf(' ' + g + ' ') < 0) return;
      var v;
      try { v = decodeURIComponent(seg.slice(i + 1)); } catch (e) { return; }
      if (!v) return;
      (state[g] || (state[g] = Object.create(null)))[v] = true;
    });
  }
  function save(){
    var parts = [];
    Object.keys(state).forEach(function(g){
      Object.keys(state[g]).forEach(function(v){ parts.push(g + ':' + encodeURIComponent(v)); });
    });
    // Rebuild the query rather than overwrite it: the live page carries its
    // loopback token as ?t= and must not lose it on a chip toggle.
    var kept = [];
    var s = location.search;
    if (s.indexOf('?') === 0) {
      var params = s.slice(1).split('&');
      for (var i = 0; i < params.length; i++) {
        if (params[i] && params[i].indexOf('f=') !== 0 && params[i].indexOf('q=') !== 0 && params[i].indexOf('page=') !== 0) kept.push(params[i]);
      }
    }
    if (parts.length) kept.push('f=' + parts.join(','));
    if (q) kept.push('q=' + encodeURIComponent(q));
    if (page > 1) kept.push('page=' + page);
    var qq = kept.length ? '?' + kept.join('&') : '';
    var h = location.hash.indexOf('#f=') === 0 ? '' : location.hash;
    history.replaceState(null, '', location.pathname + qq + h);
  }
  function active(){
    return Object.keys(state).some(function(g){ return Object.keys(state[g]).length > 0; }) || !!q;
  }
  // AND across groups, OR within a group; an unstamped facet never matches.
  function rowVisible(row, on){
    if (!on) return true;
    for (var g in state) {
      var val = row.getAttribute('data-' + g);
      if (val === null || !state[g][val]) return false;
    }
    return true;
  }
  function apply(){
    var on = Object.keys(state).some(function(g){ return Object.keys(state[g]).length > 0; });
    // Feed rows: filter client-side immediately so the UI reacts without
    // waiting for the server round-trip. For live/paginated reports the server
    // still returns the authoritative page via feedUpdate(), but this keeps
    // the Activity tab responsive and survives SSE reloads that would otherwise
    // overwrite the server response before the user sees it.
    var toggled = 0;
    feed.querySelectorAll('.ev').forEach(function(row){
      var visible = rowVisible(row, on);
      if (!visible) toggled++;
      row.classList.toggle('filtered-out', !visible);
    });
    try { window.__kyaFilterDebug = { toggled: toggled, feedRows: feed.querySelectorAll('.ev').length }; } catch(e){}
    var day = null, dayHasRows = false;
    function flush(){ if (day) day.classList.toggle('filtered-out', on && !dayHasRows); }
    for (var i = 0; i < feed.children.length; i++) {
      var el = feed.children[i];
      if (el.classList.contains('day')) { flush(); day = el; dayHasRows = false; }
      else if (el.classList.contains('ev') && !el.classList.contains('filtered-out')) dayHasRows = true;
    }
    flush();
    // Changes tab: entries filter individually; file/session groups collapse
    // when no entry inside survives.
    if (chg) {
      chg.querySelectorAll('.chg-entry').forEach(function(row){
        row.classList.toggle('filtered-out', !rowVisible(row, on));
      });
      chg.querySelectorAll('.chg-file, .chg-session').forEach(function(group){
        var vis = group.querySelectorAll('.chg-entry:not(.filtered-out)').length > 0;
        group.classList.toggle('filtered-out', on && !vis);
      });
    }
    chips.forEach(function(chip){
      var pressed = !!(state[chip.dataset.fgroup] && state[chip.dataset.fgroup][chip.dataset.fvalue]);
      chip.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
    if (clearBtn) clearBtn.hidden = !active();
  }
  function updateMeta(total){
    if (!searchMeta) return;
    if (!q) { searchMeta.style.display = 'none'; return; }
    searchMeta.textContent = (total || 0) + ' matches · ranked by relevance';
    searchMeta.style.display = '';
  }
  function feedUpdate(){
    var T = readToken();
    if (!T) return;
    // Server expects { group: [value, ...] }, but client state stores
    // { group: { value: true } } for fast lookup. Convert before sending.
    var serverFilters = {};
    for (var g in state) {
      var vals = Object.keys(state[g]);
      if (vals.length) serverFilters[g] = vals;
    }
    fetch('/feed?t=' + encodeURIComponent(T), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: serverFilters, page: page, q: q })
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (feed && data.feedHtml) feed.innerHTML = data.feedHtml;
      if (bar && data.paginationHtml) bar.innerHTML = data.paginationHtml;
      updateMeta(data.total);
    })
    .catch(function(err){ console.error('KYA feed update failed', err); });
  }
  chips.forEach(function(chip){
    chip.addEventListener('click', function(){
      var g = chip.dataset.fgroup, v = chip.dataset.fvalue;
      if (state[g] && state[g][v]) {
        delete state[g][v];
        if (!Object.keys(state[g]).length) delete state[g];
      } else {
        (state[g] || (state[g] = Object.create(null)))[v] = true;
      }
      page = 1;
      save(); apply();
      if (LIVE) feedUpdate();
    });
  });
  if (LIVE && bar) {
    bar.addEventListener('click', function(e){
      var btn = e.target.closest('button[data-page]');
      if (!btn) return;
      var dp = btn.getAttribute('data-page');
      if (dp === 'prev') page = Math.max(1, page - 1);
      else if (dp === 'next') page = page + 1;
      else {
        var np = parseInt(dp, 10);
        if (np > 0) page = np;
      }
      save(); apply();
      feedUpdate();
    });
  }
  if (searchInput) {
    var debounce = 0;
    searchInput.addEventListener('input', function(){
      q = (searchInput.value || '').trim();
      page = 1;
      save(); apply();
      clearTimeout(debounce);
      if (LIVE) debounce = setTimeout(feedUpdate, 120);
    });
  }
  if (clearBtn) clearBtn.addEventListener('click', function(){ state = Object.create(null); page = 1; q = ''; if (searchInput) searchInput.value = ''; save(); apply(); if (LIVE) feedUpdate(); });
  parse(); apply();
  if (searchInput) searchInput.value = q;
  if (LIVE && (active() || page !== 1)) feedUpdate();
})();
</script>`
    : "";

  // Static receipts: a small client-side BM25-only scorer that filters the
  // rendered feed rows. No network round-trips and no semantic embeddings.
  const staticSearchScript = !model.liveToken
    ? `<script id="kya-static-search">
(function(){
  var feed = document.getElementById('feed');
  var input = document.getElementById('feed-search');
  var meta = document.querySelector('.feed-search-meta');
  var clearBtn = document.getElementById('clear-filters');
  if (!feed || !input) return;
  var STOP = Object.create(null);
  "a an the and or but is are was were be been being to of in on at by for with as this that it its from up about into through during before after above below between among within without against over under again further then once here there when where why how all any both each few more most other some such only own same so than too very can will just should now did does do has have had having get got gets make made makes use used uses using".split(" ").forEach(function(w){ STOP[w] = 1; });
  function stem(t){
    if (t.length <= 3) return t;
    if (t.slice(-3) === 'ing') return t.slice(0,-3) || t;
    if (t.slice(-2) === 'ed') return t.slice(0,-2) || t;
    if (t.slice(-1) === 's' && t.slice(-2) !== 'ss') return t.slice(0,-1) || t;
    return t;
  }
  function tokenize(text){
    var out = [];
    var parts = String(text).toLowerCase().split(/[^a-z0-9]+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      var split = p.replace(/([A-Z])/g, ' $1').replace(/[_\\-.]/g, ' ').toLowerCase().split(/[^a-z0-9]+/);
      for (var j = 0; j < split.length; j++) {
        var s = stem(split[j]);
        if (s && !STOP[s]) out.push(s);
      }
    }
    return out;
  }
  var rows = Array.prototype.slice.call(feed.querySelectorAll('.ev'));
  var docs = rows.map(function(row){
    var text = row.textContent || '';
    var tokens = tokenize(text);
    var freq = Object.create(null);
    for (var i = 0; i < tokens.length; i++) freq[tokens[i]] = (freq[tokens[i]] || 0) + 1;
    return { row: row, tokens: tokens, freq: freq, text: text };
  });
  var N = docs.length;
  var avgLen = N ? docs.reduce(function(a,d){ return a + d.tokens.length; }, 0) / N : 0;
  var q = '';
  function scoreDoc(doc, qTokens){
    if (!qTokens.length) return 1;
    var score = 0, k1 = 1.5, b = 0.75;
    for (var i = 0; i < qTokens.length; i++) {
      var t = qTokens[i];
      var df = 0;
      for (var j = 0; j < docs.length; j++) if (docs[j].freq[t]) df++;
      if (!df) continue;
      var tf = doc.freq[t] || 0;
      if (!tf) continue;
      var idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      var denom = tf + k1 * (1 - b + b * doc.tokens.length / Math.max(avgLen, 1));
      score += idf * (tf * (k1 + 1) / denom);
    }
    return score;
  }
  function apply(){
    var qTokens = tokenize(q);
    var visible = 0;
    for (var i = 0; i < docs.length; i++) {
      var s = scoreDoc(docs[i], qTokens);
      var hide = q && s <= 0;
      docs[i].row.classList.toggle('filtered-out', hide);
      if (!hide) visible++;
    }
    var day = null, dayHas = false;
    function flush(){ if (day) day.classList.toggle('filtered-out', q && !dayHas); }
    for (var k = 0; k < feed.children.length; k++) {
      var el = feed.children[k];
      if (el.classList.contains('day')) { flush(); day = el; dayHas = false; }
      else if (el.classList.contains('ev') && !el.classList.contains('filtered-out')) dayHas = true;
    }
    flush();
    if (meta) {
      if (q) { meta.textContent = visible + ' matches · filtered by relevance'; meta.style.display = ''; }
      else meta.style.display = 'none';
    }
    if (clearBtn) clearBtn.hidden = !q;
  }
  function save(){
    var kept = [];
    var s = location.search;
    if (s.indexOf('?') === 0) {
      var params = s.slice(1).split('&');
      for (var i = 0; i < params.length; i++) {
        if (params[i] && params[i].indexOf('q=') !== 0) kept.push(params[i]);
      }
    }
    if (q) kept.push('q=' + encodeURIComponent(q));
    var qq = kept.length ? '?' + kept.join('&') : '';
    var h = location.hash;
    history.replaceState(null, '', location.pathname + qq + h);
  }
  input.addEventListener('input', function(){ q = (input.value || '').trim(); apply(); save(); });
  if (clearBtn) clearBtn.addEventListener('click', function(){ q = ''; input.value = ''; apply(); save(); });
  var s = location.search;
  var found = false;
  if (s.indexOf('?') === 0) {
    var params = s.slice(1).split('&');
    for (var i = 0; i < params.length; i++) {
      if (params[i].indexOf('q=') === 0) {
        try { q = decodeURIComponent(params[i].slice(2).replace(/\\+/g, ' ')); } catch(e){ q = params[i].slice(2); }
        found = true;
      }
    }
  }
  // No ?q= in the URL: honor the server-prefilled input (static artifacts
  // generated with kya receipt --q) so they open pre-filtered.
  if (!found) q = (input.value || '').trim();
  input.value = q;
  apply();
})();
</script>`
    : "";

  const livePill = model.live ? `<span class="live" title="Watching trail.jsonl">Live</span>` : "";

  const themeScript = `<script>
(function(){
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');
  function apply(theme){ root.setAttribute('data-theme', theme); }
  var explicit = root.getAttribute('data-theme');
  var stored = null;
  try { stored = localStorage.getItem('kya-theme'); } catch(e){}
  if (explicit) {
    // honor an explicit theme set on the static artifact (e.g. screenshots)
  } else if (stored) apply(stored);
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) apply('light');
  else apply('dark');
  if (btn) btn.addEventListener('click', function(){
    apply(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    try { localStorage.setItem('kya-theme', root.getAttribute('data-theme')); } catch(e){}
  });
})();
</script>`;

  // Gateway interactive controls: playground evaluator, quick actions, and the
  // sidebar stop-report link. Only wired when the page is served by the live
  // loopback server (token present). Token is read from the query string so it
  // matches the same origin as the SSE endpoint; all user-controlled output is
  // escaped before DOM insertion.
  const gateScript = model.liveToken
    ? `<script>
(function(){
  var T = '';
  var s = location.search;
  if (s.indexOf('?') === 0) {
    var params = s.slice(1).split('&');
    for (var i = 0; i < params.length; i++) {
      if (params[i].indexOf('t=') === 0) {
        try { T = decodeURIComponent(params[i].slice(2)); } catch(e){ T = params[i].slice(2); }
        break;
      }
    }
  }
  if (!T) return;
  function esc(str){
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function setResult(el, html, isError){
    if (!el) return;
    el.innerHTML = '<div class="gate-result' + (isError ? ' error' : '') + '">' + html + '</div>';
  }
  function post(path, body){
    return fetch(path + '?t=' + encodeURIComponent(T), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
  function parseJson(res){ return res.json(); }

  var form = document.getElementById('gate-play-form');
  if (form) {
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var server = form.elements.server.value.trim();
      var tool = form.elements.tool.value.trim();
      var resultEl = document.getElementById('gate-play-result');
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      setResult(resultEl, 'Evaluating...', false);
      post('/gate/playground', { server: server, tool: tool })
        .then(parseJson)
        .then(function(data){
          if (data && data.ok) {
            var pill = '<span class="pill ' + (data.verdict === 'allow' ? 'ok' : 'bad') + '">' + esc(data.verdict.toUpperCase()) + '</span>';
            setResult(resultEl, pill + '<p>' + esc(data.reason) + '</p>', false);
          } else {
            setResult(resultEl, '<p>Error: ' + esc(data && data.error ? data.error : 'unknown') + '</p>', true);
          }
        })
        .catch(function(err){
          setResult(resultEl, '<p>Error: ' + esc(err.message) + '</p>', true);
        })
        .finally(function(){
          if (btn) btn.disabled = false;
        });
    });
  }

  document.querySelectorAll('.gate-zone [data-action]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var action = btn.getAttribute('data-action');
      var resultEl = document.getElementById('gate-doctor-result');
      btn.disabled = true;
      if (action === 'doctor') setResult(resultEl, 'Running doctor...', false);
      post('/gate/action', { action: action })
        .then(parseJson)
        .then(function(data){
          if (data && data.ok) {
            if (action === 'doctor') {
              setResult(resultEl, '<pre>' + esc(JSON.stringify(data.report, null, 2)) + '</pre>', false);
              btn.disabled = false;
            } else {
              setTimeout(function(){ location.reload(); }, 800);
            }
          } else {
            setResult(resultEl, '<p>Error: ' + esc(data && data.error ? data.error : 'unknown') + '</p>', true);
            btn.disabled = false;
          }
        })
        .catch(function(err){
          setResult(resultEl, '<p>Error: ' + esc(err.message) + '</p>', true);
          btn.disabled = false;
        });
    });
  });

  var stopLink = document.getElementById('stop-report');
  if (stopLink) {
    stopLink.addEventListener('click', function(e){
      e.preventDefault();
      stopLink.textContent = 'Stopping...';
      post('/stop', {})
        .then(parseJson)
        .then(function(data){
          if (data && data.ok) {
            stopLink.textContent = 'Report stopped';
            stopLink.setAttribute('aria-disabled', 'true');
            stopLink.style.pointerEvents = 'none';
            stopLink.style.opacity = '0.6';
          } else {
            stopLink.textContent = 'Stop failed';
            window.alert('Failed to stop report: ' + esc(data && data.error ? data.error : 'unknown'));
          }
        })
        .catch(function(err){
          stopLink.textContent = 'Stop failed';
          window.alert('Failed to stop report: ' + esc(err.message));
        });
    });
  }
})();
</script>`
    : "";

  // Zones never render as bare whitespace: with no panels they get a hint.
  const zoneBody = (parts: readonly string[], empty: string): string =>
    parts.some((p) => p.length > 0)
      ? parts.filter(Boolean).join("\n    ")
      : `<p class="mute small zone-empty">${empty}</p>`;
  const overviewBody = zoneBody(
    [dashboardPanel(dashboard), sessionsPanel(agg, nowMs, changes), reasonsPanel(agg)],
    "No activity in this window yet - analytics appear once events land.",
  );
  const certifyBody = zoneBody(
    [model.certify ? certifyDetailPanel(model.certify.requirements) : ""],
    "No live evaluation yet - wrap tool calls and run kya certify to build the baseline.",
  );
  const systemBody = zoneBody(
    [
      gatePanel(model.gate, nowMs),
      wiredHostsPanel(model.wiredHosts),
      sandboxesPanel(model.sandboxes, nowMs),
      orrPanel(model.orr, nowMs),
      alertsPanel(model.alerts, nowMs),
      otelPanel(model.otel, nowMs),
      toolsHtml,
    ],
    "No system state yet - wire a host, configure a sandbox, or run an ORR.",
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(model.title)} - ${esc(model.rangeLabel)}</title>
<style>${receiptCss()}</style>
</head>
<body>
<aside class="sidebar">
  <header class="sidebar-header">
    <div class="brand">
      <span class="mark" aria-hidden="true">k</span>
      <span class="wordmark">kya</span>
    </div>
  </header>
  <nav class="sidebar-nav" aria-label="Report sections">
    ${navItem("#overview", "Overview", events.length)}
    ${navItem("#activity", "Activity", events.length)}
    ${navItem("#changes", "Changes", changes.fileCount)}
    ${navItem("#certify", "Certify", model.certify?.gap ?? 0)}
    ${navGroup("Gateway", model.gate?.state === "running")}
    ${navSubItem("#gateway-home", "Home", model.gate?.servers.length ?? 0)}
    ${navSubItem("#gateway-listeners", "Listeners", model.gate?.listeners?.length ?? 0)}
    ${navSubItem("#gateway-routes", "Routes", model.gate?.routes?.length ?? 0)}
    ${navSubItem("#gateway-backends", "Backends", model.gate?.servers.length ?? 0)}
    ${navSubItem("#gateway-policies", "Policies", model.gate?.policySummary?.totalPolicies ?? 0)}
    ${navSubItem("#gateway-playground", "Playground", model.gate?.playgroundSamples?.length ?? 0)}
    ${navItem("#system", "System", undefined)}
  </nav>
  <footer class="sidebar-footer">
    <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">Theme</button>
    <!-- Stop-report action is wired by the live-server POST handler. -->
    <a href="#" id="stop-report">Stop report</a>
    ${model.liveToken ? '<a href="https://github.com/The-Pixel-Boys/shield-agent" class="star-link" target="_blank" rel="noopener noreferrer">Star on GitHub ↗</a>' : ""}
  </footer>
</aside>
${model.liveToken ? '<main data-live-token="1">' : '<main>'}
  <header class="page-header">
    <div class="title-row">
      <h1>${esc(model.title)}</h1>
      <div class="range">${esc(model.rangeLabel)}${livePill}</div>
    </div>
    ${identityLine(model.identity)}
  </header>
  ${blockedBanner}
  <section class="zone" id="overview" aria-labelledby="tab-overview">
    <div class="hero">
      ${heroCertifyPanel(model.certify)}
      <div class="hero-tiles">
        ${verdictsHeroCard(c, events.length)}
        ${activityHeroCard(agg, dashboard, events.length)}
        ${gatewayHeroCard(model.gate, nowMs)}
        ${importHeroCard(model.imports, nowMs)}
        ${investigateHeroCard(model.investigate, nowMs)}
        ${showbackHeroCard(model.showback, model.events)}
      </div>
    </div>
    ${overviewBody}
  </section>
  <section class="zone" id="activity" aria-labelledby="tab-activity">
    <div class="feed-search">
      <input id="feed-search" class="feed-search-input" type="search" placeholder="Search activity in plain language…" value="${esc(model.searchQuery ?? "")}" autocomplete="off" />
      ${model.searchQuery ? `<div class="feed-search-meta">${initialFeed.total} matches · ${livePaged ? "ranked by relevance" : "filtered by relevance"}</div>` : ""}
    </div>
    ${!model.liveToken && model.searchQuery ? '<p class="feed-search-note">Semantic ranking requires the live report server (<code>kya start</code>).</p>' : ""}
    <div class="feed-head">
      <div class="stats" aria-label="Counts">
        <button type="button" class="stat ok" data-fgroup="verdict" data-fvalue="ALLOW" aria-pressed="false" title="Filter: Allow">Allow<b>${c.allow}</b></button>
        <button type="button" class="stat bad" data-fgroup="verdict" data-fvalue="DENY" aria-pressed="false" title="Filter: Deny">Deny<b>${c.deny}</b></button>
        <button type="button" class="stat warn" data-fgroup="verdict" data-fvalue="REQUIRE_APPROVE" aria-pressed="false" title="Filter: Review">Review<b>${c.require}</b></button>
        <button type="button" class="stat" data-fgroup="never" data-fvalue="1" aria-pressed="false" title="Filter: Never">Never<b>${c.never}</b></button>
        ${chips.modes}${chips.planes}
        <button type="button" class="stat clear-filters" id="clear-filters" hidden>Clear filters ×</button>
      </div>
      ${chips.products}
      ${chips.projects}
      ${chips.servers}
    </div>
    <section class="feed" id="feed" aria-label="Activity feed">
${initialFeed.feedHtml}
    </section>
    <div id="pagination-bar" aria-label="Activity pagination">
${initialFeed.paginationHtml}
    </div>
  </section>
  <section class="zone" id="changes" aria-labelledby="tab-changes">
    <section class="feed chg" id="changes-list" aria-label="Changes by session and file">
${changesPanel(changes, nowMs)}
    </section>
  </section>
  <section class="zone" id="certify" aria-labelledby="tab-certify">
    ${certifyBody}
  </section>
  ${gatePagePanel(model.gate, nowMs)}
  <section class="zone" id="system" aria-labelledby="tab-system">
    ${systemBody}
  </section>
</main>
${filterScript}
${staticSearchScript}
${themeScript}
${gateScript}
${liveScript}
</body>
</html>`;

  // Defense-in-depth: block known secret shapes before serving HTML.
  assertNoSecrets(html);
  return html;
}

export function renderReceiptMarkdown(model: ReceiptModel): string {
  const c = countVerdicts(model.events);
  const agg = aggregateEvents(model.events);
  const nowMs = Date.now();
  const lines: string[] = [
    `# ${mdText(model.title)}`,
    "",
    mdText(model.rangeLabel),
    "",
    `Allow ${c.allow} | Deny ${c.deny} | Review ${c.require} | Never ${c.never}`,
    "",
  ];

  if (model.identity) {
    const id = model.identity;
    const nameId =
      id.agentName && id.agentId
        ? `${id.agentName}/${id.agentId}`
        : (id.agentName ?? id.agentId);
    const bits = [nameId, id.host, id.baseUrl].filter(
      (b): b is string => typeof b === "string" && b.trim().length > 0,
    );
    if (bits.length > 0) {
      lines.push(mdText(bits.join(" · ")), "");
    }
  }

  const modeBits = [
    agg.modes.observe > 0 ? `observe ${agg.modes.observe}` : "",
    agg.modes.hold > 0 ? `hold ${agg.modes.hold}` : "",
    agg.modes.offline > 0 ? `offline ${agg.modes.offline}` : "",
  ].filter(Boolean);
  const planeBits = [
    agg.planes.ide > 0 ? `IDE ${agg.planes.ide}` : "",
    agg.planes.runtime > 0 ? `Runtime ${agg.planes.runtime}` : "",
  ].filter(Boolean);
  if (modeBits.length > 0 || planeBits.length > 0) {
    lines.push(`Modes: ${modeBits.join(" | ") || "-"} · Planes: ${planeBits.join(" | ") || "-"}`, "");
  }

  if (agg.products.length >= 2) {
    lines.push(
      "## Products",
      ...agg.products.map((p) => `- ${mdText(p.label)} × ${p.count}`),
      "",
    );
  }

  if (agg.projects.length >= 2) {
    lines.push(
      "## Projects",
      ...agg.projects.map((p) => `- ${mdText(p.label)} × ${p.count}`),
      "",
    );
  }

  if (model.certify) {
    const c = model.certify;
    lines.push(
      "## Certify",
      `result: ${c.result} · counts: ${c.pass} pass · ${c.gap} gap · ${c.insufficientEvidence} insufficient · ${c.attested} attested`,
    );
    if (c.topGaps.length > 0) {
      lines.push("Top gaps:");
      for (const g of c.topGaps) {
        lines.push(`- \`${mdInline(g.id)}\` - ${mdText(g.title)} (${mdText(g.severity)})`);
      }
    }
    lines.push(
      `live evaluation - window ${c.windowDays}d, ${c.trailEvents} trail events · the Certify tab has the full live requirement table · kya certify for the gap report + signed bundle`,
      "",
    );
  }

  const db = computeDashboard(model.events);
  if (db.verdictMix.total > 0) {
    const pct = (n: number): number => Math.round((n / db.verdictMix.total) * 100);
    // never is a reason overlay: the Never share is computed from neverEvent
    // rows on top of the same 100% = total events base as the verdict buckets.
    lines.push(
      "## Analytics",
      "",
      `Verdict mix: Allow ${pct(db.verdictMix.allow)}% · Review ${pct(db.verdictMix.review)}% · Deny ${pct(db.verdictMix.deny)}% · Never ${pct(db.verdictMix.never)}%`,
      "",
    );
    if (db.activity.buckets.length > 0) {
      const max = Math.max(1, ...db.activity.buckets.map((b) => b.count));
      lines.push(`Activity (${db.activity.granularity === "hour" ? "hourly" : "daily"}):`);
      for (const b of db.activity.buckets) {
        const bar = b.count === 0 ? "▁" : "▅".repeat(Math.max(1, Math.round((b.count / max) * 6)));
        lines.push(`- ${mdText(b.label)} ${bar} ${b.count}`);
      }
      lines.push("");
    }
    if (db.topTools.length > 0) {
      lines.push("Top tools:");
      for (const t of db.topTools) {
        lines.push(`- \`${mdInline(t.toolId)}\` × ${t.count} (worst: ${t.worst})`);
      }
      lines.push("");
    }
    if (db.productHotspots.length > 0 || db.projectHotspots.length > 0) {
      lines.push("Risk hotspots (deny + never):");
      if (db.productHotspots.length > 0) {
        lines.push(
          `- Products: ${db.productHotspots.map((h) => `${mdText(h.label)} × ${h.count}`).join(" · ")}`,
        );
      }
      if (db.projectHotspots.length > 0) {
        lines.push(
          `- Projects: ${db.projectHotspots.map((h) => `${mdText(h.label)} × ${h.count}`).join(" · ")}`,
        );
      }
      lines.push("");
    }
  }

  lines.push(
    "## Feed",
    ...[...model.events]
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .flatMap((e) => {
        const sum = e.summary?.trim() ? ` - ${mdText(e.summary.trim())}` : "";
        const head = `- **${mdText(verdictWord(e.verdict))}** \`${mdInline(e.toolId)}\`${sum} - ${productLabel(e.product)} - ${mdText(e.reasonCode)}`;
        if (!e.diffPreview?.trim()) return [head];
        // Fenced content is verbatim (stripEscapes only - backslash escapes
        // are literal in code fences); the dynamically sized tilde fence
        // prevents breakout and backticks cannot close a tilde fence.
        const diff = stripEscapes(e.diffPreview.trim());
        const fence = mdFence(diff);
        return [head, "", fence, diff, fence, ""];
      }),
    "",
  );

  // Same normalization as the HTML path: targetPath flows into single-line
  // `#### ` code-span headers, so embedded newlines must be flattened first.
  const changes = buildChangesModel(normalizeTrailEvents(model.events));
  if (changes.sessions.length > 0) {
    lines.push("## Changes", "");
    for (const s of changes.sessions) {
      lines.push(
        `### \`${mdInline(s.sessionId)}\` - ${s.fileCount} file${s.fileCount === 1 ? "" : "s"}, ${s.changeCount} change${s.changeCount === 1 ? "" : "s"}, last ${relativeTime(s.lastTs, nowMs)}`,
        "",
      );
      for (const f of s.files) {
        lines.push(
          `#### \`${mdInline(f.path)}\` - ${f.writes} write${f.writes === 1 ? "" : "s"}, worst: ${f.worst}`,
          "",
        );
        for (const e of f.entries) {
          // Same fencing contract as the md feed: verbatim content, tilde
          // fence one longer than the longest run inside.
          const diff = stripEscapes(e.preview);
          const fence = mdFence(diff);
          lines.push(
            `- **${mdText(verdictWord(e.verdict))}** \`${mdInline(e.toolId)}\` - ${mdText(e.ts)}`,
            "",
            fence,
            diff,
            fence,
            "",
          );
        }
      }
    }
  }

  if (agg.sessions.length > 0) {
    lines.push(
      "## Sessions",
      ...agg.sessions.map(
        (s) =>
          `- \`${mdInline(s.sessionId)}\` - ${s.events} event${s.events === 1 ? "" : "s"}, worst: ${s.worst}, last ${relativeTime(s.lastTs, nowMs)}`,
      ),
      "",
    );
  }

  if (agg.reasons.length > 0) {
    lines.push(
      "## Reasons",
      ...agg.reasons.map((r) => `- ${mdText(r.label)} × ${r.count}`),
      "",
    );
  }

  if (model.gate) {
    const g = model.gate;
    lines.push("## Gateway");
    if (g.state === "not-set-up") {
      lines.push(`not set up - ${GATE_NOT_SETUP_QUICKSTART}`);
    } else {
      const binary = g.binaryPresent
        ? `binary ${g.binaryVersion ? mdInline(clip(g.binaryVersion, 40)) : "installed"}`
        : "binary missing - kya gate setup";
      lines.push(
        g.state === "running"
          ? `running - \`${mdInline(clip(g.url ?? "", 60))}\` · ${binary} · ${g.events} event${g.events === 1 ? "" : "s"} in window`
          : `stopped - \`kya gate run\` · ${binary}`,
      );
      if (g.state === "running" && g.servers.length === 0) {
        lines.push("running, no servers configured - add servers to .kya/gateways.json and restart");
      }
      for (const s of g.servers) {
        lines.push(
          `- \`${mdInline(s.id)}\` - ${mdText(s.transport)} · ${s.events} event${s.events === 1 ? "" : "s"}${s.worst === "none" ? "" : `, worst: ${s.worst}`}`,
        );
      }
    }
    lines.push("");
  }

  const hosts = model.wiredHosts ?? [];
  if (hosts.some((h) => h.wired !== "none")) {
    lines.push("## Wired hosts");
    for (const h of hosts) {
      if (h.recipeOnly) {
        lines.push(`- ${mdText(h.label)} - manual setup (docs recipe)`);
      } else if (h.wired === "none") {
        lines.push(`- ${mdText(h.label)} - not wired`);
      } else {
        const reload = h.reload ? ` · ${mdText(h.reload.reload)}` : "";
        lines.push(
          `- ${mdText(h.label)} - wired (${h.wired})${reload} · ${h.running ? "running" : "not running"}`,
        );
      }
    }
    lines.push("");
  }

  if (model.sandboxes && (model.sandboxes.sandboxes.length > 0 || model.sandboxes.backend)) {
    const sb = model.sandboxes;
    lines.push("## Sandboxes");
    if (sb.backend) lines.push(`Configured backend: ${mdText(sb.backend)}`);
    for (const s of sb.sandboxes) {
      lines.push(
        `- \`${mdInline(s.sandboxId)}\` - ${mdText(s.backend)} · ${mdText(s.status)} · created ${relativeTime(s.createdAt, nowMs)}`,
      );
    }
    lines.push("");
  }

  if (model.orr) {
    const orr = model.orr;
    lines.push(
      "## Operational readiness",
      `overall: ${orr.overall} · disposition: ${orr.disposition.replace(/_/g, " ")}${orr.targetName ? ` · target ${mdText(orr.targetName)}` : ""}`,
    );
    if (orr.primaryFailureMode) lines.push(`Primary failure mode: ${mdText(orr.primaryFailureMode)}`);
    if (orr.mostUrgentFix) lines.push(`Most urgent fix: ${mdText(orr.mostUrgentFix)}`);
    lines.push(
      `scorecards: ${orr.scorecards.pass} pass · ${orr.scorecards.fail} fail · ${orr.scorecards.partial} partial · ${orr.scorecards.notEvaluated} n/e${orr.generatedAt ? ` · ${relativeTime(orr.generatedAt, nowMs)}` : ""}`,
      "",
    );
  }

  if (model.showback) {
    const sb = model.showback;
    lines.push(
      "## Showback (observe only)",
      `${sb.totalTokensIn} tokens in · ${sb.totalTokensOut} tokens out · ${usdText(sb.estimatedUsd)}`,
    );
    const topRuns = [...sb.perRun]
      .sort((a, b) => (b.estimatedUsd ?? -1) - (a.estimatedUsd ?? -1))
      .slice(0, 5);
    for (const r of topRuns) {
      lines.push(`- \`${mdInline(r.runId)}\` - ${r.steps} step${r.steps === 1 ? "" : "s"} · ${usdText(r.estimatedUsd)}`);
    }
    lines.push(SHOWBACK_DISCLAIMER, "");
  }

  if (model.imports) {
    const im = model.imports;
    lines.push(
      "## Import",
      `${im.total} imported · ${im.errors} error${im.errors === 1 ? "" : "s"}${im.lastTs ? ` · latest event ${relativeTime(im.lastTs, nowMs)}` : ""}`,
      ...im.formats.map(
        (f) => `- ${mdText(f.format)} × ${f.imported}${f.errors > 0 ? ` (${f.errors} errors)` : ""}`,
      ),
      "",
    );
  }

  if (model.investigate) {
    const iv = model.investigate;
    const findingCount = iv.findings.reduce((n, f) => n + f.count, 0);
    lines.push(
      "## Investigations",
      `last run ${relativeTime(iv.ranAt, nowMs)} · window ${iv.windowDays}d · ${findingCount} finding${findingCount === 1 ? "" : "s"} · ${iv.incidents} incident${iv.incidents === 1 ? "" : "s"}`,
    );
    for (const f of iv.findings) {
      lines.push(`- [${mdText(f.severity)}] \`${mdInline(f.detectorId)}\` - ${mdText(f.title)} × ${f.count}`);
    }
    if (iv.briefSnippet) {
      const snippet = stripEscapes(iv.briefSnippet);
      const fence = mdFence(snippet);
      lines.push("", "Top fix brief:", "", fence, snippet, fence);
    }
    lines.push("");
  }

  if (model.alerts) {
    const al = model.alerts;
    lines.push(
      "## Alerts",
      `${al.delivered} delivered · ${al.failed} failed · last attempt ${relativeTime(al.lastTs, nowMs)}`,
      ...al.targets.map(
        (t) =>
          `- \`${mdInline(t.target)}\` - ${t.delivered} delivered · ${t.failed} failed · last ${t.lastOk ? "delivered" : "failed"}${t.lastDetail ? ` (${mdText(t.lastDetail)})` : ""} ${relativeTime(t.lastTs, nowMs)}`,
      ),
      "",
    );
  }

  if (model.otel) {
    const ot = model.otel;
    lines.push(
      "## OTel export",
      `${ot.endpoint ? `\`${mdInline(ot.endpoint)}\` · ` : ""}${ot.spansSent} sent · ${ot.spansFailed} failed${ot.lastExportAt ? ` · last export ${relativeTime(ot.lastExportAt, nowMs)}` : ""}`,
      "",
    );
  }

  const md = `${lines.join("\n")}\n`;
  assertNoSecrets(md);
  return md;
}
