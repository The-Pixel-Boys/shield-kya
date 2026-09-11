/**
 * Activity feed HTML/MD for local trail events.
 */
import { assertNoSecrets, clip } from "../dash/render.js";
import { clipMultiline, DIFF_MAX_TOTAL_CHARS } from "../diff-preview.js";
import { productLabel, readTrail, readTrailSince, type TrailEvent } from "../trail.js";

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
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  };
}

/** Shared loader for static artifacts and the live loopback server. */
export function loadReceiptModel(input: {
  readonly cwd: string;
  readonly sessionId?: string;
  readonly days: number;
  readonly live?: boolean;
}): ReceiptModel {
  const days = input.days > 0 ? Math.floor(input.days) : 3;
  if (input.sessionId) {
    return buildReceiptModel(input.sessionId, readTrail(input.cwd), { live: input.live });
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return buildWindowReceiptModel(readTrailSince(input.cwd, since), days, { live: input.live });
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
      <span class="verdict">${esc(verdictWord(e.verdict))}</span>
      <code class="tool">${esc(e.toolId)}</code>
      <time class="when" datetime="${esc(e.ts)}" title="${esc(e.ts)}">${esc(clock(e.ts))} <span class="rel">${esc(relativeTime(e.ts, nowMs))}</span></time>
    </div>
    ${summary}
    ${preview}
    <div class="meta">
      <span class="product">${esc(productLabel(e.product))}</span>
      <span class="dot">-</span>
      <span class="reason">${esc(e.reasonCode)}</span>
    </div>
  </div>
</article>`);
  }
  return parts.join("\n");
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

  const liveScript = model.live
    ? `<script>
(function(){
  var pill = document.querySelector('.live');
  var es = new EventSource('/events');
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
    position: sticky; top: 4.2rem; z-index: 1;
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
    <div class="stats" aria-label="Counts">
      <span class="stat ok">Allow<b>${c.allow}</b></span>
      <span class="stat bad">Deny<b>${c.deny}</b></span>
      <span class="stat warn">Hold<b>${c.require}</b></span>
      <span class="stat">Never<b>${c.never}</b></span>
    </div>
  </header>
  ${blockedBanner}
  <section class="feed" id="feed" aria-label="Activity feed">
${renderFeed(events, nowMs, model.live)}
  </section>
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
  const lines = [
    `# ${model.title}`,
    "",
    model.rangeLabel,
    "",
    `Allow ${c.allow} | Deny ${c.deny} | Hold ${c.require} | Never ${c.never}`,
    "",
    "## Feed",
    ...[...model.events]
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .flatMap((e) => {
        const sum = e.summary?.trim() ? ` - ${e.summary.trim()}` : "";
        const head = `- **${verdictWord(e.verdict)}** \`${e.toolId}\`${sum} - ${productLabel(e.product)} - ${e.reasonCode}`;
        if (!e.diffPreview?.trim()) return [head];
        return [head, "", "```", e.diffPreview.trim(), "```", ""];
      }),
  ];
  const md = `${lines.join("\n")}\n`;
  assertNoSecrets(md);
  return md;
}
