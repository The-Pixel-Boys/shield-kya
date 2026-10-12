/**
 * `kya import --from adr-sensor`: ingest the unified AgentEvent export written by
 * the ADR Sensor Python package (`adr-sensor` on PyPI) so Shield KYA can report,
 * certify and investigate alongside live-trail events.
 *
 * ADR Sensor events carry a stable `uuid`, a `timestamp`, a `session_id`, optional
 * `token_usage` and a `chat_history` of messages. Each message may contain tool
 * calls (`tools` / `tool_calls`). One AgentEvent maps to one or more TrailEvents:
 * one per tool call, or a single `adr-sensor:session` event when the record has no
 * tool calls so the import stays visible.
 *
 * Re-imports are idempotent: existing rows with `importedFrom: "adr-sensor"` and
 * the same `sourceHash` (the event `uuid`) are skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { appendTrail, globalTrailPath, type TrailEvent } from "../trail.js";
import { redactTrailText } from "../trail-summary.js";
import type { ImportResult } from "./index.js";

const MAX_TOOL_ID_LEN = 160;
const MAX_SESSION_ID_LEN = 160;
const MAX_SUMMARY_LEN = 80;
const MAX_SUMMARY_KEYS = 8;

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

/** True when the object carries an explicit error signal. */
function isErrorish(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (str(v.error) !== undefined) return true;
  const status = str(v.status);
  if (status?.toLowerCase() === "error") return true;
  return false;
}

/** Redacted "input: key1, key2" rendering - key names only, never values. */
function inputKeysSummary(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const keys = Object.keys(input).slice(0, MAX_SUMMARY_KEYS);
  if (keys.length === 0) return undefined;
  const redacted = redactTrailText(`input: ${keys.join(", ")}`)
    .replace(/\r?\n/g, " ")
    .trim();
  if (!redacted) return undefined;
  return redacted.length <= MAX_SUMMARY_LEN
    ? redacted
    : `${redacted.slice(0, MAX_SUMMARY_LEN - 1)}…`;
}

/** Tool calls can live under `tools` or `tool_calls` on each message. */
function toolCallsFromMessage(msg: Record<string, unknown>): unknown[] {
  const tools = msg.tools ?? msg.tool_calls;
  return Array.isArray(tools) ? tools : [];
}

/** Tool name can be `tool_name` or `name`. */
function toolName(tool: Record<string, unknown>): string | undefined {
  return str(tool.tool_name) ?? str(tool.name);
}

interface MappedEvent {
  readonly events: TrailEvent[];
  readonly sourceHash: string;
  readonly fallback: boolean;
}

type Mapped = { readonly ok: true; readonly value: MappedEvent } | { readonly ok: false; readonly error: string };

function mapEvent(raw: unknown, fallbackSession: string, nowMs: number): Mapped {
  if (!isObj(raw)) return { ok: false, error: "not an object" };
  const uuid = str(raw.uuid);
  if (!uuid) return { ok: false, error: "missing uuid" };
  const tsRaw = isoFrom(raw.timestamp);
  if (!tsRaw) return { ok: false, error: "missing or invalid timestamp" };
  const t = Date.parse(tsRaw);
  if (t < MIN_TS_MS || t > nowMs + FUTURE_SLACK_MS) {
    return { ok: false, error: "timestamp outside 2000-01-01 .. now+1d" };
  }

  const sessionId = str(raw.session_id) ?? fallbackSession;
  const topLevelError = isErrorish(raw);
  const usage = isObj(raw.token_usage) ? raw.token_usage : undefined;
  const tokensIn = num(usage?.prompt_tokens) ?? num(usage?.input) ?? num(usage?.promptTokens);
  const tokensOut = num(usage?.completion_tokens) ?? num(usage?.output) ?? num(usage?.completionTokens);

  const events: TrailEvent[] = [];
  const chatHistory = Array.isArray(raw.chat_history) ? raw.chat_history : [];
  let fallback = false;

  for (const msgRaw of chatHistory) {
    if (!isObj(msgRaw)) continue;
    const msgError = isErrorish(msgRaw);
    for (const toolRaw of toolCallsFromMessage(msgRaw)) {
      if (!isObj(toolRaw)) continue;
      const name = toolName(toolRaw);
      if (!name) {
        fallback = true;
        continue;
      }
      const toolId = capText(cleanText(name), MAX_TOOL_ID_LEN);
      const toolError = isErrorish(toolRaw) || msgError;
      const deny = topLevelError || toolError;
      events.push({
        ts: tsRaw,
        sessionId: capText(cleanText(sessionId), MAX_SESSION_ID_LEN),
        host: "import",
        toolId,
        verdict: deny ? "DENY" : "ALLOW",
        reasonCode: deny ? "IMPORTED_ERROR" : "IMPORTED",
        mode: "observe",
        importFormat: "adr-sensor",
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
        ...(inputKeysSummary(toolRaw.arguments) !== undefined
          ? { summary: inputKeysSummary(toolRaw.arguments) }
          : {}),
        importedFrom: "adr-sensor",
        sourceHash: uuid,
      });
    }
  }

  if (events.length === 0) {
    // No tool calls but the session record exists: emit one event so the import is visible.
    events.push({
      ts: tsRaw,
      sessionId: capText(cleanText(sessionId), MAX_SESSION_ID_LEN),
      host: "import",
      toolId: "adr-sensor:session",
      verdict: topLevelError ? "DENY" : "ALLOW",
      reasonCode: topLevelError ? "IMPORTED_ERROR" : "IMPORTED",
      mode: "observe",
      importFormat: "adr-sensor",
      ...(tokensIn !== undefined ? { tokensIn } : {}),
      ...(tokensOut !== undefined ? { tokensOut } : {}),
      importedFrom: "adr-sensor",
      sourceHash: uuid,
    });
  }

  return { ok: true, value: { events, sourceHash: uuid, fallback } };
}

