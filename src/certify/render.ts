/**
 * Markdown + standalone HTML rendering for the certify gap report.
 * Same visual language as the activity receipt (pills, panels, dark/light),
 * own minimal CSS — the certify page is fully standalone and offline.
 */
import { assertNoSecrets, clip, stripEscapes } from "../dash/render.js";
import type {
  CertifyReport,
  CertifyRequirementResult,
  RequirementStatus,
} from "./evaluate.js";

const DOMAIN_LABELS: Record<string, string> = {
  "data-privacy": "Data & Privacy",
  security: "Security",
  safety: "Safety",
  reliability: "Reliability",
  accountability: "Accountability",
  society: "Society",
};

/** Catalog order of domains, derived from requirement order in the report. */
export function domainOrder(report: CertifyReport): string[] {
  const seen: string[] = [];
  for (const r of report.requirements) {
    if (!seen.includes(r.domain)) seen.push(r.domain);
  }
  return seen;
}

function mdText(s: string): string {
  return stripEscapes(s)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/([[\]<>])/g, "\\$1");
}

export function formatCertifyMarkdown(report: CertifyReport): string {
  const o = report.overall;
  const lines: string[] = [
    `# Certify: ${mdText(report.catalog.id)} v${mdText(report.catalog.version)}`,
    "",
    `- **Result:** ${o.result === "gap" ? "GAP" : "PASS"}`,
    `- **Generated:** ${mdText(report.generatedAt)}`,
    `- **Window:** last ${report.window.days} days (${mdText(report.window.since)} → ${mdText(report.window.until)})`,
    `- **Trail:** ${report.trail.eventCount} events in window — allow ${report.trail.verdictMix.ALLOW} · deny ${report.trail.verdictMix.DENY} · review ${report.trail.verdictMix.REQUIRE_APPROVE}`,
    `- **Tally:** ${o.pass} pass · ${o.gap} gap · ${o.insufficientEvidence} insufficient evidence · ${o.attested} attested`,
    "",
    "## Gaps (work plan)",
  ];
  const gaps = report.requirements.filter((r) => r.status === "gap");
  if (gaps.length === 0) {
    lines.push(
      o.result === "gap"
        ? "- No certifiable evidence in this window — every requirement is insufficient_evidence. Run the gate first (kya wrap / kya connect), then re-run kya certify."
        : "- (none)",
    );
  } else {
    for (const r of gaps) {
      lines.push(`- **${r.id}** [${r.severity}] ${mdText(r.title)} — ${mdText(r.evidence)}`);
    }
  }
  lines.push("");
  for (const domain of domainOrder(report)) {
    const rows = report.requirements.filter((r) => r.domain === domain);
    if (rows.length === 0) continue;
    lines.push(
      `## ${mdText(DOMAIN_LABELS[domain] ?? domain)}`,
      "",
      "| Req | Severity | Status | Evidence |",
      "|-----|----------|--------|----------|",
    );
    for (const r of rows) {
      lines.push(`| ${r.id} | ${r.severity} | ${r.status} | ${mdText(r.evidence)} |`);
    }
    lines.push("");
  }
  lines.push(
    "---",
    "*kya certify is evidence-only: it reports local facts, never a policy decision. Sole PEP remains Shield KYA (ALLOW / DENY / REQUIRE_APPROVE). Attestations are operator statements recorded locally and are unverified.*",
  );
  const md = `${lines.join("\n")}\n`;
  assertNoSecrets(md);
  return md;
}

