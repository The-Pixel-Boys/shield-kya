/**
 * Activity feed HTML/MD for local trail events.
 */
import { assertNoSecrets, clip, stripEscapes } from "../dash/render.js";
import { clipMultiline, DIFF_MAX_TOTAL_CHARS } from "../diff-preview.js";
import { productLabel, readTrail, readTrailSince, type TrailEvent } from "../trail.js";
import type { KyaFileConfig } from "../config.js";
import {
  loadIdentity,
  loadOrrCard,
  loadSandboxes,
  loadShowbackCard,
  loadWiredHosts,
  type OrrCard,
  type SandboxCard,
  type WiredHostRow,
} from "./enrich.js";
import {
  SHOWBACK_DISCLAIMER,
  type ShowbackReport,
} from "../showback/cost-per-task.js";

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
  if (v === "REQUIRE_APPROVE") return "HOLD";
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
}

export interface EventAggregates {
  readonly modes: { readonly observe: number; readonly hold: number; readonly offline: number };
  readonly planes: { readonly ide: number; readonly runtime: number };
  /** Top 8 sessions by recency. */
  readonly sessions: readonly SessionAggregate[];
  /** Top 8 reason codes by count. */
  readonly reasons: readonly CountRow[];
  /** Counts by productLabel, sorted desc. */
  readonly products: readonly CountRow[];
  /** Top 8 projects by count, sorted desc then label asc. */
  readonly projects: readonly CountRow[];
}

