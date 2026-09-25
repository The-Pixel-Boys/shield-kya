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
import { productLabel, readTrail, readTrailSince, type TrailEvent, type TrailProduct } from "../trail.js";
import type { KyaFileConfig } from "../config.js";
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
import { computeDashboard, type Dashboard, type DashboardRow, type ToolWorst } from "./dashboard.js";
import { buildChangesModel, type ChangesModel } from "./changes.js";
import { receiptCss } from "./receipt-css.js";

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
  /** Loopback SSE token — set only by the live server, never in static renders. */
  readonly liveToken?: string;
  /** Local identity from .kya/config.json (inert text; never a link). */
  readonly identity?: KyaFileConfig;
  /** Sandbox state + configured KYA_SANDBOX backend. */
  readonly sandboxes?: SandboxCard;
  /** Per-host wiring status across the connect registry. */
  readonly wiredHosts?: readonly WiredHostRow[];
  /** Slim ORR card from orr-report/report.json. */
  readonly orr?: OrrCard;
  /** Live Agent Trust Baseline card, recomputed on every model load. */
  readonly certify?: CertifyCard;
  /** Observe-only showback from .kya/usage.json. */
  readonly showback?: ShowbackReport;
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
}

/** Pure rollup of trail events for the report's stat chips and sections. */
export function aggregateEvents(events: readonly TrailEvent[]): EventAggregates {
  const modes = { observe: 0, hold: 0, offline: 0 };
  const planes = { ide: 0, runtime: 0 };
  const reasonCounts = new Map<string, number>();
  const productCounts = new Map<TrailProduct, number>();
  const projectCounts = new Map<string, number>();
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

  return { modes, planes, sessions, reasons, products, projects };
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
    spend: extras?.spend,
    mcpSeen: extras?.mcpSeen,
    live: extras?.live,
    liveToken: extras?.liveToken,
    identity: extras?.identity,
    sandboxes: extras?.sandboxes,
    wiredHosts: extras?.wiredHosts,
    orr: extras?.orr,
    certify: extras?.certify,
    showback: extras?.showback,
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
    spend: extras?.spend,
    mcpSeen: extras?.mcpSeen,
    live: extras?.live,
    liveToken: extras?.liveToken,
    identity: extras?.identity,
    sandboxes: extras?.sandboxes,
    wiredHosts: extras?.wiredHosts,
    orr: extras?.orr,
    certify: extras?.certify,
    showback: extras?.showback,
  };
}