function esc(s: string): string {
  return stripEscapes(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_TONE: Record<RequirementStatus, string> = {
  pass: "ok",
  gap: "bad",
  insufficient_evidence: "warn",
  attested: "mute",
};

function requirementRow(r: CertifyRequirementResult): string {
  const att = r.attestation
    ? `<div class="att">attested ${esc(r.attestation.at)} — ${esc(clip(r.attestation.text, 200))}</div>`
    : "";
  return `    <li class="req">
      <span class="pill ${STATUS_TONE[r.status]}">${esc(r.status.replace(/_/g, " "))}</span>
      <span class="rid">${esc(r.id)}</span>
      <span class="sev ${esc(r.severity)}">${esc(r.severity)}</span>
      <div class="rbody">
        <div class="rtitle">${esc(clip(r.title, 120))}</div>
        <div class="evi">${esc(clip(r.evidence, 240))}</div>
        ${att}
      </div>
    </li>`;
}

export function renderCertifyHtml(report: CertifyReport): string {
  const o = report.overall;
  const gaps = report.requirements.filter((r) => r.status === "gap");
  const gapList =
    gaps.length === 0
      ? o.result === "gap"
        ? `<p class="empty">No certifiable evidence in this window — every requirement is insufficient evidence. Run the gate first (kya wrap / kya connect), then re-run kya certify.</p>`
        : `<p class="empty">No gaps. Evidence-only report — not a certificate.</p>`
      : `<ol class="gaps">
${gaps
  .map(
    (r) =>
      `    <li><strong>${esc(r.id)}</strong> <span class="sev ${esc(r.severity)}">${esc(r.severity)}</span> ${esc(clip(r.title, 120))}<br/><span class="mute">${esc(clip(r.evidence, 240))}</span></li>`,
  )
  .join("\n")}
</ol>`;
  const domainSections = domainOrder(report)
    .map((domain) => {
      const rows = report.requirements.filter((r) => r.domain === domain);
      if (rows.length === 0) return "";
      return `<section class="panel" aria-label="${esc(domain)}">
  <h2>${esc(DOMAIN_LABELS[domain] ?? domain)}</h2>
  <ul class="reqs">
${rows.map((r) => requirementRow(r)).join("\n")}
  </ul>
</section>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Certify — ${esc(report.catalog.id)} v${esc(report.catalog.version)}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0c10; --fg: #eef2f7; --mute: #8b95a8; --line: #1c2330;
    --card: #10141c; --ok: #3ecf8e; --bad: #ff5d5d; --warn: #f0b429; --day: #6b7280;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f3f5f8; --fg: #0f172a; --mute: #64748b; --line: #e2e8f0;
      --card: #ffffff; --ok: #059669; --bad: #dc2626; --warn: #d97706; --day: #64748b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg); line-height: 1.4;
    font-family: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; padding: 1.35rem 1rem 3rem; }
  h1 { margin: 0; font-size: 1.2rem; font-weight: 600; letter-spacing: -0.025em; }
  h1 code {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9rem; color: var(--mute);
  }
  .sub { color: var(--mute); font-size: 0.8rem; margin-top: 0.3rem; }
  .result {
    display: inline-block; margin-top: 0.6rem; font-size: 0.8rem; font-weight: 750;
    letter-spacing: 0.05em; text-transform: uppercase; border-radius: 999px;
    padding: 0.2rem 0.8rem; border: 1px solid var(--line);
  }
  .result.gap { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
  .result.pass { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
  .stats { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.7rem 0 1rem; }
  .stat {
    font-size: 0.75rem; font-variant-numeric: tabular-nums; color: var(--mute);
    background: var(--card); border: 1px solid var(--line); border-radius: 999px;
    padding: 0.2rem 0.6rem;
  }
  .stat b { color: var(--fg); font-weight: 650; margin-left: 0.25rem; }
  .stat.bad b { color: var(--bad); }
  .stat.warn b { color: var(--warn); }
  .stat.ok b { color: var(--ok); }
  .gaps { margin: 0 0 1rem; padding-left: 1.2rem; font-size: 0.85rem; }
  .gaps li { margin-bottom: 0.4rem; }
  .panel {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 12px; padding: 0.7rem 0.9rem 0.8rem; margin-bottom: 1rem;
  }
  .panel h2 {
    margin: 0 0 0.5rem; font-size: 0.72rem; font-weight: 700;
    letter-spacing: 0.07em; text-transform: uppercase; color: var(--day);
  }
  .reqs { list-style: none; margin: 0; padding: 0; }
  .req {
    display: grid; grid-template-columns: auto auto auto 1fr; gap: 0.5rem;
    align-items: baseline; padding: 0.35rem 0; border-top: 1px solid var(--line);
  }
  .req:first-child { border-top: none; }
  .pill {
    display: inline-block; font-size: 0.68rem; font-weight: 700;
    letter-spacing: 0.04em; text-transform: uppercase; border-radius: 999px;
    padding: 0.1rem 0.55rem; border: 1px solid var(--line); color: var(--mute);
    white-space: nowrap;
  }
  .pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
  .pill.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
  .pill.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .rid {
    font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem; font-weight: 650;
  }
  .sev { font-size: 0.68rem; text-transform: uppercase; color: var(--mute); }
  .sev.critical, .sev.high { color: var(--bad); }
  .sev.medium { color: var(--warn); }
  .rtitle { font-size: 0.86rem; font-weight: 600; }
  .evi { font-size: 0.78rem; color: var(--mute); word-break: break-word; }
  .att { font-size: 0.76rem; color: var(--fg); margin-top: 0.15rem; word-break: break-word; }
  .mute { color: var(--mute); }
  .empty { color: var(--mute); font-size: 0.9rem; }
  footer.doc {
    margin-top: 1.2rem; color: var(--mute); font-size: 0.74rem;
    border-top: 1px solid var(--line); padding-top: 0.7rem;
  }
</style>
</head>
<body>
<main>
  <h1>Certify — <code>${esc(report.catalog.id)} v${esc(report.catalog.version)}</code></h1>
  <div class="sub">generated ${esc(report.generatedAt)} · window last ${report.window.days} days (${esc(report.window.since)} → ${esc(report.window.until)}) · ${report.trail.eventCount} trail events in window</div>
  <span class="result ${o.result}">${o.result === "gap" ? "GAP" : "PASS"}</span>
  <div class="stats" role="group" aria-label="Tally">
    <span class="stat ok">Pass <b>${o.pass}</b></span>
    <span class="stat bad">Gap <b>${o.gap}</b></span>
    <span class="stat warn">Insufficient evidence <b>${o.insufficientEvidence}</b></span>
    <span class="stat">Attested <b>${o.attested}</b></span>
  </div>
  <section class="panel" aria-label="Gaps">
    <h2>Gaps (work plan)</h2>
    ${gapList}
  </section>
  ${domainSections}
  <footer class="doc">
    kya certify is evidence-only: it reports local facts, never a policy decision.
    Sole PEP remains Shield KYA (ALLOW / DENY / REQUIRE_APPROVE). Attestations are
    unverified operator statements recorded locally. This report is not a certificate.
  </footer>
</main>
</body>
</html>`;

  // Defense-in-depth: block known secret shapes before writing the artifact.
  assertNoSecrets(html);
  return html;
}
