/**
 * Last-run summary for `kya investigate`, persisted to
 * <kya-home>/.kya/investigate-last.json so the report can render the most
 * recent analysis without re-running the detectors. Write side is called by
 * the investigate command; the read side (loadInvestigateLastRun) feeds the
 * receipt model. Both sides are best-effort and never throw.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import type { TrailEvent } from "../trail.js";
import type { DetectorId, Severity } from "./detectors.js";
import { detectorTitle } from "./incidents.js";
import type { InvestigateResult } from "./index.js";

/** File name inside the global .kya dir, shared by writer and loader. */
export const INVESTIGATE_LAST_FILE = "investigate-last.json";

/** Cap on the persisted/loaded summary; the real file is a few KB. */
const MAX_LAST_RUN_BYTES = 64 * 1024;
const MAX_TITLE_LEN = 160;
const MAX_SNIPPET_LEN = 800;
const BRIEF_SNIPPET_LINES = 8;

export interface InvestigateLastRunFinding {
  readonly detectorId: DetectorId;
  readonly severity: Severity;
  readonly title: string;
  /** Findings emitted by this detector in the run. */
  readonly count: number;
}

export interface InvestigateLastRun {
  readonly ranAt: string;
  /** Days covered by the analyzed trail (oldest to newest event, min 1). */
  readonly windowDays: number;
  readonly findings: readonly InvestigateLastRunFinding[];
  /** Number of grouped incidents. */
  readonly incidents: number;
  /** First lines of the top incident's markdown fix brief, when any. */
  readonly briefSnippet?: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Trail coverage in days, min 1; unparseable timestamps yield 1. */
function trailWindowDays(events: readonly TrailEvent[]): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 1;
  return Math.max(1, Math.ceil((max - min) / 86_400_000));
}

/** Compact per-detector rollup of one investigateTrail() result. */
export function buildInvestigateLastRun(
  result: InvestigateResult,
  events: readonly TrailEvent[],
  ranAt: string = new Date().toISOString(),
): InvestigateLastRun {
  const byDetector = new Map<DetectorId, { severity: Severity; count: number }>();
  for (const f of result.findings) {
    const cur = byDetector.get(f.detectorId);
    if (!cur) {
      byDetector.set(f.detectorId, { severity: f.severity, count: 1 });
    } else {
      cur.count += 1;
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.severity]) cur.severity = f.severity;
    }
  }
  const findings: InvestigateLastRunFinding[] = [...byDetector.entries()]
    .map(([detectorId, v]) => ({
      detectorId,
      severity: v.severity,
      title: detectorTitle(detectorId),
      count: v.count,
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        a.detectorId.localeCompare(b.detectorId),
    );

  // Incidents arrive severity-sorted from groupIncidents; the first one's
  // brief is the most actionable snippet for the report.
  const top = result.incidents[0];
  const brief = top ? result.briefs.get(top.id) : undefined;
  const briefSnippet = brief
    ? brief.split("\n").slice(0, BRIEF_SNIPPET_LINES).join("\n").slice(0, MAX_SNIPPET_LEN)
    : undefined;

  return {
    ranAt,
    windowDays: trailWindowDays(events),
    findings,
    incidents: result.incidents.length,
    ...(briefSnippet ? { briefSnippet } : {}),
  };
}

export function investigateLastRunPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), INVESTIGATE_LAST_FILE);
}

/** Persist the summary; a failed write must never fail the investigate command. */
export function writeInvestigateLastRun(
  summary: InvestigateLastRun,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    mkdirSync(globalConfigDir(env), { recursive: true });
    writeFileSync(investigateLastRunPath(env), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort side file */
  }
}

const SEVERITIES = new Set<string>(["low", "medium", "high", "critical"]);

function parseFinding(raw: unknown): InvestigateLastRunFinding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const f = raw as Record<string, unknown>;
  if (
    typeof f.detectorId !== "string" ||
    typeof f.severity !== "string" ||
    !SEVERITIES.has(f.severity) ||
    typeof f.title !== "string" ||
    typeof f.count !== "number" ||
    !Number.isFinite(f.count) ||
    f.count < 0
  ) {
    return undefined;
  }
  return {
    detectorId: f.detectorId as DetectorId,
    severity: f.severity as Severity,
    title: f.title.slice(0, MAX_TITLE_LEN),
    count: Math.floor(f.count),
  };
}

/**
 * Read the persisted summary for the report. Missing, oversize, or corrupt
 * state yields undefined - the report simply renders without the section.
 */
export function loadInvestigateLastRun(
  env: NodeJS.ProcessEnv = process.env,
): InvestigateLastRun | undefined {
  try {
    const path = investigateLastRunPath(env);
    if (!existsSync(path)) return undefined;
    if (statSync(path).size > MAX_LAST_RUN_BYTES) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    if (typeof o.ranAt !== "string" || !o.ranAt) return undefined;
    const windowDays =
      typeof o.windowDays === "number" && Number.isFinite(o.windowDays) && o.windowDays > 0
        ? Math.floor(o.windowDays)
        : 1;
    const incidents =
      typeof o.incidents === "number" && Number.isFinite(o.incidents) && o.incidents >= 0
        ? Math.floor(o.incidents)
        : 0;
    const findings = Array.isArray(o.findings)
      ? o.findings
          .map(parseFinding)
          .filter((f): f is InvestigateLastRunFinding => f !== undefined)
      : [];
    const briefSnippet =
      typeof o.briefSnippet === "string" && o.briefSnippet.trim()
        ? o.briefSnippet.slice(0, MAX_SNIPPET_LEN)
        : undefined;
    return {
      ranAt: o.ranAt,
      windowDays,
      findings,
      incidents,
      ...(briefSnippet ? { briefSnippet } : {}),
    };
  } catch {
    return undefined;
  }
}
