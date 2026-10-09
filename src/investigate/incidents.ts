/**
 * Group findings into incidents by (detectorId, toolId-or-session key),
 * sorted by severity rank (critical first) then recency (newest lastTs first).
 */
import type { TrailEvent } from "../trail.js";
import type { DetectorId, Finding, Severity } from "./detectors.js";

export interface Incident {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly findingCount: number;
  /** Earliest event ts (ISO) across grouped findings; "" when unparseable. */
  readonly firstTs: string;
  /** Latest event ts (ISO) across grouped findings. */
  readonly lastTs: string;
  readonly findings: readonly Finding[];
}

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const TITLES: Record<DetectorId, string> = {
  "pii-in-summary": "PII or secret slipped past redaction",
  "deny-spike": "DENY spike on a gated tool",
  "approval-loop": "Agent stuck in an approval loop",
  "never-repeat": "Never-list tool attempted repeatedly",
  "unknown-tool-hold": "Unknown tool evaluated in hold mode",
  "slow-calls": "Slow gate evaluations",
};

function findingKey(f: Finding): string {
  const toolId = f.evidence.toolId;
  if (typeof toolId === "string" && toolId) return `tool:${toolId}`;
  const sessionId = f.evidence.sessionId;
  if (typeof sessionId === "string" && sessionId) return `session:${sessionId}`;
  return "global";
}

function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.length > 48 ? out.slice(0, 48) : out;
}

function tsRange(finding: Finding, events: readonly TrailEvent[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const idx of finding.eventIdx) {
    const t = Date.parse(events[idx]?.ts ?? "");
    if (Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return { min, max };
}

export function groupIncidents(
  findings: readonly Finding[],
  events: readonly TrailEvent[],
): Incident[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.detectorId}:${findingKey(f)}`;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const incidents: Incident[] = [];
  for (const list of groups.values()) {
    let severity: Severity = "low";
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const f of list) {
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[severity]) severity = f.severity;
      const r = tsRange(f, events);
      if (r.min < min) min = r.min;
      if (r.max > max) max = r.max;
    }
    const detectorId = list[0].detectorId;
    const groupKey = findingKey(list[0]);
    incidents.push({
      id: slug(`${detectorId}-${groupKey}`),
      title: `${TITLES[detectorId]} (${groupKey.replace(/^(tool|session):/, "")})`,
      severity,
      findingCount: list.length,
      firstTs: Number.isFinite(min) ? new Date(min).toISOString() : "",
      lastTs: Number.isFinite(max) ? new Date(max).toISOString() : "",
      findings: list,
    });
  }
  incidents.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (rankDiff !== 0) return rankDiff;
    return Date.parse(b.lastTs) - Date.parse(a.lastTs);
  });
  return incidents;
}