/** Pure rollup of trail events for the report's stat chips and sections. */
export function aggregateEvents(events: readonly TrailEvent[]): EventAggregates {
  const modes = { observe: 0, hold: 0, offline: 0 };
  const planes = { ide: 0, runtime: 0 };
  const reasonCounts = new Map<string, number>();
  const productCounts = new Map<string, number>();
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
    const pl = productLabel(e.product);
    productCounts.set(pl, (productCounts.get(pl) ?? 0) + 1);
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
    .map(([label, count]) => ({ label, count }))
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
      ? "No events yet. Wrap a tool call and this page will refresh."
      : "No events yet. Run a wrap, then regenerate this receipt.";
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
    parts.push(`<article class="ev ${t}${never ? " never" : ""}">
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
  const chip = (label: string, n: number, cls = ""): string =>
    n > 0 ? `<span class="stat${cls ? ` ${cls}` : ""}">${label}<b>${n}</b></span>` : "";
  const countRowChips = (rows: readonly CountRow[], ariaLabel: string): string =>
    rows.length >= 2
      ? `<div class="stats" aria-label="${ariaLabel}">${rows
          .map((r) => `<span class="stat">${esc(clip(r.label, 40))}<b>${r.count}</b></span>`)
          .join("")}</div>`
      : "";
  return {
    modes:
      chip("Mode: observe", agg.modes.observe) +
      chip("Mode: hold", agg.modes.hold, "warn") +
      chip("Mode: offline", agg.modes.offline),
    planes: chip("IDE", agg.planes.ide) + chip("Runtime", agg.planes.runtime),
    products: countRowChips(agg.products, "Products"),
    projects: countRowChips(agg.projects, "Projects"),
  };
}

function sessionsPanel(agg: EventAggregates, nowMs: number): string {
  if (agg.sessions.length === 0) return "";
  const rows = agg.sessions
    .map(
      (s) => `<li>
      <span class="wdot ${s.worst}" title="worst verdict: ${s.worst}"></span>
      <code class="sid" title="${esc(s.sessionId)}">${esc(clip(s.sessionId, 24))}</code>
      <span class="cnt">${s.events} event${s.events === 1 ? "" : "s"}</span>
      <span class="rel">${esc(relativeTime(s.lastTs, nowMs))}</span>
    </li>`,
    )
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

function showbackPanel(report: ShowbackReport | undefined): string {
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
  <p class="line">${report.totalTokensIn} tokens in · ${report.totalTokensOut} tokens out · ${esc(usdText(report.estimatedUsd))}</p>
  ${runs}
  <p class="mute small">${esc(SHOWBACK_DISCLAIMER)}</p>
</section>`;
}

export function renderReceiptHtml(model: ReceiptModel): string {
  const nowMs = Date.now();
  const events = [...model.events].map((e) => ({
    ...e,
    toolId: clip(e.toolId, 160),
    reasonCode: clip(e.reasonCode, 80),
    summary: e.summary ? clip(e.summary, 120) : undefined,
    // Preserve newlines — dash clip() flattens them and breaks <pre> diffs.
    diffPreview: e.diffPreview ? clipMultiline(e.diffPreview, DIFF_MAX_TOTAL_CHARS) : undefined,
  }));

  const c = countVerdicts(events);
  const agg = aggregateEvents(events);
  const chips = statChips(agg);
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

  const livePill = model.live ? `<span class="live" title="Watching trail.jsonl">Live</span>` : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(model.title)} - ${esc(model.rangeLabel)}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0c10;
    --fg: #eef2f7;
    --mute: #8b95a8;
    --line: #1c2330;
    --card: #10141c;
    --ok: #3ecf8e;
    --bad: #ff5d5d;
    --warn: #f0b429;
    --rail: #2a3344;
    --day: #6b7280;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f3f5f8;
      --fg: #0f172a;
      --mute: #64748b;
      --line: #e2e8f0;
      --card: #ffffff;
      --ok: #059669;
      --bad: #dc2626;
      --warn: #d97706;
      --rail: #cbd5e1;
      --day: #64748b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.4;
  }
  main { max-width: 42rem; margin: 0 auto; padding: 1.35rem 1rem 3rem; }
  header.bar {
    position: sticky; top: 0; z-index: 3;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(10px);
    padding: 0.85rem 0 0.75rem;
    border-bottom: 1px solid var(--line);
    margin-bottom: 1rem;
  }
  .title-row {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 0.75rem; flex-wrap: wrap;
  }
  h1 {
    margin: 0; font-size: 1.2rem; font-weight: 600;
    letter-spacing: -0.025em;
  }
  .range { color: var(--mute); font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.5rem; }
  .live {
    display: inline-flex; align-items: center; gap: 0.35rem;
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent);
    border-radius: 999px; padding: 0.12rem 0.5rem;
  }
  .live::before {
    content: ""; width: 0.4rem; height: 0.4rem; border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .live.off { color: var(--mute); border-color: var(--line); }
  .live.off::before { background: var(--mute); box-shadow: none; animation: none; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  @media (prefers-reduced-motion: reduce) {
    .live::before { animation: none; }
  }
  .stats {
    display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.7rem;
  }
  .stat {
    font-size: 0.75rem; font-variant-numeric: tabular-nums;
    color: var(--mute); background: var(--card);
    border: 1px solid var(--line); border-radius: 999px;
    padding: 0.2rem 0.6rem;
  }
  .stat b { color: var(--fg); font-weight: 650; margin-left: 0.25rem; }
  .stat.bad b { color: var(--bad); }
  .stat.warn b { color: var(--warn); }
  .stat.ok b { color: var(--ok); }
  .identity {
    margin-top: 0.45rem; color: var(--mute); font-size: 0.78rem;
    word-break: break-word;
  }
  .modeb {
    display: inline-block; font-size: 0.6rem; font-weight: 700;
    color: var(--mute); border: 1px solid var(--line); border-radius: 4px;
    padding: 0 0.28rem; line-height: 1.1rem; vertical-align: baseline;
  }
  .panel {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 12px; padding: 0.7rem 0.9rem 0.8rem; margin-bottom: 1rem;
  }
  .panel h2 {
    margin: 0 0 0.5rem; font-size: 0.72rem; font-weight: 700;
    letter-spacing: 0.07em; text-transform: uppercase; color: var(--day);
  }
  .panel .sub { margin: 0 0 0.45rem; color: var(--mute); font-size: 0.8rem; }
  .panel .line { margin: 0.25rem 0; font-size: 0.84rem; word-break: break-word; }
  .panel .mute { color: var(--mute); }
  .panel .small { font-size: 0.74rem; }
  .rows {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 0.3rem;
    font-size: 0.82rem;
  }
  .rows li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem; min-width: 0; }
  .rows li.mute { color: var(--mute); }
  .rows .sid, .rows code {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem; word-break: break-all;
  }
  .rows .cnt { color: var(--mute); font-size: 0.76rem; }
  .rows .rel { margin-left: auto; color: var(--mute); font-size: 0.74rem; white-space: nowrap; }
  .rows .hint {
    font-size: 0.72rem; border-bottom: 1px dotted var(--mute); cursor: help;
  }
  .wdot {
    width: 0.5rem; height: 0.5rem; border-radius: 50%; flex: none;
    align-self: center; background: var(--mute);
  }
  .wdot.allow { background: var(--ok); }
  .wdot.hold { background: var(--warn); }
  .wdot.deny, .wdot.never { background: var(--bad); }
  .chiprow { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .chip {
    font-size: 0.76rem; color: var(--mute);
    background: color-mix(in srgb, var(--bg) 55%, var(--card));
    border: 1px solid var(--line); border-radius: 999px; padding: 0.15rem 0.55rem;
  }
  .chip code {
    font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
    color: var(--fg); font-size: 0.74rem;
  }
  .tbl { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .tbl th {
    text-align: left; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--mute); padding: 0.15rem 0.5rem 0.3rem 0;
  }
  .tbl td { padding: 0.2rem 0.5rem 0.2rem 0; border-top: 1px solid var(--line); }
  .tbl code {
    font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 0.76rem;
  }
  .pill {
    display: inline-block; font-size: 0.7rem; font-weight: 700;
    letter-spacing: 0.04em; text-transform: uppercase;
    border-radius: 999px; padding: 0.1rem 0.55rem;
    border: 1px solid var(--line); color: var(--mute);
  }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
  .pill.orr-green { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
  .pill.orr-amber { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .pill.orr-red { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
  .orrline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.55rem; }
  .orrline .disp { font-size: 0.84rem; font-weight: 600; }
  .alert {
    display: flex; flex-wrap: wrap; gap: 0.45rem 0.75rem; align-items: baseline;
    background: color-mix(in srgb, var(--bad) 12%, var(--card));
    border: 1px solid color-mix(in srgb, var(--bad) 35%, var(--line));
    border-radius: 10px; padding: 0.65rem 0.85rem; margin-bottom: 1rem;
    font-size: 0.85rem;
  }
  .alert strong { color: var(--bad); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .alert code {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
  }
  .feed {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
  }
  .day {
    padding: 0.55rem 0.9rem 0.35rem;
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--day);
    background: color-mix(in srgb, var(--bg) 55%, var(--card));
    border-bottom: 1px solid var(--line);
  }
  .ev {
    display: grid; grid-template-columns: 1.1rem 1fr; gap: 0;
    border-bottom: 1px solid var(--line);
  }
  .ev:last-child { border-bottom: none; }
  .rail {
    position: relative;
    display: flex; justify-content: center;
    padding-top: 1.05rem;
  }
  .rail::before {
    content: ""; position: absolute; top: 0; bottom: 0; left: 50%;
    width: 1px; background: var(--rail); transform: translateX(-50%);
  }
  .tick {
    width: 0.55rem; height: 0.55rem; border-radius: 50%;
    background: var(--mute); position: relative; z-index: 1;
    box-shadow: 0 0 0 3px var(--card);
  }
  .ev.ok .tick { background: var(--ok); }
  .ev.bad .tick { background: var(--bad); }
  .ev.warn .tick { background: var(--warn); }
  .ev.never { background: color-mix(in srgb, var(--bad) 7%, transparent); }
  .main { padding: 0.7rem 0.85rem 0.7rem 0.35rem; min-width: 0; }
  .top {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.55rem;
  }
  @media (max-width: 480px) {
    .when { flex-basis: 100%; margin-left: 0; margin-top: 0.1rem; }
  }
  .verdict {
    font-size: 0.68rem; font-weight: 750; letter-spacing: 0.05em;
    min-width: 2.6rem;
  }
  .ev.ok .verdict { color: var(--ok); }
  .ev.bad .verdict { color: var(--bad); }
  .ev.warn .verdict { color: var(--warn); }
  .tool {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.84rem; word-break: break-word; flex: 1 1 auto;
  }
  .when {
    margin-left: auto; color: var(--mute); font-size: 0.72rem;
    font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .when .rel { opacity: 0.85; margin-left: 0.35rem; }
  .summary {
    margin-top: 0.2rem;
    font-size: 0.84rem;
    color: var(--fg);
    word-break: break-word;
  }
  details.diff {
    margin-top: 0.35rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg) 55%, var(--card));
    overflow: hidden;
  }
  details.diff > summary {
    cursor: pointer;
    list-style: none;
    padding: 0.35rem 0.55rem;
    font-size: 0.72rem;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--mute);
  }
  details.diff > summary::-webkit-details-marker { display: none; }
  details.diff pre {
    margin: 0;
    padding: 0.45rem 0.55rem 0.6rem;
    border-top: 1px solid var(--line);
    font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
    font-size: 0.72rem;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg);
  }
  .meta {
    margin-top: 0.18rem; color: var(--mute); font-size: 0.76rem;
    display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: baseline;
  }
  .dot { opacity: 0.55; }
  .empty { margin: 0; padding: 1.25rem 1rem; color: var(--mute); font-size: 0.9rem; }
  .tools {
    margin-top: 1.1rem; display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center;
  }
  .tools .label {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--mute); margin-right: 0.25rem;
  }
  .tools code {
    font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
    font-size: 0.72rem; color: var(--mute);
    background: var(--card); border: 1px solid var(--line);
    border-radius: 6px; padding: 0.18rem 0.4rem;
  }
