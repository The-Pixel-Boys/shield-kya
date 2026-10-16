/**
 * `kya import --from openshell`: ingest the structured OCSF JSON logs emitted by
 * NVIDIA OpenShell (github.com/NVIDIA/OpenShell), a sandboxed agent runtime, so
 * Shield KYA can report, certify and investigate policy decisions alongside
 * live-trail events.
 *
 * OpenShell emits one OCSF record per decision. An export is raw JSONL, or text
 * lines prefixed with `[ocsf]` (for example `[ocsf] NET:OPEN ... DENIED ...`)
 * where the JSON document starts at the first `{` on the line. Both shapes are
 * accepted; bad lines or records are skipped, never fatal.
 *
 * One OCSF record maps to one TrailEvent: `verdict` DENY for denied actions,
 * ALLOW for audit-mode allows, `reasonCode: OPENSHELL_POLICY`, and a tool of
 * `openshell.network` for network-level events (NET:OPEN and friends) or
 * `openshell.http` for L7 events.
 *
 * Re-imports are idempotent: existing rows with `importedFrom: "openshell"` and
 * the same `sourceHash` (the OCSF `uid`) are skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { appendTrail, globalTrailPath, type TrailEvent } from "../trail.js";
import { redactTrailText } from "../trail-summary.js";
import type { ImportResult } from "./index.js";

const MAX_SESSION_ID_LEN = 160;
const MAX_SUMMARY_LEN = 80;

/** Entries dated outside [2000-01-01, now + 1 day] are rejected as malformed. */
const MIN_TS_MS = Date.UTC(2000, 0, 1);
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Finite non-negative number, rounded. */
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** Parse an ISO-ish timestamp; undefined when missing or unparseable. */
function isoFrom(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** OCSF `time` is epoch milliseconds (integer or numeric string). */
function tsFrom(raw: Record<string, unknown>): string | undefined {
  const dt = isoFrom(raw.time_dt);
  if (dt) return dt;
  const t = num(raw.time);
  if (t === undefined) return undefined;
  try {
    return new Date(t).toISOString();
  } catch {
    return undefined;
  }
}

/** Control chars (incl. ESC, NUL, newlines) become spaces; whitespace collapses. */
function cleanText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

function capText(v: string, max: number): string {
  const s = v.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when the record signals a denied action (audit-mode allows are not). */
function isDenied(raw: Record<string, unknown>): boolean {
  for (const key of ["disposition", "disposition_name", "status", "status_detail", "activity_name"]) {
    const s = str(raw[key])?.toUpperCase();
    if (s?.includes("DENY") || s?.includes("DENIED")) return true;
  }
  return false;
}

/** Redacted "dst: host:port" rendering of an OCSF endpoint - no raw payloads. */
function endpointSummary(label: string, endpoint: unknown): string | undefined {
  if (!isObj(endpoint)) return undefined;
  const host = str(endpoint.hostname) ?? str(endpoint.ip);
  if (!host) return undefined;
  const port = num(endpoint.port);
  const redacted = redactTrailText(`${label}: ${host}${port !== undefined ? `:${port}` : ""}`)
    .replace(/\r?\n/g, " ")
    .trim();
  if (!redacted) return undefined;
  return redacted.length <= MAX_SUMMARY_LEN
    ? redacted
    : `${redacted.slice(0, MAX_SUMMARY_LEN - 1)}…`;
}

/**
 * Tool for the event: L7 events (HTTP activity class or an http_request /
 * http_response block, or an HTTP tag on the `[ocsf]` line) map to
 * `openshell.http`, everything else to `openshell.network`.
 */
function toolFor(raw: Record<string, unknown>, lineHint: string | undefined): string {
  const hint = (lineHint ?? "").toUpperCase();
  if (hint.includes("HTTP")) return "openshell.http";
  if (isObj(raw.http_request) || isObj(raw.http_response)) return "openshell.http";
  const names = `${str(raw.class_name) ?? ""} ${str(raw.category_name) ?? ""}`.toUpperCase();
  if (names.includes("HTTP")) return "openshell.http";
  return "openshell.network";
}

interface MappedEvent {
  readonly event: TrailEvent;
  readonly sourceHash: string;
}

type Mapped = { readonly ok: true; readonly value: MappedEvent } | { readonly ok: false; readonly error: string };

function mapEvent(raw: unknown, fallbackSession: string, nowMs: number, lineHint?: string): Mapped {
  if (!isObj(raw)) return { ok: false, error: "not an object" };
  const uid = str(raw.uid);
  if (!uid) return { ok: false, error: "missing uid" };
  const tsRaw = tsFrom(raw);
  if (!tsRaw) return { ok: false, error: "missing or invalid timestamp" };
  const t = Date.parse(tsRaw);
  if (t < MIN_TS_MS || t > nowMs + FUTURE_SLACK_MS) {
    return { ok: false, error: "timestamp outside 2000-01-01 .. now+1d" };
  }

  const metadata = isObj(raw.metadata) ? raw.metadata : undefined;
  const sessionId =
    str(raw.session_id) ?? str(raw.sessionId) ?? (metadata ? str(metadata.session_id) : undefined) ?? fallbackSession;
  const denied = isDenied(raw);
  const dstSummary = endpointSummary("dst", raw.dst_endpoint);
  const srcSummary = endpointSummary("src", raw.src_endpoint);

  const event: TrailEvent = {
    ts: tsRaw,
    sessionId: capText(cleanText(sessionId), MAX_SESSION_ID_LEN),
    host: "import",
    toolId: toolFor(raw, lineHint),
    verdict: denied ? "DENY" : "ALLOW",
    reasonCode: "OPENSHELL_POLICY",
    mode: "observe",
    importFormat: "openshell",
    ...(dstSummary !== undefined ? { summary: dstSummary } : {}),
    ...(srcSummary !== undefined && dstSummary === undefined ? { summary: srcSummary } : {}),
    importedFrom: "openshell",
    sourceHash: uid,
  };

  return { ok: true, value: { event, sourceHash: uid } };
}

/** Imported openshell rows by uid (full scan: readTrail is tail-capped at 1MB). */
function importedOpenshellUids(env: NodeJS.ProcessEnv): Set<string> {
  const seen = new Set<string>();
  const path = globalTrailPath(env);
  if (!existsSync(path)) return seen;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"importedFrom":"openshell"')) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.importedFrom !== "openshell" || typeof e.sourceHash !== "string") continue;
      seen.add(e.sourceHash);
    } catch {
      /* skip bad lines */
    }
  }
  return seen;
}

