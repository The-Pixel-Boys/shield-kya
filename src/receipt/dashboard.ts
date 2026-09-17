/**
 * Pure analytics rollup for the receipt report's dashboard section.
 * Everything is computed from the same events array the feed renders.
 */
import { productLabel, type TrailEvent } from "../trail.js";

export type ToolWorst = "never" | "deny" | "review" | "allow";

export interface VerdictMix {
  readonly allow: number;
  readonly review: number;
  readonly deny: number;
  readonly never: number;
  readonly total: number;
}

export interface DashboardBucket {
  /** "HH:00" for hour granularity, "YYYY-MM-DD" for day. */
  readonly label: string;
  readonly count: number;
}

export interface DashboardActivity {
  readonly granularity: "hour" | "day";
  /** Chronological (oldest first), zero-filled across the kept window. */
  readonly buckets: readonly DashboardBucket[];
}

export interface DashboardTool {
  readonly toolId: string;
  readonly count: number;
  /** never > deny > review > allow across the tool's events. */
  readonly worst: ToolWorst;
}

export interface DashboardRow {
  readonly label: string;
  readonly count: number;
  /** Raw filter value when it differs from the display label (products). */
  readonly value?: string;
}

export interface Dashboard {
  readonly verdictMix: VerdictMix;
  readonly activity: DashboardActivity;
  readonly topTools: readonly DashboardTool[];
  /** deny+never counts per product (raw id in value), desc, top 8. */
  readonly productHotspots: readonly DashboardRow[];
  /** deny+never counts per project, desc, top 8. */
  readonly projectHotspots: readonly DashboardRow[];
}

const HOUR_MS = 3_600_000;
/** Spans up to this many ms render as hourly buckets; beyond it, daily. */
const HOURLY_SPAN_LIMIT_MS = 36 * HOUR_MS;
const MAX_HOUR_BUCKETS = 24;
const MAX_DAY_BUCKETS = 14;
const TOP_N = 8;

function isNever(e: TrailEvent): boolean {
  return e.neverEvent === true || e.reasonCode === "NEVER_EVENT";
}

function hourBucketStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
}

function dayBucketStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function hourLabel(startMs: number): string {
  return `${String(new Date(startMs).getHours()).padStart(2, "0")}:00`;
}

