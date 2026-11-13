/**
 * Privacy-safe model input for incident triage. Built only from the detector
 * incident and its trail events. Free text comes from TrailEvent.summary,
 * re-redacted and clipped. Raw arguments, argument hashes, target paths, diff
 * previews, project folders, session ids and device ids never enter the input.
 * Mirrored in Java: com.shieldagent.core.kya.alerts.TriageInputBuilder.
 */
import { assertNoSecrets } from "../dash/render.js";
import type { TrailEvent } from "../trail.js";
import { redactTrailText } from "../trail-summary.js";
import { containsPii, type Severity } from "../investigate/detectors.js";
import type { Incident } from "../investigate/incidents.js";

export const TRIAGE_SCHEMA_VERSION = "1";
export const MAX_REASON_CODES = 10;
export const MAX_NEVER_RULES = 10;
export const MAX_TARGET_CLASSES = 10;
export const MAX_TOOL_IDS = 10;
export const MAX_SUMMARIES = 5;
export const MAX_SUMMARY_CHARS = 120;
/** Clip for short identifier lists (tool ids, reason codes, rule ids, classes). */
export const MAX_ID_CHARS = 64;

/** Even the minimal input failed the secret check. The caller must skip the model and alert on detector severity. */
export class TriageInputUnsafeError extends Error {
  constructor() {
    super("triage input failed the secret check after every fallback stage");
    this.name = "TriageInputUnsafeError";
  }
}

export interface TriageInput {
  readonly schemaVersion: string;
  readonly detectorIds: string[];
  readonly severity: Severity;
  readonly reasonCodes: string[];
  readonly neverRules: string[];
  readonly targetClasses: string[];
  readonly toolIds: string[];
  readonly counts: { readonly allow: number; readonly hold: number; readonly deny: number };
  readonly windowMinutes: number;
  readonly summaries: string[];
  readonly product: string;
  readonly repeats: number;
}

const HOME_UNIX = /\/(?:Users|home)\/[^/\s]+/g;
const HOME_ROOT = /\/root(?=[/\s]|$)/g;
const HOME_WIN = /[A-Za-z]:\\Users\\[^\\\s]+/g;
/** Control, format and line or paragraph separator characters (U+2028, U+2029, U+200B, U+FEFF ...). */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** Every event identifier is untrusted: only this shape reaches the model (whole value, no spaces). */
const SAFE_ID = /^[A-Za-z0-9._:/*@+-]{1,64}$/;

/** Replace a home folder (and the user name in it) with "~". */
function stripHome(s: string): string {
  return s.replace(HOME_UNIX, "~").replace(HOME_ROOT, "~").replace(HOME_WIN, "~");
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Free text: invisible characters become a space, then redact, remove home folders, flatten
 * whitespace. The caller clips. Empty string means drop.
 */
function flatten(s: string): string {
  const visible = s.replace(INVISIBLE, " ");
  return stripHome(redactTrailText(visible)).replace(/\s+/g, " ").trim();
}

/** An identifier is kept only when it has the safe shape and redaction or home-path removal would not change it. */
function isSafeId(v: string): boolean {
  return SAFE_ID.test(v) && stripHome(redactTrailText(v)) === v;
}

/** First-seen order, only safe identifiers, no duplicates, at most `max` items. */
function uniq(values: Iterable<string | undefined>, max: number): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && isSafeId(v)) seen.add(v);
    if (seen.size >= max) break;
  }
  return [...seen];
}

function incidentEvents(incident: Incident, events: readonly TrailEvent[]): TrailEvent[] {
  const idx = new Set<number>();
  for (const f of incident.findings) {
    for (const i of f.eventIdx) {
      if (Number.isInteger(i) && i >= 0 && i < events.length) idx.add(i);
    }
  }
  return [...idx].sort((a, b) => a - b).map((i) => events[i]!);
}

export function buildTriageInput(incident: Incident, events: readonly TrailEvent[]): TriageInput {
  const evs = incidentEvents(incident, events);
  const counts = { allow: 0, hold: 0, deny: 0 };
  const perTool = new Map<string, number>();
  const summaries: string[] = [];
  let product = "";
  for (const e of evs) {
    if (e.verdict === "ALLOW") counts.allow++;
    else if (e.verdict === "REQUIRE_APPROVE") counts.hold++;
    else if (e.verdict === "DENY") counts.deny++;
    perTool.set(e.toolId, (perTool.get(e.toolId) ?? 0) + 1);
    if (!product && e.product) product = e.product;
    if (e.summary && summaries.length < MAX_SUMMARIES) {
      // A summary the pii-in-summary detector flags (e-mail, card number, high-entropy token) is dropped
      // whole, before the clip: a clip could cut a match in two, and a partial mask is not a guarantee.
      const flat = flatten(e.summary);
      if (containsPii(e.summary) || containsPii(flat)) continue;
      const s = clip(flat, MAX_SUMMARY_CHARS);
      if (s && !summaries.includes(s)) summaries.push(s);
    }
  }
  const first = Date.parse(incident.firstTs);
  const last = Date.parse(incident.lastTs);
  const windowMinutes =
    Number.isNaN(first) || Number.isNaN(last) ? 0 : Math.max(0, Math.ceil((last - first) / 60_000));
  const input: TriageInput = {
    schemaVersion: TRIAGE_SCHEMA_VERSION,
    detectorIds: [...new Set(incident.findings.map((f) => f.detectorId as string).filter(isSafeId))].sort(),
    severity: incident.severity,
    reasonCodes: uniq(evs.map((e) => e.reasonCode), MAX_REASON_CODES),
    neverRules: uniq(evs.map((e) => e.neverRule), MAX_NEVER_RULES),
    targetClasses: uniq(evs.map((e) => e.targetClass), MAX_TARGET_CLASSES),
    toolIds: uniq(evs.map((e) => e.toolId), MAX_TOOL_IDS),
    counts,
    windowMinutes,
    summaries,
    product: isSafeId(product) ? product : "unknown",
    repeats: Math.max(0, ...perTool.values()),
  };
  return failClosed(input);
}

function passesSecretCheck(input: TriageInput): boolean {
  try {
    assertNoSecrets(JSON.stringify(input));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check after every stage: full input, then no summaries, then also no tool ids, then the minimal input
 * (no free-text field at all). Throws when even the minimal input fails, so alerting uses detector severity.
 */
function failClosed(input: TriageInput): TriageInput {
  const noText = { ...input, summaries: [] };
  const stages: TriageInput[] = [
    input,
    noText,
    { ...noText, toolIds: [] },
    {
      schemaVersion: input.schemaVersion,
      detectorIds: input.detectorIds,
      severity: input.severity,
      reasonCodes: [],
      neverRules: [],
      targetClasses: [],
      toolIds: [],
      counts: input.counts,
      windowMinutes: input.windowMinutes,
      summaries: [],
      product: "unknown",
      repeats: input.repeats,
    },
  ];
  for (const stage of stages) if (passesSecretCheck(stage)) return stage;
  throw new TriageInputUnsafeError();
}
