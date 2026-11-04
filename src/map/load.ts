/**
 * Loads the map for one trail: streams the file, filters one session, builds the graph and the heat views.
 * Shared by `kya map` and the live report, so both show the same numbers.
 */
import { buildMap, readTrailFile, type TrailRead } from "./build.js";
import { buildHeat, type Heat } from "./heat.js";
import type { MapGraph, TrailEventLike } from "./types.js";

/** The When view is always seven days, so the read covers at least seven. */
export const HEAT_DAYS = 7;

export interface LoadMapOptions {
  readonly path: string;
  /** Graph window in days. */
  readonly days: number;
  readonly now: Date;
  /** Per-install salt for sessionHash. */
  readonly salt: string;
  readonly session?: string;
  /** Offset east of UTC in minutes, for the When view. */
  readonly tzOffsetMinutes: number;
}

export interface LoadedMap {
  readonly graph: MapGraph;
  readonly heat: Heat;
  /** Events in the graph window (after the session filter). */
  readonly windowEvents: number;
}

const EMPTY_READ: TrailRead = { events: [], rowsRead: 0, rowsSkipped: 0, rowsOutOfWindow: 0 };

/** A missing trail is an empty trail. Any other read error is thrown. */
async function readOrEmpty(path: string, days: number, now: Date): Promise<TrailRead> {
  try {
    return await readTrailFile(path, { days, now });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return EMPTY_READ;
    throw err;
  }
}

/** Rows of the last `days` days, one session when `session` is set. Shared by `kya map` and `kya export`. */
export async function loadTrailEvents(opts: { path: string; days: number; now: Date; session?: string }): Promise<{ read: TrailRead; events: TrailEventLike[] }> {
  const read = await readOrEmpty(opts.path, opts.days, opts.now);
  return { read, events: opts.session ? read.events.filter((e) => e.sessionId === opts.session) : read.events };
}

export async function loadMap(opts: LoadMapOptions): Promise<LoadedMap> {
  const { read, events } = await loadTrailEvents({ path: opts.path, days: Math.max(opts.days, HEAT_DAYS), now: opts.now, session: opts.session });
  const graph = buildMap(events, {
    salt: opts.salt,
    now: opts.now,
    days: opts.days,
    read: { rowsRead: read.rowsRead, rowsSkipped: read.rowsSkipped, rowsOutOfWindow: read.rowsOutOfWindow },
  });
  const heat = buildHeat(events, { now: opts.now, days: HEAT_DAYS, tzOffsetMinutes: opts.tzOffsetMinutes });
  const windowEvents = graph.nodes.filter((n) => n.kind === "device").reduce((s, n) => s + n.count, 0);
  return { graph, heat, windowEvents };
}
