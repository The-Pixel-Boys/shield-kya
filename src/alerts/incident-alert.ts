/**
 * The alert body for one detected incident. Built from the privacy-safe triage input (redacted,
 * clipped summaries, counts, detector ids) and static detector text. The incident id, title and
 * fix brief header can hold a session id or a raw tool key, so none of them is copied here.
 * No raw args, argument hashes, target paths, diff previews, session ids or home folders.
 */
import type { Severity } from "../investigate/detectors.js";
import { detectorTitle, type DetectorId, type Incident } from "../investigate/index.js";
import type { TrailEvent } from "../trail.js";
import { buildTriageInput, type TriageInput } from "./triage-input.js";
import { incidentRef } from "./state.js";
import type { IncidentTriage } from "./triage-model.js";

import { ADVISORY_LINE } from "./constants.js";

export { ADVISORY_LINE, INCIDENT_EVENT, INCIDENT_KIND } from "./constants.js";
export const MAX_ALERT_SUMMARIES = 3;

export interface IncidentAlert {
  readonly ref: string;
  readonly title: string;
  readonly severity: Severity;
  readonly detectorIds: readonly string[];
  readonly findingCount: number;
  /** Verdict counts; absent when the triage input was not available. */
  readonly counts?: { readonly allow: number; readonly hold: number; readonly deny: number };
  readonly firstTs: string;
  readonly lastTs: string;
  readonly tools: readonly string[];
  readonly summaries: readonly string[];
  /** First step of the suggested change, static text per detector. Empty when none. */
  readonly fix: string;
  /** Local model triage (optional, advisory). Absent when the model is not installed or failed. Never changes severity. */
  readonly triage?: IncidentTriage;
  readonly advisory: string;
  readonly test: boolean;
}

/** First non-empty line under "## Suggested change" in a fix brief (static detector text). */
export function fixBriefFirstLine(brief: string | undefined): string {
  if (!brief) return "";
  const lines = brief.split("\n");
  const at = lines.findIndex((l) => l.trim() === "## Suggested change");
  if (at === -1) return "";
  for (const line of lines.slice(at + 1)) {
    const t = line.trim();
    if (t.startsWith("## ")) return "";
    if (t) return t.slice(0, 240);
  }
  return "";
}

export function incidentTitle(detectorIds: readonly string[]): string {
  const first = detectorIds[0] as DetectorId | undefined;
  let name = "Security incident";
  if (first !== undefined) {
    try {
      name = detectorTitle(first) ?? name;
    } catch {
      /* unknown id: generic name */
    }
  }
  return `KYA incident: ${name}`;
}

export function buildIncidentAlert(
  incident: Incident,
  events: readonly TrailEvent[],
  brief?: string,
): IncidentAlert {
  // The builder may return nothing or a reduced input when its secret check trips: then send the minimum.
  let triage: TriageInput | null | undefined;
  try {
    triage = buildTriageInput(incident, events) as TriageInput | null;
  } catch {
    triage = null;
  }
  const detectorIds =
    triage && triage.detectorIds.length > 0
      ? [...triage.detectorIds]
      : [...new Set(incident.findings.map((f) => f.detectorId as string))].sort();
  return {
    ref: incidentRef(incident.id),
    title: incidentTitle(detectorIds),
    severity: incident.severity,
    detectorIds,
    findingCount: incident.findingCount,
    ...(triage ? { counts: { ...triage.counts } } : {}),
    firstTs: incident.firstTs,
    lastTs: incident.lastTs,
    tools: triage ? triage.toolIds.slice(0, MAX_ALERT_SUMMARIES) : [],
    summaries: triage ? triage.summaries.slice(0, MAX_ALERT_SUMMARIES) : [],
    fix: fixBriefFirstLine(brief),
    advisory: ADVISORY_LINE,
    test: false,
  };
}

/** The synthetic incident `kya alerts test` sends. Marked as a test in the title and the `test` flag. */
export function buildTestIncidentAlert(now: Date = new Date()): IncidentAlert {
  const ts = now.toISOString();
  return {
    ref: "test",
    title: "[TEST] KYA incident: Never-list tool attempted repeatedly",
    severity: "high",
    detectorIds: ["never-repeat"],
    findingCount: 1,
    counts: { allow: 0, hold: 0, deny: 3 },
    firstTs: ts,
    lastTs: ts,
    tools: ["kya.test"],
    summaries: ["This is a test alert from kya alerts test. No action needed."],
    fix: "This is a test. Nothing happened on your machine.",
    advisory: ADVISORY_LINE,
    test: true,
  };
}
