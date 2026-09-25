/**
 * Complete stylesheet for the receipt report HTML artifact.
 *
 * The page must stay fully offline/standalone: system font stacks only, no
 * external URLs of any kind. Colors come from the --bg/--fg/--mute/--line/
 * --card base tokens plus the --ok/--warn/--bad tone family; dark is the
 * default and light rides on prefers-color-scheme, with translucency done via
 * color-mix so both schemes share one rule set.
 *
 * Tab switching is pure CSS: nav links point at #overview/#changes/#certify/
 * #activity/#system and :target shows the matching zone. The hide rules are
 * gated behind
 * `@supports selector(body:has(*))`, so a browser without :has() simply shows
 * every zone stacked — degraded, but nothing is ever hidden unreachable.
 */
export function receiptCss(): string {
  return `
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
  main { max-width: 74rem; margin: 0 auto; padding: 1.35rem 1.25rem 3.5rem; }
  /* Sticky top zone: header + tab nav stay pinned as one unit, so a fragment
     jump to a zone never strands the nav behind the header. */
  .topstick {
    position: sticky; top: 0; z-index: 6;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line);
    margin-bottom: 1rem;
  }
  header.bar {
    padding: 0.85rem 0 0.4rem;
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
  /* Hero KPI grid: Certify spans two columns on wide layouts, 4→2→1. Every
     hero card is a direct .panel child — one chrome, no wrapper special-cases. */
  .hero {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 1rem; margin-bottom: 1.25rem; align-items: stretch;
  }
  .hero > .panel { margin-bottom: 0; height: 100%; }
  .hero-certify { grid-column: span 2; min-width: 0; }
  /* Result-tone accent: inset bar so the border box never shifts. */
  .hero-certify.pass {
    border-color: color-mix(in srgb, var(--ok) 40%, var(--line));
    box-shadow: inset 3px 0 0 var(--ok);
  }
  .hero-certify.gap {
    border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
    box-shadow: inset 3px 0 0 var(--warn);
  }
  /* Hero result pill reads larger than inline status pills. */
  .hero-certify .pill { font-size: 0.82rem; padding: 0.22rem 0.75rem; }
  /* Status legend + attested summary: small muted single lines under the
     count tiles; allowed to wrap on narrow viewports. */
  .hero-certify .legend, .hero-certify .att-line {
    margin: 0.3rem 0 0; font-size: 0.72rem; color: var(--mute);
    overflow-wrap: break-word;
  }
  /* Evidence one-liner sits beneath its gap row (the row is a flex-wrap). */
  .hero-certify .rows .gap-ev {
    flex-basis: 100%; color: var(--mute); font-size: 0.74rem;
    overflow-wrap: break-word;
  }
  @media (max-width: 1100px) {
    .hero { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 720px) {
    main { padding: 1.1rem 0.85rem 3rem; }
  }
  @media (max-width: 480px) {
    .hero { grid-template-columns: 1fr; }
    .hero-certify { grid-column: span 1; }
  }
  .kpi-row { display: flex; flex-wrap: wrap; gap: 0.8rem 1.2rem; }
  .kpi { display: flex; flex-direction: column; gap: 0.1rem; min-width: 2.8rem; }
  .kpi-num {
    font-size: 1.55rem; font-weight: 700; line-height: 1.15;
    font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
  }
  .kpi-num.ok { color: var(--ok); }
  .kpi-num.warn { color: var(--warn); }
  .kpi-num.bad { color: var(--bad); }
  .kpi-num.mute { color: var(--mute); }
  .kpi-lab {
    font-size: 0.66rem; font-weight: 700; letter-spacing: 0.07em;
    text-transform: uppercase; color: var(--mute);
  }
  /* Static verdict mix bars (hero) — same visual language as .db-item but
     non-interactive: no hover, no aria-pressed, no data-fgroup. */
  .mix { display: flex; flex-direction: column; gap: 0.32rem; }
  .mix-row {
    display: grid; grid-template-columns: 3.4rem 1fr minmax(1.8rem, auto);
    gap: 0.55rem; align-items: center; font-size: 0.76rem;
  }
  .mix-lab { color: var(--mute); font-weight: 600; }
  .mix-bar {
    height: 0.55rem; border-radius: 4px; overflow: hidden;
    background: color-mix(in srgb, var(--bg) 55%, var(--card));
  }
  .mix-fill { display: block; height: 100%; border-radius: 4px; }
  .mix-fill.ok { background: var(--ok); }
  .mix-fill.warn { background: var(--warn); }
  .mix-fill.bad { background: var(--bad); }
  .mix-num { text-align: right; color: var(--fg); font-variant-numeric: tabular-nums; }
  /* Inline SVG sparkline: bars normalized to viewBox height, flat baseline. */
  .spark { display: block; width: 100%; height: 2.2rem; margin-top: 0.5rem; }
  .spark rect { fill: color-mix(in srgb, var(--ok) 65%, var(--mute)); }
  .spark line.base { stroke: var(--rail); stroke-width: 1; }
  /* Severity chips (certify gap rows): critical/high signal, medium/low quiet. */
  .sev {
    display: inline-block; font-size: 0.62rem; font-weight: 700;
    letter-spacing: 0.05em; text-transform: uppercase; line-height: 1.05rem;
    border: 1px solid var(--line); border-radius: 4px; padding: 0 0.35rem;
    color: var(--mute);
  }
  .sev.critical { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
  .sev.high { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .sev.medium { color: var(--day); }
  .sev.low { color: var(--mute); }
  /* Tabs: pure-CSS :target switching, no JS. Without :has() support the hide
     rules never apply and every zone stays visible (degraded but complete). */
  .tabs {
    display: flex; gap: 0.25rem; flex-wrap: wrap;
  }
  .tab {
    padding: 0.45rem 0.85rem; margin-bottom: -1px;
    font-size: 0.8rem; font-weight: 600; color: var(--mute);
    text-decoration: none;
    border: 1px solid transparent; border-bottom: none;
    border-radius: 8px 8px 0 0;
  }
  .tab:hover { color: var(--fg); }
  .tab:focus-visible {
    outline: 2px solid var(--ok);
    outline-offset: 2px;
    color: var(--fg);
  }
  /* Narrow screens: tabs stop wrapping and scroll horizontally instead.
     Padding keeps the focus outline (2px + 2px offset) inside the scrollport. */
  @media (max-width: 480px) {
    .tabs {
      flex-wrap: nowrap; overflow-x: auto;
      scrollbar-width: thin;
      padding: 4px;
    }
    .tab { flex: none; }
  }
  .zone { scroll-margin-top: 6.4rem; }
  .zone-empty { margin: 0.25rem 0 0.5rem; }
  @supports selector(body:has(*)) {
    #changes, #activity, #certify, #system { display: none; }
    #overview:target, #changes:target, #activity:target, #certify:target, #system:target { display: block; }
    body:has(#changes:target) #overview,
    body:has(#activity:target) #overview,
    body:has(#certify:target) #overview,
    body:has(#system:target) #overview { display: none; }
    body:not(:has(.zone:target)) .tab[href="#overview"],
    body:has(#overview:target) .tab[href="#overview"],
    body:has(#changes:target) .tab[href="#changes"],
    body:has(#certify:target) .tab[href="#certify"],
    body:has(#activity:target) .tab[href="#activity"],
    body:has(#system:target) .tab[href="#system"] {
      color: var(--fg);
      background: var(--card);
      border-color: var(--line);
    }
  }
  .feed-head { margin-bottom: 0.9rem; }
  .stats {
    display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.7rem;
  }
  .feed-head .stats:first-child { margin-top: 0; }
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
  button.stat {
    font-family: inherit; cursor: pointer;
    appearance: none; -webkit-appearance: none;
  }
  button.stat:hover { border-color: var(--mute); }
  .stat[aria-pressed="true"] {
    color: var(--fg);
    border-color: color-mix(in srgb, var(--ok) 55%, var(--line));
    background: color-mix(in srgb, var(--ok) 12%, var(--card));
  }
  .stat[hidden] { display: none; }
  .clear-filters { color: var(--mute); font-size: 0.72rem; }
  /* Analytics dashboard: 2×2 card grid, collapses to one column on narrow. */
  .db-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 0.9rem 1.1rem;
  }
  @media (max-width: 700px) {
    .db-grid { grid-template-columns: 1fr; }
  }
  .db-card { min-width: 0; }
  .db-card h3 {
    margin: 0 0 0.4rem; font-size: 0.68rem; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--mute);
  }
  .db-card h3 .mute { text-transform: none; letter-spacing: 0.02em; font-weight: 600; }
  .db-card .sub {
    margin: 0.35rem 0 0.15rem; font-size: 0.66rem; font-weight: 700;
    letter-spacing: 0.05em; text-transform: uppercase; color: var(--day);
  }
  /* Filter-linked bar row: block variant of .stat's hover/active contract. */
  .db-item {
    display: grid; grid-template-columns: 6.5rem 1fr 2.4rem;
    gap: 0.5rem; align-items: center; width: 100%;
    font-family: inherit; font-size: 0.76rem; font-variant-numeric: tabular-nums;
    color: var(--mute); text-align: left;
    background: transparent; border: 1px solid transparent; border-radius: 8px;
    padding: 0.14rem 0.3rem; cursor: pointer;
    appearance: none; -webkit-appearance: none;
  }
  .db-item:hover { border-color: var(--line); background: color-mix(in srgb, var(--bg) 55%, var(--card)); }
  .db-item[aria-pressed="true"] {
    color: var(--fg);
    border-color: color-mix(in srgb, var(--ok) 55%, var(--line));
    background: color-mix(in srgb, var(--ok) 12%, var(--card));
  }
  .db-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .db-bar {
    height: 0.55rem; border-radius: 4px; overflow: hidden;
    background: color-mix(in srgb, var(--bg) 55%, var(--card));
  }
  .db-fill { display: block; height: 100%; border-radius: 4px; }
  .db-fill.ok { background: var(--ok); }
  .db-fill.warn { background: var(--warn); }
  .db-fill.bad { background: var(--bad); }
  .db-num { text-align: right; color: var(--fg); }
  /* Session rollup row as a filter toggle: db-item's hover/active contract
     on the flex layout the Sessions panel already uses. */
  .sess-item {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem;
    width: 100%; min-width: 0;
    font-family: inherit; font-size: inherit; text-align: left;
    color: inherit; background: transparent;
    border: 1px solid transparent; border-radius: 8px;
    padding: 0.14rem 0.3rem; cursor: pointer;
    appearance: none; -webkit-appearance: none;
  }
  .sess-item:hover {
    border-color: var(--line);
    background: color-mix(in srgb, var(--bg) 55%, var(--card));
  }
  .sess-item[aria-pressed="true"] {
    color: var(--fg);
    border-color: color-mix(in srgb, var(--ok) 55%, var(--line));
    background: color-mix(in srgb, var(--ok) 12%, var(--card));
  }
  /* Vertical mini-bar timeline (not clickable — no time filter exists). */
  .db-tl { display: flex; align-items: stretch; gap: 2px; height: 4.6rem; }
  .db-tl .col {
    flex: 1 1 0; min-width: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: flex-end; gap: 0.15rem;
  }
  .db-vbar {
    width: 100%; min-height: 2px; border-radius: 2px 2px 0 0;
    background: color-mix(in srgb, var(--ok) 75%, var(--mute));
  }
  .db-tl .lab {
    font-size: 0.52rem; color: var(--mute); white-space: nowrap;
    overflow: hidden; max-width: 100%; font-variant-numeric: tabular-nums;
  }
  /* utility: must beat .ev's display:grid (same specificity, later rule would win) */
  .filtered-out { display: none !important; }
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
  .rows li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem; min-width: 0; overflow-wrap: break-word; }
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
  /* Certify detail table: domains as small-caps heading rows with mini-counts,
     requirement rows as pill + id + title with the evidence/attestation line
     beneath (the .rows li is a flex-wrap). */
  .certify-detail .dom { margin-top: 0.85rem; }
  .certify-detail .dom-head {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem;
  }
  .certify-detail h3 {
    margin: 0; font-size: 0.72rem; font-weight: 700;
    letter-spacing: 0.07em; text-transform: uppercase; color: var(--day);
  }
  .certify-detail .dom-head .cnt { color: var(--mute); font-size: 0.76rem; }
  .certify-detail .rows { margin-top: 0.35rem; }
  .certify-detail .evi, .certify-detail .att {
    flex-basis: 100%; font-size: 0.74rem; color: var(--mute);
    overflow-wrap: break-word;
  }
  .certify-detail .att { color: var(--fg); }
  .wdot {
    width: 0.5rem; height: 0.5rem; border-radius: 50%; flex: none;
    align-self: center; background: var(--mute);
  }
  .wdot.allow { background: var(--ok); }
  .wdot.hold { background: var(--warn); }
  .wdot.deny, .wdot.never { background: var(--bad); }
  .chiprow { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .chip {
    font-size: 0.76rem; font-variant-numeric: tabular-nums; color: var(--mute);
    background: color-mix(in srgb, var(--bg) 55%, var(--card));
    border: 1px solid var(--line); border-radius: 999px; padding: 0.15rem 0.55rem;
  }
  .chip code {
    font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
    color: var(--fg); font-size: 0.74rem;
  }
  .tbl {
    width: 100%; border-collapse: collapse; font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  .tbl th {
    text-align: left; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--mute); padding: 0.15rem 0.5rem 0.3rem 0;
  }
  .tbl td { padding: 0.2rem 0.5rem 0.2rem 0; border-top: 1px solid var(--line); }
  .tbl tbody tr:hover { background: color-mix(in srgb, var(--bg) 55%, var(--card)); }
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
  /* Attested tone: neutral foreground — a signed statement, not evidence. */
  .pill.att { color: var(--fg); border-color: color-mix(in srgb, var(--fg) 35%, transparent); }
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
    max-width: 68ch;
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
  /* Changes tab: session → file groups in the same .feed card as the
     activity feed; entries reuse the feed's .top/.verdict/.tool/.when/diff. */
  .chg-sess-head {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem;
    padding: 0.55rem 0.9rem 0.35rem;
    background: color-mix(in srgb, var(--bg) 55%, var(--card));
    border-bottom: 1px solid var(--line);
  }
  .chg-sess-head .sid {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem; font-weight: 650; word-break: break-all;
  }
  .chg-sess-head .cnt { color: var(--mute); font-size: 0.76rem; }
  .chg-sess-head .rel {
    margin-left: auto; color: var(--mute); font-size: 0.74rem; white-space: nowrap;
  }
  .chg-file { border-bottom: 1px solid var(--line); padding: 0.45rem 0.9rem 0.6rem; }
  .chg-session:last-child .chg-file:last-child { border-bottom: none; }
  .chg-file-head {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem;
  }
  .chg-file-head .path {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem; font-weight: 650; word-break: break-all;
  }
  .chg-file-head .cnt { color: var(--mute); font-size: 0.74rem; white-space: nowrap; }
  .chg-file-head .pill { margin-left: auto; }
  .chg-entry { padding: 0.4rem 0 0.2rem; min-width: 0; }
  .chg-entry.never { background: color-mix(in srgb, var(--bad) 7%, transparent); }
  .chg-entry.ok .verdict { color: var(--ok); }
  .chg-entry.bad .verdict { color: var(--bad); }
  .chg-entry.warn .verdict { color: var(--warn); }
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
  }`;
}