/** "Sep 16 14:00" — used when an hourly window crosses midnight. */
function hourDayLabel(startMs: number): string {
  const d = new Date(startMs);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hourLabel(startMs)}`;
}

function dayLabel(startMs: number): string {
  const d = new Date(startMs);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Step a bucket start back i buckets using local-calendar arithmetic (DST-safe). */
function stepBack(startMs: number, i: number, granularity: "hour" | "day"): number {
  const d = new Date(startMs);
  if (granularity === "hour") d.setHours(d.getHours() - i);
  else d.setDate(d.getDate() - i);
  return granularity === "hour" ? hourBucketStart(d.getTime()) : dayBucketStart(d.getTime());
}

export interface BucketWindowInput {
  readonly counts: ReadonlyMap<number, number>;
  readonly latest: number;
  readonly earliest: number;
  readonly cap: number;
  readonly stepBack: (startMs: number, i: number) => number;
  readonly label: (startMs: number) => string;
}

/**
 * Zero-filled bucket window: from the earliest event's bucket up to the
 * latest, capped to the most recent `cap` buckets, ascending chronologically.
 * Candidates are deduped by start ms — stepping back across a spring-forward
 * transition can map two steps to the same bucket start (duplicate column).
 * Pure and exported so tests can feed the duplicate-start case directly.
 */
export function fillBucketWindow(input: BucketWindowInput): DashboardBucket[] {
  const buckets: DashboardBucket[] = [];
  let prevStart = Number.NaN;
  for (let i = input.cap - 1; i >= 0; i--) {
    const start = input.stepBack(input.latest, i);
    if (start < input.earliest || start === prevStart) continue;
    prevStart = start;
    buckets.push({ label: input.label(start), count: input.counts.get(start) ?? 0 });
  }
  return buckets;
}

function computeActivity(events: readonly TrailEvent[]): DashboardActivity {
  const stamps: number[] = [];
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!Number.isNaN(t)) stamps.push(t);
  }
  if (stamps.length === 0) return { granularity: "hour", buckets: [] };

  const span = Math.max(...stamps) - Math.min(...stamps);
  const granularity = span <= HOURLY_SPAN_LIMIT_MS ? "hour" : "day";
  const bucketStart = granularity === "hour" ? hourBucketStart : dayBucketStart;
  const cap = granularity === "hour" ? MAX_HOUR_BUCKETS : MAX_DAY_BUCKETS;

  const counts = new Map<number, number>();
  for (const t of stamps) {
    const b = bucketStart(t);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }

  const latest = Math.max(...counts.keys());
  const earliest = Math.min(...counts.keys());
  // Hourly windows that cross midnight prefix labels with the short date.
  const crossesMidnight =
    granularity === "hour" && dayBucketStart(earliest) !== dayBucketStart(latest);
  const label =
    granularity === "day" ? dayLabel : crossesMidnight ? hourDayLabel : hourLabel;
  const buckets = fillBucketWindow({
    counts,
    latest,
    earliest,
    cap,
    stepBack: (startMs, i) => stepBack(startMs, i, granularity),
    label,
  });
  return { granularity, buckets };
}

function worstOf(current: ToolWorst | undefined, e: TrailEvent): ToolWorst {
  const rank: Record<ToolWorst, number> = { never: 3, deny: 2, review: 1, allow: 0 };
  let next: ToolWorst = "allow";
  if (isNever(e)) next = "never";
  else {
    const v = e.verdict.toUpperCase();
    if (v === "DENY") next = "deny";
    else if (v === "REQUIRE_APPROVE") next = "review";
  }
  return current === undefined || rank[next] > rank[current] ? next : current;
}

/** Pure rollup of trail events for the report's analytics dashboard. */
export function computeDashboard(events: readonly TrailEvent[]): Dashboard {
  // never is a reason overlay, not a verdict: neverEvent rows also count in
  // their own verdict bucket (base 100% = total events), and the Never bar is
  // reported separately on top of that.
  const mix = { allow: 0, review: 0, deny: 0, never: 0, total: events.length };
  const tools = new Map<string, { count: number; worst: ToolWorst | undefined }>();
  const productHits = new Map<string, number>();
  const projectHits = new Map<string, number>();

  for (const e of events) {
    const v = e.verdict.toUpperCase();
    if (v === "ALLOW") mix.allow++;
    else if (v === "DENY") mix.deny++;
    else if (v === "REQUIRE_APPROVE") mix.review++;
    const never = isNever(e);
    if (never) mix.never++;

    let t = tools.get(e.toolId);
    if (!t) {
      t = { count: 0, worst: undefined };
      tools.set(e.toolId, t);
    }
    t.count++;
    t.worst = worstOf(t.worst, e);

    if (never || v === "DENY") {
      const pv = e.product ?? "other";
      productHits.set(pv, (productHits.get(pv) ?? 0) + 1);
      const project = e.project?.trim();
      if (project) projectHits.set(project, (projectHits.get(project) ?? 0) + 1);
    }
  }

  const topTools: DashboardTool[] = [...tools.entries()]
    .map(([toolId, t]) => ({ toolId, count: t.count, worst: t.worst ?? "allow" }))
    .sort((a, b) => b.count - a.count || a.toolId.localeCompare(b.toolId))
    .slice(0, TOP_N);

  const productHotspots: DashboardRow[] = [...productHits.entries()]
    .map(([value, count]) => ({
      label: productLabel(value as TrailEvent["product"]),
      value,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOP_N);

  const projectHotspots: DashboardRow[] = [...projectHits.entries()]
    .map(([label, count]) => ({ label, value: label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOP_N);

  return {
    verdictMix: mix,
    activity: computeActivity(events),
    topTools,
    productHotspots,
    projectHotspots,
  };
}
