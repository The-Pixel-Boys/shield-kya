/**
 * `kya investigate` core: deterministic detectors + incident grouping +
 * fix briefs over the local trail. Pure analysis, no LLM calls, no IO;
 * the CLI wires readTrail() output into investigateTrail().
 */
import type { TrailEvent } from "../trail.js";
import { runDetectors, type Finding, type Severity } from "./detectors.js";
import { groupIncidents, type Incident } from "./incidents.js";
import { renderFixBrief } from "./fix-brief.js";

export type { DetectorId, Finding, Severity } from "./detectors.js";
export type { Incident } from "./incidents.js";
export { detectorTitle } from "./incidents.js";
export { renderFixBrief } from "./fix-brief.js";
export {
  buildInvestigateLastRun,
  INVESTIGATE_LAST_FILE,
  investigateLastRunPath,
  loadInvestigateLastRun,
  writeInvestigateLastRun,
  type InvestigateLastRun,
  type InvestigateLastRunFinding,
} from "./last-run.js";

export interface InvestigateOptions {
  /** Cap the number of incidents listed in the plain-text report. */
  readonly topIncidents?: number;
}

export interface InvestigateResult {
  readonly findings: readonly Finding[];
  readonly incidents: readonly Incident[];
  /** incidentId -> markdown fix brief. */
  readonly briefs: ReadonlyMap<string, string>;
}

export function investigateTrail(
  events: readonly TrailEvent[],
  _opts: InvestigateOptions = {},
): InvestigateResult {
  const findings = runDetectors(events);
  const incidents = groupIncidents(findings, events);
  const briefs = new Map<string, string>();
  for (const incident of incidents) {
    briefs.set(incident.id, renderFixBrief(incident));
  }
  return { findings, incidents, briefs };
}

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

/** Plain-text summary for the CLI: counts by severity, then top incidents. */
export function renderInvestigateReport(
  result: InvestigateResult,
  opts: InvestigateOptions = {},
): string {
  const top = opts.topIncidents ?? 10;
  const lines: string[] = [];
  lines.push("kya investigate - local trail analysis");
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("No findings. The trail looks clean for all detectors.");
    return lines.join("\n");
  }
  const bySeverity = new Map<Severity, number>();
  for (const f of result.findings) {
    bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  }
  lines.push(
    `Findings: ${result.findings.length} (${SEVERITY_ORDER
      .filter((s) => bySeverity.has(s))
      .map((s) => `${s}: ${bySeverity.get(s)}`)
      .join(", ")})`,
  );
  lines.push(`Incidents: ${result.incidents.length}`);
  lines.push("");
  lines.push("Top incidents:");
  for (const incident of result.incidents.slice(0, top)) {
    lines.push(
      `- [${incident.severity}] ${incident.title} ` +
        `(${incident.findingCount} finding${incident.findingCount === 1 ? "" : "s"}, ` +
        `last ${incident.lastTs || "unknown"}, id ${incident.id})`,
    );
  }
  if (result.incidents.length > top) {
    lines.push(`- ... and ${result.incidents.length - top} more`);
  }
  return lines.join("\n");
}
