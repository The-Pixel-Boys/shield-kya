/**
 * Append-only delivery ledger for alert routing: one JSON line per delivery
 * attempt at <kya-home>/.kya/notify-log.jsonl. This is the persistent
 * counterpart of sender.ts's in-memory stats so the report can show
 * per-target delivered/failed counts and the last attempt. Best-effort:
 * nothing here ever throws, and a full URL is never recorded - only the
 * target host[:port], since webhook URLs can embed secrets in their path.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";

export const NOTIFY_LOG_FILE = "notify-log.jsonl";

/** Rewrite threshold / retention: over MAX lines the file is cut to KEEP. */
export const NOTIFY_LOG_KEEP_LINES = 500;
export const NOTIFY_LOG_MAX_LINES = 1000;
/**
 * Size gate for the line-count check: appends stay cheap (no read) below
 * this; above it the file is read and trimmed when it exceeds MAX lines.
 * Growth is bounded either way.
 */
const NOTIFY_LOG_REWRITE_CHECK_BYTES = 64 * 1024;
/** Tail-read cap, mirroring trail.ts's approach to oversized JSONL state. */
const MAX_LOG_READ_BYTES = 256 * 1024;

const MAX_TARGET_LEN = 120;
const MAX_VERDICT_LEN = 40;
const MAX_ERROR_LEN = 60;

export interface NotifyLogEntry {
  readonly ts: string;
  /** Target host[:port] only - never the full webhook URL. */
  readonly target: string;
  readonly verdict: string;
  readonly ok: boolean;
  readonly httpStatus?: number;
  /** Error class when not delivered: timeout / network / rate-limit / circuit-open. */
  readonly error?: string;
  /** 1-based send attempt; 0 marks a drop before any send (rate limit, open circuit). */
  readonly attempt: number;
}

export interface NotifyTargetRow {
  readonly target: string;
  readonly delivered: number;
  readonly failed: number;
  readonly lastTs: string;
  readonly lastOk: boolean;
  /** Last attempt detail: HTTP status or error class, when known. */
  readonly lastDetail?: string;
}

export interface NotifyLogSummary {
  readonly targets: readonly NotifyTargetRow[];
  readonly delivered: number;
  readonly failed: number;
  readonly lastTs: string;
}

export function notifyLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), NOTIFY_LOG_FILE);
}

/** host[:port] of a webhook URL, safe to persist; "unknown" when unparseable. */
export function notifyTargetLabel(url: string): string {
  try {
    const host = new URL(url).host;
    return host ? host.slice(0, MAX_TARGET_LEN) : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Append one delivery attempt. When the file has grown past the size gate and
 * holds more than NOTIFY_LOG_MAX_LINES lines, it is rewritten with the last
 * NOTIFY_LOG_KEEP_LINES. Never throws.
 */
export function appendNotifyLog(
  env: NodeJS.ProcessEnv,
  entry: NotifyLogEntry,
): void {
  try {
    mkdirSync(globalConfigDir(env), { recursive: true });
    const path = notifyLogPath(env);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    if (statSync(path).size < NOTIFY_LOG_REWRITE_CHECK_BYTES) return;
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length <= NOTIFY_LOG_MAX_LINES) return;
    writeFileSync(path, `${lines.slice(-NOTIFY_LOG_KEEP_LINES).join("\n")}\n`, "utf8");
  } catch {
    /* the ledger must never affect delivery */
  }
}

function parseEntry(raw: unknown): NotifyLogEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.ts !== "string" ||
    typeof e.target !== "string" ||
    typeof e.verdict !== "string" ||
    typeof e.ok !== "boolean" ||
    typeof e.attempt !== "number" ||
    !Number.isFinite(e.attempt)
  ) {
    return undefined;
  }
  return {
    ts: e.ts,
    target: e.target.slice(0, MAX_TARGET_LEN),
    verdict: e.verdict.slice(0, MAX_VERDICT_LEN),
    ok: e.ok,
    ...(typeof e.httpStatus === "number" && Number.isFinite(e.httpStatus)
      ? { httpStatus: Math.floor(e.httpStatus) }
      : {}),
    ...(typeof e.error === "string" ? { error: e.error.slice(0, MAX_ERROR_LEN) } : {}),
    attempt: Math.floor(e.attempt),
  };
}

/** Read the ledger (tail-capped, tolerant of bad lines). Missing file yields []. */
export function readNotifyLog(env: NodeJS.ProcessEnv = process.env): NotifyLogEntry[] {
  try {
    const path = notifyLogPath(env);
    if (!existsSync(path)) return [];
    let text: string;
    const size = statSync(path).size;
    if (size <= MAX_LOG_READ_BYTES) {
      text = readFileSync(path, "utf8");
    } else {
      // Oversize: the tail wins, first (possibly partial) line dropped.
      text = readFileSync(path, "utf8").slice(-MAX_LOG_READ_BYTES);
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    const out: NotifyLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = parseEntry(JSON.parse(line));
        if (entry) out.push(entry);
      } catch {
        /* skip bad lines */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Per-target rollup for the report; undefined when the ledger is empty. */
export function summarizeNotifyLog(
  entries: readonly NotifyLogEntry[],
): NotifyLogSummary | undefined {
  if (entries.length === 0) return undefined;
  const byTarget = new Map<string, { delivered: number; failed: number; last: NotifyLogEntry }>();
  let delivered = 0;
  let failed = 0;
  let lastTs = "";
  for (const e of entries) {
    if (e.ok) delivered++;
    else failed++;
    if (e.ts > lastTs) lastTs = e.ts;
    const row = byTarget.get(e.target) ?? { delivered: 0, failed: 0, last: e };
    if (e.ok) row.delivered++;
    else row.failed++;
    if (e.ts >= row.last.ts) row.last = e;
    byTarget.set(e.target, row);
  }
  const targets: NotifyTargetRow[] = [...byTarget.entries()]
    .map(([target, r]) => ({
      target,
      delivered: r.delivered,
      failed: r.failed,
      lastTs: r.last.ts,
      lastOk: r.last.ok,
      ...(r.last.ok
        ? r.last.httpStatus !== undefined
          ? { lastDetail: `HTTP ${r.last.httpStatus}` }
          : {}
        : {
            lastDetail:
              r.last.error ?? (r.last.httpStatus !== undefined ? `HTTP ${r.last.httpStatus}` : "failed"),
          }),
    }))
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs) || a.target.localeCompare(b.target));
  return { targets, delivered, failed, lastTs };
}
