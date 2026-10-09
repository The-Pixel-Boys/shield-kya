/**
 * Deterministic trail detectors. Pure local analysis over TrailEvent rows -
 * no LLM calls, no IO. Each detector emits zero or more findings carrying the
 * indices of the offending events in the input array.
 */
import type { TrailEvent } from "../trail.js";

export type Severity = "low" | "medium" | "high" | "critical";

export type DetectorId =
  | "pii-in-summary"
  | "deny-spike"
  | "approval-loop"
  | "never-repeat"
  | "unknown-tool-hold"
  | "slow-calls";

export interface Finding {
  readonly detectorId: DetectorId;
  readonly severity: Severity;
  /** Indices into the events array passed to the detector. */
  readonly eventIdx: number[];
  readonly summary: string;
  /** Structured detail for grouping and brief rendering. Never raw secrets. */
  readonly evidence: Record<string, unknown>;
}

export interface Detector {
  readonly id: DetectorId;
  run(events: readonly TrailEvent[]): Finding[];
}

/** deny-spike: more than this many DENY events inside the window. */
export const DENY_SPIKE_THRESHOLD = 3;
export const DENY_SPIKE_WINDOW_MS = 10 * 60_000;
/** approval-loop: consecutive REQUIRE_APPROVE on one session+tool. */
export const APPROVAL_LOOP_MIN = 3;
/** slow-calls: p95 above this with at least MIN_SAMPLES per tool. */
export const SLOW_CALL_P95_MS = 5000;
export const SLOW_CALL_MIN_SAMPLES = 5;
/** pii-in-summary: token candidates must clear this Shannon entropy (bits/char). */
const TOKEN_MIN_ENTROPY = 4.0;
const TOKEN_MIN_LEN = 32;

function parseTs(ts: string): number | undefined {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? undefined : t;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CARD_RE = /(?:\d[ -]?){13,19}(?!\d)/g;
const TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

/** Standard Luhn checksum for card-shaped digit strings. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Mask a leaked value for evidence: keep first 4 and last 2 chars. */
function mask(s: string): string {
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

interface PiiHit {
  readonly kind: "email" | "credit-card" | "high-entropy-token";
  readonly field: "summary" | "diffPreview" | "targetPath";
  readonly sample: string;
}

function scanPiiField(
  field: PiiHit["field"],
  value: string | undefined,
  hits: PiiHit[],
): void {
  if (!value) return;
  for (const m of value.matchAll(EMAIL_RE)) {
    hits.push({ kind: "email", field, sample: mask(m[0]) });
  }
  for (const m of value.matchAll(CARD_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      hits.push({ kind: "credit-card", field, sample: mask(digits) });
    }
  }
  for (const m of value.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (tok.length >= TOKEN_MIN_LEN && shannonEntropy(tok) >= TOKEN_MIN_ENTROPY) {
      hits.push({ kind: "high-entropy-token", field, sample: mask(tok) });
    }
  }
}

function isNever(e: TrailEvent): boolean {
  return e.neverEvent === true || e.reasonCode === "NEVER_EVENT";
}

function piiInSummary(events: readonly TrailEvent[]): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const hits: PiiHit[] = [];
    scanPiiField("summary", e.summary, hits);
    scanPiiField("diffPreview", e.diffPreview, hits);
    scanPiiField("targetPath", e.targetPath, hits);
    if (hits.length === 0) continue;
    const kinds = [...new Set(hits.map((h) => h.kind))];
    const severity: Severity = kinds.includes("credit-card") || kinds.includes("email")
      ? "critical"
      : "high";
    findings.push({
      detectorId: "pii-in-summary",
      severity,
      eventIdx: [i],
      summary: `${kinds.join(", ")} in ${hits[0].field} of ${e.toolId} event slipped past redaction`,
      evidence: {
        toolId: e.toolId,
        sessionId: e.sessionId,
        ts: e.ts,
        kinds,
        fields: [...new Set(hits.map((h) => h.field))],
        samples: hits.slice(0, 5).map((h) => `${h.kind}:${h.sample}`),
      },
    });
  }
  return findings;
}

function denySpike(events: readonly TrailEvent[]): Finding[] {
  const byTool = new Map<string, { idx: number; t: number }[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.verdict !== "DENY") continue;
    const t = parseTs(e.ts);
    if (t === undefined) continue;
    const list = byTool.get(e.toolId) ?? [];
    list.push({ idx: i, t });
    byTool.set(e.toolId, list);
  }
  const findings: Finding[] = [];
  for (const [toolId, list] of byTool) {
    list.sort((a, b) => a.t - b.t);
    let emittedUntil = -1;
    for (let i = 0; i < list.length; i++) {
      const window = list.filter(
        (x) => x.t >= list[i].t && x.t - list[i].t <= DENY_SPIKE_WINDOW_MS,
      );
      if (window.length <= DENY_SPIKE_THRESHOLD || list[i].t <= emittedUntil) continue;
      emittedUntil = list[i].t + DENY_SPIKE_WINDOW_MS;
      findings.push({
        detectorId: "deny-spike",
        severity: "medium",
        eventIdx: window.map((x) => x.idx),
        summary: `${window.length} DENY events for ${toolId} within 10 minutes`,
        evidence: {
          toolId,
          count: window.length,
          windowStart: new Date(list[i].t).toISOString(),
          windowEnd: new Date(list[i].t + DENY_SPIKE_WINDOW_MS).toISOString(),
        },
      });
    }
  }
  return findings;
}