/** Shared loader for static artifacts and the live loopback server. */
export function loadReceiptModel(input: {
  readonly cwd: string;
  readonly sessionId?: string;
  readonly days: number;
  readonly live?: boolean;
  readonly liveToken?: string;
}): ReceiptModel {
  const days = input.days > 0 ? Math.floor(input.days) : 3;
  const showback = loadShowbackCard(input.cwd);
  const extras = {
    live: input.live,
    liveToken: input.liveToken,
    identity: loadIdentity(input.cwd),
    sandboxes: loadSandboxes(input.cwd),
    wiredHosts: loadWiredHosts(input.cwd),
    orr: loadOrrCard(input.cwd),
    certify: loadCertifyCard(input.cwd),
    showback,
    spend: showback
      ? {
          tokens: showback.totalTokensIn + showback.totalTokensOut,
          usdEstimate: showback.estimatedUsd ?? undefined,
        }
      : undefined,
  };
  if (input.sessionId) {
    return buildReceiptModel(input.sessionId, readTrail(input.cwd), extras);
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return buildWindowReceiptModel(readTrailSince(input.cwd, since), days, extras);
}

function modeBadge(mode: TrailEvent["mode"] | undefined): string {
  const letter = mode === "observe" ? "O" : mode === "hold" ? "H" : mode === "offline" ? "X" : "";
  if (!letter) return "";
  return `<span class="modeb" title="${letter === "O" ? "observe" : letter === "H" ? "hold" : "offline"} mode">${letter}</span>`;
}

// project is attacker-controllable (trail files are user-editable) — always escaped.
function projectMeta(project: string | undefined): string {
  const p = project?.trim();
  if (!p) return "";
  return `
      <span class="dot">-</span>
      <span class="project">${esc(clip(p, 40))}</span>`;
}

function renderFeed(events: readonly TrailEvent[], nowMs: number, live?: boolean): string {
  if (events.length === 0) {
    const hint = live
      ? "No events yet — evaluate a tool call with <code>kya wrap</code> and this page will refresh."
      : "No events yet — evaluate a tool call with <code>kya wrap</code>, then regenerate this receipt.";
    return `<p class="empty">${hint}</p>`;
  }

  const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts));
  const parts: string[] = [];
  let lastDay = "";

  for (const e of sorted) {
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
    // match the tool filter values stamped on dashboard rows.
    const project = e.project?.trim();
    const dataAttrs =
      `data-verdict="${esc(e.verdict.toUpperCase())}"` +
      (never ? ` data-never="1"` : "") +
      ` data-mode="${esc(e.mode)}"` +
      ` data-plane="${esc(e.host?.trim() || "unknown")}"` +
      ` data-product="${esc(e.product ?? "other")}"` +
      ` data-tool="${esc(clip(e.toolId, 60))}"` +
      ` data-session="${esc(e.sessionId || "unknown")}"` +
      (project ? ` data-project="${esc(project)}"` : "");
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
    return `<p class="empty">No recorded changes yet — write/edit tool calls will show up here.</p>`;
  }
  return changes.sessions
    .map((s) => {
      const files = s.files
        .map((f) => {
          const entries = f.entries
            .map((e) => {
              const t = tone(e.verdict);
              const project = e.project?.trim();
              const dataAttrs =
                `data-verdict="${esc(e.verdict.toUpperCase())}"` +
                (e.never ? ` data-never="1"` : "") +
                ` data-mode="${esc(e.mode)}"` +
                ` data-plane="${esc(e.host?.trim() || "unknown")}"` +
                ` data-product="${esc(e.product ?? "other")}"` +
                ` data-tool="${esc(clip(e.toolId, 60))}"` +
                ` data-session="${esc(s.sessionId)}"` +
                (project ? ` data-project="${esc(project)}"` : "");
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
  // baseUrl is inert text here — never an anchor.
  return `<div class="identity">${esc(clip(bits.join(" · "), 160))}</div>`;
}

function statChips(agg: EventAggregates): {
  modes: string;
  planes: string;
  products: string;
  projects: string;
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
 * the header chips — the engine picks them up via the [data-fgroup] query.
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
      return `<div class="col" title="${esc(b.label)} — ${b.count} event${b.count === 1 ? "" : "s"}"><span class="db-vbar" style="height:${h}%"></span><span class="lab">${esc(b.label)}</span></div>`;
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
    db.productHotspots.length === 0 && db.projectHotspots.length === 0
      ? ""
      : `<div class="db-card">
    <h3>Risk hotspots <span class="mute">deny + never</span></h3>
    ${db.productHotspots.length > 0 ? `<p class="sub">Products</p>\n    ${hotspotRows(db.productHotspots, "product")}` : ""}
    ${db.projectHotspots.length > 0 ? `<p class="sub">Projects</p>\n    ${hotspotRows(db.projectHotspots, "project")}` : ""}
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
        return `<li class="mute">${esc(h.label)} — manual setup <span class="hint" title="${esc(h.recipeOnly)}">docs recipe</span></li>`;
      }
      if (h.wired === "none") {
        return `<li class="mute">${esc(h.label)} — not wired</li>`;
      }
      const reload = h.reload ? ` · ${esc(h.reload.reload)}` : "";
      const running = h.running ? "running" : "not running";
      return `<li>${esc(h.label)} — wired (${h.wired})${reload} · ${running}</li>`;
    })
    .join("\n    ");
  return `<section class="panel" aria-label="Wired hosts">
  <h2>Wired hosts</h2>
  <ul class="rows">
    ${rows}
  </ul>
</section>`;
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
 * only applied above zero — a zero count never reads as a signal. */
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
  <h2>Certify — Agent Trust Baseline</h2>
  <div class="orrline">
    <span class="pill">not evaluated</span>
  </div>
  <p class="mute small">No live evaluation available — wrap tool calls and run kya certify to build the baseline.</p>
</section>`;
  }
  const state = certify.result === "pass" ? "pass" : "gap";
  // Status legend: one muted line under the count tiles so the four numbers
  // read as definitions, not bare counters.
  const legend = `<p class="legend">gap = requirement failing — your work plan · insufficient = not enough local evidence to evaluate (never counts as pass) · attested = your signed statement, unverified</p>`;
  // Attested summary: the hero's gap rows are gap-status only, so attestations
  // surface as one line naming the first attested requirement (+N more) with
  // its attestation text.
  const firstAttested = certify.requirements.find((r) => r.status === "attested");
  const attestedLine =
    certify.attested === 0
      ? ""
      : firstAttested
        ? `<p class="att-line">attested: <code>${esc(firstAttested.id)}</code>${
            certify.attested > 1 ? ` (+${certify.attested - 1} more)` : ""
          } — "${esc(
            clip(firstAttested.attestation?.text ?? firstAttested.evidence, 100),
          )}"</p>`
        : `<p class="att-line">attested: ${certify.attested} — your signed statement, unverified</p>`;
  // topGaps arrives severity-ordered from the loader; cap defensively at 5.
  // Each row is id — title + severity chip, with the redacted evidence
  // one-liner beneath (clipped so the hero stays compact).
  const gaps =
    certify.topGaps.length === 0
      ? ""
      : `<ul class="rows">
${certify.topGaps
  .slice(0, 5)
  .map(
    (g) =>
      `    <li><code>${esc(g.id)}</code> — ${esc(g.title)} <span class="sev ${esc(g.severity)}">${esc(g.severity)}</span>${
        g.evidence ? `<span class="gap-ev">${esc(clip(g.evidence, 140))}</span>` : ""
      }</li>`,
  )
  .join("\n")}
  </ul>`;
  // Pill tones reuse the ORR palette: pass is green, gap is amber.
  return `<section class="panel hero-certify ${state}" aria-label="Certify">
  <h2>Certify — Agent Trust Baseline</h2>
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
  <p class="mute small">live evaluation — window ${certify.windowDays}d, ${certify.trailEvents} trail events · the Certify tab has the full live requirement table · kya certify for the gap report + signed bundle</p>
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

const CERTIFY_DETAIL_TITLE_CLIP = 120;
const CERTIFY_DETAIL_CLIP = 160;

/**
 * Certify tab body: the full live requirement table — every evaluated
 * requirement grouped by domain, domains in catalog order (the card's
 * requirements arrive in catalog order, so first-seen order IS the catalog
 * order). Each domain gets a heading row with mini-counts, then one row per
 * requirement: status pill, id, title, and a muted evidence line beneath —
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
            ? `<span class="att">attested ${esc(r.attestation.at)} — "${esc(
                clip(r.attestation.text, CERTIFY_DETAIL_CLIP),
              )}"</span>`
            : r.evidence
              ? `<span class="evi">${esc(clip(r.evidence, CERTIFY_DETAIL_CLIP))}</span>`
              : "";
          return `      <li>${pill} <code>${esc(r.id)}</code> — ${esc(
            clip(r.title, CERTIFY_DETAIL_TITLE_CLIP),
          )}${detail}</li>`;
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
  <h2>Every requirement — live evaluation</h2>
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
  // in no bucket (bogus verdict) while still counting in `never` — only the
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
 * input renders a flat baseline — heights are guarded, never NaN/Infinity.
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
 * USD, top runs, disclaimer), omitted entirely when no report exists. */
function showbackHeroCard(report: ShowbackReport | undefined): string {
  if (!report) return "";
  const topRuns = [...report.perRun]
    .sort((a, b) => (b.estimatedUsd ?? -1) - (a.estimatedUsd ?? -1))
    .slice(0, 5);
  const runs =
    topRuns.length === 0
      ? ""
      : `<ul class="rows">
${topRuns
  .map(
    (r) => `    <li><code title="${esc(r.runId)}">${esc(clip(r.runId, 32))}</code> — ${r.steps} step${r.steps === 1 ? "" : "s"} · ${esc(usdText(r.estimatedUsd))}</li>`,
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
  <p class="mute small">${esc(SHOWBACK_DISCLAIMER)}</p>
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

export function renderReceiptHtml(model: ReceiptModel): string {  const nowMs = Date.now();
  const events = normalizeTrailEvents(model.events);

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

  // liveToken is minted base64url by the live server — safe in a JS string
  // literal; static renders omit it. No post-hoc html.replace (spoofable).
  const eventsUrl = model.liveToken ? `/events?t=${model.liveToken}` : "/events";
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

  // Client-side chip filters: static and live renders both get this. It runs
  // standalone (no live token needed) and never touches the EventSource block.
  // State maps are null-prototype: attacker-controlled values (project names)
  // must never resolve via Object.prototype. The id lets tests extract just
  // this script. KNOWN is space-delimited so `indexOf(' '+g+' ')` doubles as a
  // prototype-safe whitelist ('constructor' etc. never match).
  // Filter state persists in the ?f= QUERY param, not the hash: the hash is
  // owned by the pure-CSS :target tabs (#overview/#changes/#certify/#activity/
  // #system), so a hash-based filter would hide the Activity zone on every
  // chip toggle and every tab click would wipe the filter. Legacy #f= hashes
  // are still parsed on load (read-only); the next save writes the ?f= form
  // and drops the legacy fragment.
  const filterScript = `<script id="kya-filters">
(function(){
  var feed = document.getElementById('feed');
  if (!feed) return;
  var chg = document.getElementById('changes-list');
  var KNOWN = ' verdict never mode plane product project tool session ';
  var state = Object.create(null);
  var clearBtn = document.getElementById('clear-filters');
  var chips = document.querySelectorAll('[data-fgroup]');
  function parse(){
    state = Object.create(null);
    var raw = null;
    var s = location.search;
    if (s.indexOf('?') === 0) {
      var params = s.slice(1).split('&');
      for (var i = 0; i < params.length; i++) {
        if (params[i].indexOf('f=') === 0) { raw = params[i].slice(2); break; }
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
        if (params[i] && params[i].indexOf('f=') !== 0) kept.push(params[i]);
      }
    }
    if (parts.length) kept.push('f=' + parts.join(','));
    var q = kept.length ? '?' + kept.join('&') : '';
    // The tab hash rides along untouched; a legacy #f= fragment is not a tab
    // hash and is dropped now that the state lives in the query.
    var h = location.hash.indexOf('#f=') === 0 ? '' : location.hash;
    history.replaceState(null, '', location.pathname + q + h);
  }
  function active(){
    return Object.keys(state).some(function(g){ return Object.keys(state[g]).length > 0; });
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
    var on = active();
    feed.querySelectorAll('.ev').forEach(function(row){
      row.classList.toggle('filtered-out', !rowVisible(row, on));
    });
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
    if (clearBtn) clearBtn.hidden = !on;
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
      save(); apply();
    });
  });
  if (clearBtn) clearBtn.addEventListener('click', function(){ state = Object.create(null); save(); apply(); });
  parse(); apply();
})();
</script>`;

  const livePill = model.live ? `<span class="live" title="Watching trail.jsonl">Live</span>` : "";

  // Zones never render as bare whitespace: with no panels they get a hint.
  const zoneBody = (parts: readonly string[], empty: string): string =>
    parts.some((p) => p.length > 0)
      ? parts.filter(Boolean).join("\n    ")
      : `<p class="mute small zone-empty">${empty}</p>`;
  const overviewBody = zoneBody(
    [dashboardPanel(dashboard), sessionsPanel(agg, nowMs, changes), reasonsPanel(agg)],
    "No activity in this window yet — analytics appear once events land.",
  );
  const certifyBody = zoneBody(
    [model.certify ? certifyDetailPanel(model.certify.requirements) : ""],
    "No live evaluation yet — wrap tool calls and run kya certify to build the baseline.",
  );
  const systemBody = zoneBody(
    [
      wiredHostsPanel(model.wiredHosts),
      sandboxesPanel(model.sandboxes, nowMs),
      orrPanel(model.orr, nowMs),
      toolsHtml,
    ],
    "No system state yet — wire a host, configure a sandbox, or run an ORR.",
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
<main>
  <div class="topstick">
    <header class="bar">
      <div class="title-row">
        <h1>${esc(model.title)}</h1>
        <div class="range">${esc(model.rangeLabel)}${livePill}</div>
      </div>
      ${identityLine(model.identity)}
    </header>
    <nav class="tabs" aria-label="Report sections">
      <a class="tab" id="tab-overview" href="#overview">Overview</a>
      <a class="tab" id="tab-changes" href="#changes">Changes</a>
      <a class="tab" id="tab-certify" href="#certify">Certify</a>
      <a class="tab" id="tab-activity" href="#activity">Activity</a>
      <a class="tab" id="tab-system" href="#system">System</a>
    </nav>
  </div>
  ${blockedBanner}
  <div class="hero">
    ${heroCertifyPanel(model.certify)}
    ${verdictsHeroCard(c, events.length)}
    ${activityHeroCard(agg, dashboard, events.length)}
    ${showbackHeroCard(model.showback)}
  </div>
  <section class="zone" id="overview" aria-labelledby="tab-overview">
    ${overviewBody}
  </section>
  <section class="zone" id="changes" aria-labelledby="tab-changes">
    <section class="feed chg" id="changes-list" aria-label="Changes by session and file">
${changesPanel(changes, nowMs)}
    </section>
  </section>
  <section class="zone" id="certify" aria-labelledby="tab-certify">
    ${certifyBody}
  </section>
  <section class="zone" id="activity" aria-labelledby="tab-activity">
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
    </div>
    <section class="feed" id="feed" aria-label="Activity feed">
${renderFeed(events, nowMs, model.live)}
    </section>
  </section>
  <section class="zone" id="system" aria-labelledby="tab-system">
    ${systemBody}
  </section>
</main>
${filterScript}
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
        lines.push(`- \`${mdInline(g.id)}\` — ${mdText(g.title)} (${mdText(g.severity)})`);
      }
    }
    lines.push(
      `live evaluation — window ${c.windowDays}d, ${c.trailEvents} trail events · the Certify tab has the full live requirement table · kya certify for the gap report + signed bundle`,
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
        // Fenced content is verbatim (stripEscapes only — backslash escapes
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
        `### \`${mdInline(s.sessionId)}\` — ${s.fileCount} file${s.fileCount === 1 ? "" : "s"}, ${s.changeCount} change${s.changeCount === 1 ? "" : "s"}, last ${relativeTime(s.lastTs, nowMs)}`,
        "",
      );
      for (const f of s.files) {
        lines.push(
          `#### \`${mdInline(f.path)}\` — ${f.writes} write${f.writes === 1 ? "" : "s"}, worst: ${f.worst}`,
          "",
        );
        for (const e of f.entries) {
          // Same fencing contract as the md feed: verbatim content, tilde
          // fence one longer than the longest run inside.
          const diff = stripEscapes(e.preview);
          const fence = mdFence(diff);
          lines.push(
            `- **${mdText(verdictWord(e.verdict))}** \`${mdInline(e.toolId)}\` — ${mdText(e.ts)}`,
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
          `- \`${mdInline(s.sessionId)}\` — ${s.events} event${s.events === 1 ? "" : "s"}, worst: ${s.worst}, last ${relativeTime(s.lastTs, nowMs)}`,
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

  const hosts = model.wiredHosts ?? [];
  if (hosts.some((h) => h.wired !== "none")) {
    lines.push("## Wired hosts");
    for (const h of hosts) {
      if (h.recipeOnly) {
        lines.push(`- ${mdText(h.label)} — manual setup (docs recipe)`);
      } else if (h.wired === "none") {
        lines.push(`- ${mdText(h.label)} — not wired`);
      } else {
        const reload = h.reload ? ` · ${mdText(h.reload.reload)}` : "";
        lines.push(
          `- ${mdText(h.label)} — wired (${h.wired})${reload} · ${h.running ? "running" : "not running"}`,
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
        `- \`${mdInline(s.sandboxId)}\` — ${mdText(s.backend)} · ${mdText(s.status)} · created ${relativeTime(s.createdAt, nowMs)}`,
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
      lines.push(`- \`${mdInline(r.runId)}\` — ${r.steps} step${r.steps === 1 ? "" : "s"} · ${usdText(r.estimatedUsd)}`);
    }
    lines.push(SHOWBACK_DISCLAIMER, "");
  }

  const md = `${lines.join("\n")}\n`;
  assertNoSecrets(md);
  return md;
}
