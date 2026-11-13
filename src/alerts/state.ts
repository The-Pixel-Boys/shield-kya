/**
 * Dedupe memory for incident alerts: <kya-home>/.kya/alerts-state.json.
 * One entry per (incident ref, severity). An incident alerts once. It alerts again only when its
 * severity rises, or when a new occurrence starts after the last alerted one ended. A refresh
 * (more events in the same incident) never alerts again. The file keeps the last 500 entries
 * and is written atomically. Several detached flush children can run at once, so the claim step
 * runs under a short lock directory.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { atomicWriteSync } from "../fs-atomic.js";
import type { Severity } from "../investigate/detectors.js";
import { isSeverity, severityRank } from "./config.js";
import type { IncidentTriage, TriagePick } from "./triage-model.js";

export const ALERTS_STATE_FILE = "alerts-state.json";
export const ALERTS_STATE_KEEP = 500;
/** A failed delivery is tried again at most this many times in total. */
export const MAX_ATTEMPTS = 3;
/** A pending entry is not retried before this many ms have passed (a running sibling child owns it). */
export const RETRY_AFTER_MS = 60_000;
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 2_000;

export interface AlertEntry {
  /** `${ref}:${severity}` */
  readonly key: string;
  /** Hash of the detector incident id. The raw id can hold a session id, so it is never stored. */
  readonly ref: string;
  readonly severity: Severity;
  /** When the alert was claimed (ISO). */
  readonly ts: string;
  /** Last event time of the alerted incident (ISO, "" when unknown). */
  readonly lastTs: string;
  readonly title: string;
  readonly detectors: readonly string[];
  /** Receivers that accepted the alert. */
  readonly delivered: number;
  readonly attempts: number;
  readonly status: "sent" | "pending";
  /** Local model triage of this incident, when the model was installed. Advisory. */
  readonly triage?: IncidentTriage;
}

const TRIAGE_ID = /^[a-z0-9-]{1,40}$/;

function parsePick(raw: unknown): TriagePick | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !TRIAGE_ID.test(r.id) || typeof r.p !== "number" || !Number.isFinite(r.p)) return undefined;
  return { id: r.id, p: Math.min(1, Math.max(0, r.p)) };
}

/** Defensive parse: every id is checked against a plain-word shape, so a forged state file cannot inject markup. */
export function parseTriage(raw: unknown): IncidentTriage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const category = parsePick(r.category);
  const urgency = parsePick(r.urgency);
  const action = parsePick(r.action);
  if (!category || !urgency || !action || typeof r.model !== "string" || !TRIAGE_ID.test(r.model)) return undefined;
  if (typeof r.benign !== "number" || !Number.isFinite(r.benign)) return undefined;
  return { model: r.model, category, urgency, action, benign: Math.min(1, Math.max(0, r.benign)) };
}

export function incidentRef(incidentId: string): string {
  return createHash("sha256").update(incidentId, "utf8").digest("hex").slice(0, 12);
}

export function alertsStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), ALERTS_STATE_FILE);
}

function parseEntry(raw: unknown): AlertEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.key !== "string" ||
    typeof e.ref !== "string" ||
    !isSeverity(e.severity) ||
    typeof e.ts !== "string" ||
    typeof e.title !== "string" ||
    (e.status !== "sent" && e.status !== "pending")
  ) {
    return undefined;
  }
  return {
    key: e.key.slice(0, 80),
    ref: e.ref.slice(0, 40),
    severity: e.severity,
    ts: e.ts.slice(0, 40),
    lastTs: typeof e.lastTs === "string" ? e.lastTs.slice(0, 40) : "",
    title: e.title.slice(0, 200),
    detectors: Array.isArray(e.detectors)
      ? e.detectors.filter((d): d is string => typeof d === "string").slice(0, 10).map((d) => d.slice(0, 40))
      : [],
    delivered: typeof e.delivered === "number" && Number.isFinite(e.delivered) ? Math.max(0, Math.floor(e.delivered)) : 0,
    attempts: typeof e.attempts === "number" && Number.isFinite(e.attempts) ? Math.max(0, Math.floor(e.attempts)) : 0,
    status: e.status,
    ...(parseTriage(e.triage) ? { triage: parseTriage(e.triage)! } : {}),
  };
}

/** Missing or bad file: an empty list (alerting then works as on a first run). */
export function readAlertsState(env: NodeJS.ProcessEnv = process.env): AlertEntry[] {
  try {
    const path = alertsStatePath(env);
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return [];
    return raw.entries.map(parseEntry).filter((e): e is AlertEntry => e !== undefined);
  } catch {
    return [];
  }
}

/** Atomic write, last ALERTS_STATE_KEEP entries. Never throws. */
export function writeAlertsState(env: NodeJS.ProcessEnv, entries: readonly AlertEntry[]): void {
  try {
    mkdirSync(globalConfigDir(env), { recursive: true });
    const kept = entries.slice(-ALERTS_STATE_KEEP);
    atomicWriteSync(alertsStatePath(env), `${JSON.stringify({ version: 1, entries: kept }, null, 1)}\n`);
  } catch {
    /* a lost write only means one alert may repeat */
  }
}

export interface IncidentMeta {
  readonly ref: string;
  readonly severity: Severity;
  readonly firstTs: string;
  readonly lastTs: string;
}

/**
 * Pure dedupe decision. `entries` is the stored list in write order.
 * Alert when: no entry for the ref; severity above the last entry; the incident starts after the
 * last alerted one ended (new occurrence); or the last entry is still pending (not delivered),
 * has attempts left, and its cool-down has passed.
 */
export function needsAlert(entries: readonly AlertEntry[], inc: IncidentMeta, nowMs: number): boolean {
  let last: AlertEntry | undefined;
  for (const e of entries) if (e.ref === inc.ref) last = e;
  if (last === undefined) return true;
  if (severityRank(inc.severity) > severityRank(last.severity)) return true;
  const first = Date.parse(inc.firstTs);
  const prevEnd = Date.parse(last.lastTs);
  if (!Number.isNaN(first) && !Number.isNaN(prevEnd) && first > prevEnd) return true;
  if (last.status === "pending" && last.attempts < MAX_ATTEMPTS) {
    const claimed = Date.parse(last.ts);
    return Number.isNaN(claimed) || nowMs - claimed >= RETRY_AFTER_MS;
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding the state lock (an exclusive mkdir). A lock older than 15 s is stale and
 * removed. When the lock cannot be taken within 2 s, `fn` is skipped and undefined is returned:
 * the next flush or the next report tick covers it.
 */
export async function withStateLock<T>(env: NodeJS.ProcessEnv, fn: () => T | Promise<T>): Promise<T | undefined> {
  const dir = `${alertsStatePath(env)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    mkdirSync(globalConfigDir(env), { recursive: true });
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the holder just released it */
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* stale lock cleanup handles it */
    }
  }
}