/**
 * Extract the JSON document from one export line. Raw JSONL lines parse whole;
 * `[ocsf]` text lines carry tag tokens before the JSON, so parsing starts at
 * the first `{`. Returns undefined when no JSON document is present.
 */
function recordFromLine(line: string): { record: unknown; hint?: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const brace = trimmed.indexOf("{");
  if (brace === -1) return undefined;
  try {
    return { record: JSON.parse(trimmed.slice(brace)), hint: trimmed.slice(0, brace) };
  } catch {
    return undefined;
  }
}

/** Split an export body into records; bad lines become errors + skips. */
function exportRecords(text: string, errors: string[]): { records: { record: unknown; hint?: string }[]; skipped: number } {
  const records: { record: unknown; hint?: string }[] = [];
  let skipped = 0;
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const record of arr) records.push({ record });
      return { records, skipped };
    } catch {
      // Not one JSON document - fall back to line by line.
    }
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const extracted = recordFromLine(line);
    if (extracted) {
      records.push(extracted);
    } else {
      skipped++;
      errors.push(`line ${i + 1}: invalid JSON - ${line.slice(0, 80)}`);
    }
  }
  return { records, skipped };
}

export interface OpenshellImportOptions {
  /** Path, for messages only. */
  readonly file: string;
  /** File content, already read under the shared size cap and file-type rules. */
  readonly text: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Import one OpenShell export. Returns errors (never throws) on a bad file. */
export function importOpenshell(opts: OpenshellImportOptions): ImportResult {
  const { text, cwd } = opts;
  const env = opts.env ?? process.env;
  const fail = (msg: string): ImportResult => ({ imported: 0, skipped: 0, errors: [msg] });

  const errors: string[] = [];
  const parsed = exportRecords(text, errors);
  const records = parsed.records;
  let skipped = parsed.skipped;

  let seen: Set<string>;
  try {
    seen = importedOpenshellUids(env);
  } catch (e) {
    return fail(`cannot read the existing trail - ${errMsg(e)}; nothing imported`);
  }

  const fallbackSession = `import-openshell-${new Date().toISOString().slice(0, 10)}`;
  const nowMs = Date.now();
  let imported = 0;
  let duplicates = 0;

  for (let i = 0; i < records.length; i++) {
    const mapped = mapEvent(records[i]!.record, fallbackSession, nowMs, records[i]!.hint);
    if (!mapped.ok) {
      skipped++;
      errors.push(`record ${i + 1}: ${mapped.error}`);
      continue;
    }
    const { value } = mapped;
    if (seen.has(value.sourceHash)) {
      skipped++;
      duplicates++;
      continue;
    }
    try {
      appendTrail(cwd, value.event, env);
      imported++;
    } catch (e) {
      skipped++;
      errors.push(`record ${i + 1}: trail append failed - ${errMsg(e)}`);
    }
    seen.add(value.sourceHash);
  }

  return { imported, skipped, errors, duplicates };
}