/** Imported adr-sensor rows by uuid (full scan: readTrail is tail-capped at 1MB). */
function importedAdrSensorUuids(env: NodeJS.ProcessEnv): Set<string> {
  const seen = new Set<string>();
  const path = globalTrailPath(env);
  if (!existsSync(path)) return seen;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"importedFrom":"adr-sensor"')) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.importedFrom !== "adr-sensor" || typeof e.sourceHash !== "string") continue;
      seen.add(e.sourceHash);
    } catch {
      /* skip bad lines */
    }
  }
  return seen;
}

/** Split a JSONL body into records; bad lines become errors + skips. */
function jsonlRecords(text: string, errors: string[]): { records: unknown[]; skipped: number } {
  const records: unknown[] = [];
  let skipped = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      skipped++;
      errors.push(`line ${i + 1}: invalid JSON - ${errMsg(e)}`);
    }
  }
  return { records, skipped };
}

export interface AdrSensorImportOptions {
  /** Path, for messages only. */
  readonly file: string;
  /** File content, already read under the shared size cap and file-type rules. */
  readonly text: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Import one ADR Sensor export. Returns errors (never throws) on a bad file. */
export function importAdrSensor(opts: AdrSensorImportOptions): ImportResult {
  const { text, cwd } = opts;
  const env = opts.env ?? process.env;
  const fail = (msg: string): ImportResult => ({ imported: 0, skipped: 0, errors: [msg] });

  let records: unknown[];
  const errors: string[] = [];
  let skipped = 0;
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      records = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      const parsed = jsonlRecords(text, errors);
      records = parsed.records;
      skipped += parsed.skipped;
    }
  } else {
    const parsed = jsonlRecords(text, errors);
    records = parsed.records;
    skipped += parsed.skipped;
  }

  let seen: Set<string>;
  try {
    seen = importedAdrSensorUuids(env);
  } catch (e) {
    return fail(`cannot read the existing trail - ${errMsg(e)}; nothing imported`);
  }

  const fallbackSession = `import-adr-sensor-${new Date().toISOString().slice(0, 10)}`;
  const nowMs = Date.now();
  let imported = 0;
  let duplicates = 0;
  let fallbacks = 0;

  for (let i = 0; i < records.length; i++) {
    const mapped = mapEvent(records[i], fallbackSession, nowMs);
    if (!mapped.ok) {
      skipped++;
      errors.push(`record ${i + 1}: ${mapped.error}`);
      continue;
    }
    const { value } = mapped;
    if (seen.has(value.sourceHash)) {
      skipped += value.events.length;
      duplicates += value.events.length;
      continue;
    }
    for (const event of value.events) {
      try {
        appendTrail(cwd, event, env);
        imported++;
      } catch (e) {
        skipped++;
        errors.push(`record ${i + 1}: trail append failed - ${errMsg(e)}`);
      }
    }
    if (value.fallback) fallbacks++;
    seen.add(value.sourceHash);
  }

  return { imported, skipped, errors, duplicates };
}