function approvalLoop(events: readonly TrailEvent[]): Finding[] {
  const byKey = new Map<string, { idx: number; t: number; e: TrailEvent }[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const key = `${e.sessionId}${e.toolId}`;
    const list = byKey.get(key) ?? [];
    list.push({ idx: i, t: parseTs(e.ts) ?? 0, e });
    byKey.set(key, list);
  }
  const findings: Finding[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.t - b.t || a.idx - b.idx);
    let run: { idx: number; e: TrailEvent }[] = [];
    const flush = (): void => {
      if (run.length >= APPROVAL_LOOP_MIN) {
        const first = run[0].e;
        findings.push({
          detectorId: "approval-loop",
          severity: "medium",
          eventIdx: run.map((x) => x.idx),
          summary: `session ${first.sessionId} hit ${run.length} consecutive REQUIRE_APPROVE on ${first.toolId}`,
          evidence: {
            toolId: first.toolId,
            sessionId: first.sessionId,
            count: run.length,
          },
        });
      }
      run = [];
    };
    for (const item of list) {
      if (item.e.verdict === "REQUIRE_APPROVE") run.push(item);
      else flush();
    }
    flush();
  }
  return findings;
}

function neverRepeat(events: readonly TrailEvent[]): Finding[] {
  const byTool = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!isNever(e)) continue;
    const list = byTool.get(e.toolId) ?? [];
    list.push(i);
    byTool.set(e.toolId, list);
  }
  const findings: Finding[] = [];
  for (const [toolId, idxs] of byTool) {
    if (idxs.length <= 1) continue;
    findings.push({
      detectorId: "never-repeat",
      severity: "high",
      eventIdx: idxs,
      summary: `never-list tool ${toolId} attempted ${idxs.length} times`,
      evidence: { toolId, count: idxs.length },
    });
  }
  return findings;
}

function unknownToolHold(events: readonly TrailEvent[]): Finding[] {
  const byTool = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.reasonCode !== "UNKNOWN_TOOL" || e.mode !== "hold") continue;
    const list = byTool.get(e.toolId) ?? [];
    list.push(i);
    byTool.set(e.toolId, list);
  }
  const findings: Finding[] = [];
  for (const [toolId, idxs] of byTool) {
    findings.push({
      detectorId: "unknown-tool-hold",
      severity: "low",
      eventIdx: idxs,
      summary: `${toolId} evaluated as UNKNOWN_TOOL in hold mode (${idxs.length}x); enforce mode would block it`,
      evidence: { toolId, count: idxs.length },
    });
  }
  return findings;
}

function slowCalls(events: readonly TrailEvent[]): Finding[] {
  const byTool = new Map<string, { idx: number; ms: number }[]>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (typeof e.latencyMs !== "number") continue;
    const list = byTool.get(e.toolId) ?? [];
    list.push({ idx: i, ms: e.latencyMs });
    byTool.set(e.toolId, list);
  }
  const findings: Finding[] = [];
  for (const [toolId, list] of byTool) {
    if (list.length < SLOW_CALL_MIN_SAMPLES) continue;
    const sorted = list.map((x) => x.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
    if (p95 <= SLOW_CALL_P95_MS) continue;
    const slowIdx = list.filter((x) => x.ms >= p95).map((x) => x.idx);
    findings.push({
      detectorId: "slow-calls",
      severity: "low",
      eventIdx: slowIdx,
      summary: `${toolId} p95 latency ${Math.round(p95)}ms across ${list.length} calls (limit ${SLOW_CALL_P95_MS}ms)`,
      evidence: {
        toolId,
        samples: list.length,
        p95Ms: Math.round(p95),
        thresholdMs: SLOW_CALL_P95_MS,
      },
    });
  }
  return findings;
}

export const DETECTORS: readonly Detector[] = [
  { id: "pii-in-summary", run: piiInSummary },
  { id: "deny-spike", run: denySpike },
  { id: "approval-loop", run: approvalLoop },
  { id: "never-repeat", run: neverRepeat },
  { id: "unknown-tool-hold", run: unknownToolHold },
  { id: "slow-calls", run: slowCalls },
];

/** Run every detector over the same events array; findings keep input indices. */
export function runDetectors(events: readonly TrailEvent[]): Finding[] {
  return DETECTORS.flatMap((d) => d.run(events));
}
