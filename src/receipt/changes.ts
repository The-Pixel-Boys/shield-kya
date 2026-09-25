/**
 * "What changed" rollup for the receipt's Changes tab: pure aggregation of
 * trail events that carry a diffPreview, grouped session → file → entries.
 * Sessions sort by last activity desc, entries stay chronological within a
 * file. The worst-verdict fold reuses the dashboard's ranking
 * (allow < review < deny < never).
 */
import type { TrailEvent, TrailProduct } from "../trail.js";
import { worstOf, type ToolWorst } from "./dashboard.js";

/** Group key for events recorded before targetPath existed. */
export const UNKNOWN_FILE = "(unknown file)";

export interface ChangeEntry {
  readonly ts: string;
  readonly toolId: string;
  readonly verdict: string;
  readonly mode: TrailEvent["mode"];
  readonly host?: string;
  readonly product?: TrailProduct;
  readonly project?: string;
  readonly never: boolean;
  readonly preview: string;
}

export interface FileChanges {
  readonly path: string;
  readonly writes: number;
  /** never > deny > review > allow across the file's entries. */
  readonly worst: ToolWorst;
  /** Chronological (oldest first). */
  readonly entries: readonly ChangeEntry[];
}

export interface SessionChanges {
  readonly sessionId: string;
  readonly lastTs: string;
  readonly fileCount: number;
  readonly changeCount: number;
  /** Files ordered by most recent change first. */
  readonly files: readonly FileChanges[];
}

export interface ChangesModel {
  /** Sessions ordered by last activity desc. */
  readonly sessions: readonly SessionChanges[];
  readonly fileCount: number;
  readonly changeCount: number;
}

/** Only events with a non-empty diff preview count as changes. */
export function buildChangesModel(events: readonly TrailEvent[]): ChangesModel {
  const bySession = new Map<
    string,
    { lastTs: string; byFile: Map<string, { lastTs: string; worst: ToolWorst | undefined; entries: ChangeEntry[] }> }
  >();

  for (const e of events) {
    const preview = e.diffPreview?.trim();
    if (!preview) continue;
    const sid = e.sessionId || "unknown";
    const path = e.targetPath?.trim() || UNKNOWN_FILE;
    const entry: ChangeEntry = {
      ts: e.ts,
      toolId: e.toolId,
      verdict: e.verdict,
      mode: e.mode,
      never: Boolean(e.neverEvent) || e.reasonCode === "NEVER_EVENT",
      preview,
      ...(e.host?.trim() ? { host: e.host.trim() } : {}),
      ...(e.product ? { product: e.product } : {}),
      ...(e.project?.trim() ? { project: e.project.trim() } : {}),
    };
    let s = bySession.get(sid);
    if (!s) {
      s = { lastTs: e.ts, byFile: new Map() };
      bySession.set(sid, s);
    }
    if (e.ts > s.lastTs) s.lastTs = e.ts;
    let f = s.byFile.get(path);
    if (!f) {
      f = { lastTs: e.ts, worst: undefined, entries: [] };
      s.byFile.set(path, f);
    }
    if (e.ts > f.lastTs) f.lastTs = e.ts;
    f.worst = worstOf(f.worst, e);
    f.entries.push(entry);
  }

  let fileCount = 0;
  let changeCount = 0;
  const sessions: SessionChanges[] = [...bySession.entries()]
    .map(([sessionId, s]) => {
      const files: FileChanges[] = [...s.byFile.entries()]
        .sort(([, a], [, b]) => b.lastTs.localeCompare(a.lastTs))
        .map(([path, f]) => ({
          path,
          writes: f.entries.length,
          worst: f.worst ?? "allow",
          entries: [...f.entries].sort((a, b) => a.ts.localeCompare(b.ts)),
        }));
      fileCount += files.length;
      changeCount += files.reduce((n, f) => n + f.writes, 0);
      return {
        sessionId,
        lastTs: s.lastTs,
        fileCount: files.length,
        changeCount: files.reduce((n, f) => n + f.writes, 0),
        files,
      };
    })
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs));

  return { sessions, fileCount, changeCount };
}