</style>
</head>
<body>
<main>
  <header class="bar">
    <div class="title-row">
      <h1>${esc(model.title)}</h1>
      <div class="range">${esc(model.rangeLabel)}${livePill}</div>
    </div>
    ${identityLine(model.identity)}
    <div class="stats" aria-label="Counts">
      <span class="stat ok">Allow<b>${c.allow}</b></span>
      <span class="stat bad">Deny<b>${c.deny}</b></span>
      <span class="stat warn">Hold<b>${c.require}</b></span>
      <span class="stat">Never<b>${c.never}</b></span>
      ${chips.modes}${chips.planes}
    </div>
    ${chips.products}
    ${chips.projects}
  </header>
  ${blockedBanner}
  <section class="feed" id="feed" aria-label="Activity feed">
${renderFeed(events, nowMs, model.live)}
  </section>
  ${sessionsPanel(agg, nowMs)}
  ${reasonsPanel(agg)}
  ${wiredHostsPanel(model.wiredHosts)}
  ${sandboxesPanel(model.sandboxes, nowMs)}
  ${orrPanel(model.orr, nowMs)}
  ${showbackPanel(model.showback)}
  ${toolsHtml}
</main>
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
    `Allow ${c.allow} | Deny ${c.deny} | Hold ${c.require} | Never ${c.never}`,
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
