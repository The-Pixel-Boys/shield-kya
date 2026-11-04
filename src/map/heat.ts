import { bucketOf, isTrailRow, targetOf } from "./build.js";
import type { TrailEventLike, Verdicts } from "./types.js";

export interface HeatOptions {
  /** Window end. Without it the latest valid row is used, so the builder reads no clock. */
  now?: Date;
  /** Calendar days ending on the day of `now`. Default 7. */
  days?: number;
  /** Offset east of UTC in minutes (EET is 120). Default 0. */
  tzOffsetMinutes?: number;
}

export interface WhenHeat {
  /** `YYYY-MM-DD`, oldest first. */
  days: string[];
  /** 0 to 23. */
  hours: number[];
  /** Counts: cells[dayIndex][hour]. */
  cells: number[][];
  /** Verdict buckets per cell: verdictCells[dayIndex][hour].deny is the deny count. */
  verdictCells: Verdicts[][];
  /** Largest single cell count, for the colour scale. */
  max: number;
}

export interface WhereRow extends Verdicts {
  class: string;
  family: string;
  total: number;
  /** Members folded into an "other" row. Absent on shown rows. */
  grouped?: number;
}

export interface WhereHeat {
  rows: WhereRow[];
  /** Largest single bucket count across rows, for the colour scale. */
  max: number;
}

export interface Heat {
  when: WhenHeat;
  where: WhereHeat;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Schema section 7: top 40 targets, plus always-shown deny, hold and secret. */
const TOP_TARGETS = 40;

function zeroVerdicts(): Verdicts {
  return { allow: 0, deny: 0, hold: 0, observed: 0 };
}

function addTo(v: Verdicts, b: keyof Verdicts): void {
  v[b] += 1;
}

/**
 * Two views from one trail. Pure: same rows and options give the same output.
 * `when`: counts per calendar day and hour of day. `where`: counts per target class by verdict.
 * Rows outside the window (after `now`, or before the first day) are excluded.
 */
export function buildHeat(events: Iterable<TrailEventLike>, opts: HeatOptions = {}): Heat {
  const days = opts.days ?? 7;
  if (!Number.isInteger(days) || days < 1) throw new Error("buildHeat: days must be a positive integer");
  const off = (opts.tzOffsetMinutes ?? 0) * 60_000;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const rows = [...events].filter(isTrailRow);
  const nowMs = opts.now !== undefined ? opts.now.getTime() : rows.reduce((m, e) => Math.max(m, Date.parse(e.ts)), -Infinity);
  if (!Number.isFinite(nowMs)) return { when: { days: [], hours, cells: [], verdictCells: [], max: 0 }, where: { rows: [], max: 0 } };

  // All day arithmetic runs on local-offset milliseconds, so it never reads the host time zone.
  const lastStart = Math.floor((nowMs + off) / DAY_MS) * DAY_MS;
  const firstStart = lastStart - (days - 1) * DAY_MS;
  const windowStart = firstStart - off;
  const dayList = Array.from({ length: days }, (_, i) => new Date(firstStart + i * DAY_MS).toISOString().slice(0, 10));
  const cells = dayList.map(() => new Array<number>(24).fill(0));
  const verdictCells = dayList.map(() => Array.from({ length: 24 }, zeroVerdicts));
  const targets = new Map<string, { family: string; v: Verdicts }>();

  for (const e of rows) {
    const ms = Date.parse(e.ts);
    if (ms < windowStart || ms > nowMs) continue;
    const local = ms + off;
    const d = Math.floor((local - firstStart) / DAY_MS);
    const h = Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
    const b = bucketOf(e);
    cells[d]![h]! += 1;
    addTo(verdictCells[d]![h]!, b);
    const t = targetOf(e);
    let r = targets.get(t.cls);
    if (!r) {
      r = { family: t.family, v: zeroVerdicts() };
      targets.set(t.cls, r);
    }
    addTo(r.v, b);
  }

  const when: WhenHeat = {
    days: dayList,
    hours,
    cells,
    verdictCells,
    max: Math.max(0, ...cells.flat()),
  };
  return { when, where: whereRows(targets) };
}

function total(v: Verdicts): number {
  return v.allow + v.deny + v.hold + v.observed;
}

function bySize(a: WhereRow, b: WhereRow): number {
  return b.total - a.total || (a.class < b.class ? -1 : a.class > b.class ? 1 : 0);
}

function whereRows(targets: Map<string, { family: string; v: Verdicts }>): WhereHeat {
  const all = [...targets].map(([cls, r]) => ({ class: cls, family: r.family, ...r.v, total: total(r.v) })) as WhereRow[];
  all.sort(bySize);
  const rows: WhereRow[] = [];
  const folded = new Map<string, WhereRow>();
  all.forEach((r, i) => {
    const alwaysShown = r.deny > 0 || r.hold > 0 || r.family === "secret";
    if (i < TOP_TARGETS || alwaysShown) {
      rows.push(r);
      return;
    }
    let g = folded.get(r.family);
    if (!g) {
      g = { class: `other:${r.family}`, family: r.family, allow: 0, deny: 0, hold: 0, observed: 0, total: 0, grouped: 0 };
      folded.set(r.family, g);
    }
    g.allow += r.allow;
    g.deny += r.deny;
    g.hold += r.hold;
    g.observed += r.observed;
    g.total += r.total;
    g.grouped = (g.grouped ?? 0) + 1;
  });
  rows.push(...folded.values());
  rows.sort(bySize);
  const max = Math.max(0, ...rows.flatMap((r) => [r.allow, r.deny, r.hold, r.observed]));
  return { rows, max };
}
