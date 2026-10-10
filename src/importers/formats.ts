/**
 * Foreign trace format mappers for the trace importer.
 * Sources: LangSmith runs, Langfuse observations, Phoenix spans, OTLP/JSON spans.
 * Each mapper converts one foreign record into a TrailEvent (mode "observe",
 * host "import", importFormat set to the source, no packId) or returns a
 * per-record error - it never throws.
 * Raw input/output values are never copied into the event; summaries render
 * input key names only, redacted via redactTrailText.
 */
import type { TrailEvent, TrailImportFormat } from "../trail.js";
import { redactTrailText } from "../trail-summary.js";

export type ImportSource = TrailImportFormat;

/** Caps match the lengths the trail uses elsewhere (trail-summary MAX_LEN = 80). */
const MAX_SUMMARY_LEN = 80;
const MAX_TOOL_ID_LEN = 160;
const MAX_SESSION_ID_LEN = 160;
const MAX_SUMMARY_KEYS = 8;

export type MapResult =
  | { readonly ok: true; readonly event: TrailEvent }
  | { readonly ok: false; readonly error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Finite non-negative number, rounded; OTLP intValue may arrive as a string. */
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

/** Whole-millisecond latency between an ISO start and a raw end value. */
function msBetween(startIso: string, endRaw: unknown): number | undefined {
  const s = str(endRaw);
  if (!s) return undefined;
  const b = Date.parse(s);
  const a = Date.parse(startIso);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return undefined;
  return Math.round(b - a);
}

/** OTLP timeUnixNano is a decimal string; BigInt keeps full precision. */
function nanoToMs(v: unknown): number | undefined {
  const s = str(v) ?? (typeof v === "number" && Number.isFinite(v) ? String(Math.trunc(v)) : undefined);
  if (!s) return undefined;
  try {
    return Number(BigInt(s) / 1_000_000n);
  } catch {
    return undefined;
  }
}

function capText(v: string, max: number): string {
  const s = v.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max);
}

/** Redacted "inputs: key1, key2" rendering - key names only, never values. */
function keysSummary(label: string, input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const keys = Object.keys(input).slice(0, MAX_SUMMARY_KEYS);
  if (keys.length === 0) return undefined;
  const redacted = redactTrailText(`${label}: ${keys.join(", ")}`)
    .replace(/\r?\n/g, " ")
    .trim();
  if (!redacted) return undefined;
  return redacted.length <= MAX_SUMMARY_LEN
    ? redacted
    : `${redacted.slice(0, MAX_SUMMARY_LEN - 1)}…`;
}

interface EventSeed {
  readonly toolId: string;
  readonly ts?: string;
  readonly sessionId?: string;
  readonly deny: boolean;
  readonly latencyMs?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly summary?: string;
}

function buildEvent(seed: EventSeed, fallbackSession: string): TrailEvent {
  return {
    ts: seed.ts ?? new Date().toISOString(),
    sessionId: capText(seed.sessionId ?? fallbackSession, MAX_SESSION_ID_LEN),
    host: "import",
    toolId: capText(seed.toolId, MAX_TOOL_ID_LEN),
    verdict: seed.deny ? "DENY" : "ALLOW",
    reasonCode: seed.deny ? "IMPORTED_ERROR" : "IMPORTED",
    mode: "observe",
    ...(seed.latencyMs !== undefined ? { latencyMs: seed.latencyMs } : {}),
    ...(seed.tokensIn !== undefined ? { tokensIn: seed.tokensIn } : {}),
    ...(seed.tokensOut !== undefined ? { tokensOut: seed.tokensOut } : {}),
    ...(seed.summary !== undefined ? { summary: seed.summary } : {}),
  };
}

function err(message: string): MapResult {
  return { ok: false, error: message };
}

/** LangSmith run: {name, run_type, inputs, outputs, start_time, end_time, session_name, error, prompt_tokens, completion_tokens}. */
function mapLangSmith(rec: unknown, fallbackSession: string): MapResult {
  if (!isObj(rec)) return err("not an object");
  const name = str(rec.name);
  if (!name) return err("missing name");
  const ts = isoFrom(rec.start_time);
  return {
    ok: true,
    event: buildEvent(
      {
        toolId: name,
        ts,
        sessionId: str(rec.session_name) ?? str(rec.session_id),
        deny: str(rec.error) !== undefined,
        latencyMs: ts ? msBetween(ts, rec.end_time) : undefined,
        tokensIn: num(rec.prompt_tokens),
        tokensOut: num(rec.completion_tokens),
        summary: keysSummary("inputs", rec.inputs),
      },
      fallbackSession,
    ),
  };
}

/** Langfuse observation/trace: {type, name, startTime, endTime, usage, level, statusMessage}. */
function mapLangfuse(rec: unknown, fallbackSession: string): MapResult {
  if (!isObj(rec)) return err("not an object");
  const name = str(rec.name);
  if (!name) return err("missing name");
  const ts = isoFrom(rec.startTime);
  const usage = isObj(rec.usage) ? rec.usage : undefined;
  return {
    ok: true,
    event: buildEvent(
      {
        toolId: name,
        ts,
        sessionId:
          str(rec.sessionId) ?? str(rec.session_id) ?? str(rec.traceId) ?? str(rec.trace_id),
        deny: str(rec.level)?.toUpperCase() === "ERROR",
        latencyMs: ts ? msBetween(ts, rec.endTime) : undefined,
        tokensIn: usage ? (num(usage.input) ?? num(usage.promptTokens)) : undefined,
        tokensOut: usage ? (num(usage.output) ?? num(usage.completionTokens)) : undefined,
        summary: keysSummary("input", rec.input),
      },
      fallbackSession,
    ),
  };
}

/** Phoenix span: {name, startTime, endTime, statusCode, attributes, context:{trace_id}}. */
function mapPhoenix(rec: unknown, fallbackSession: string): MapResult {
  if (!isObj(rec)) return err("not an object");
  const attrs = isObj(rec.attributes) ? rec.attributes : {};
  const name = str(attrs["tool.name"]) ?? str(rec.name);
  if (!name) return err("missing name");
  const ts = isoFrom(rec.startTime);
  const ctx = isObj(rec.context) ? rec.context : undefined;
  return {
    ok: true,
    event: buildEvent(
      {
        toolId: name,
        ts,
        sessionId:
          (ctx ? (str(ctx.trace_id) ?? str(ctx.traceId)) : undefined) ??
          str(rec.traceId) ??
          str(rec.trace_id),
        deny: str(rec.statusCode)?.toUpperCase() === "ERROR",
        latencyMs: ts ? msBetween(ts, rec.endTime) : undefined,
        tokensIn: num(attrs["llm.token_count.prompt"]),
        tokensOut: num(attrs["llm.token_count.completion"]),
      },
      fallbackSession,
    ),
  };
}

/** Flatten OTLP KeyValue[] attributes to a plain object (string/int/double/bool only). */
function otelAttributes(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(v)) return out;
  for (const item of v) {
    if (!isObj(item)) continue;
    const key = str(item.key);
    const value = item.value;
    if (!key || !isObj(value)) continue;
    if (typeof value.stringValue === "string") out[key] = value.stringValue;
    else if (value.intValue !== undefined) out[key] = num(value.intValue);
    else if (typeof value.doubleValue === "number") out[key] = value.doubleValue;
    else if (typeof value.boolValue === "boolean") out[key] = value.boolValue;
  }
  return out;
}

/** OTLP Status.code: 0 UNSET, 1 OK, 2 ERROR (string enum also accepted). */
function otelStatusIsError(status: unknown): boolean {
  if (!isObj(status)) return false;
  const code = status.code;
  if (typeof code === "number") return code === 2;
  if (typeof code === "string") return code === "STATUS_CODE_ERROR";
  return false;
}

/** OTLP/JSON span: {traceId, name, startTimeUnixNano, endTimeUnixNano, status, attributes}. */
function mapOtel(rec: unknown, fallbackSession: string): MapResult {
  if (!isObj(rec)) return err("not an object");
  const attrs = otelAttributes(rec.attributes);
  const name = str(rec.name) ?? str(attrs["tool.name"]);
  if (!name) return err("missing name");
  const startMs = nanoToMs(rec.startTimeUnixNano);
  const endMs = nanoToMs(rec.endTimeUnixNano);
  const latencyMs =
    startMs !== undefined && endMs !== undefined && endMs >= startMs
      ? Math.round(endMs - startMs)
      : undefined;
  return {
    ok: true,
    event: buildEvent(
      {
        toolId: name,
        ts: startMs !== undefined ? new Date(startMs).toISOString() : undefined,
        sessionId: str(rec.traceId),
        deny: otelStatusIsError(rec.status),
        latencyMs,
        tokensIn: num(attrs["llm.token_count.prompt"]),
        tokensOut: num(attrs["llm.token_count.completion"]),
      },
      fallbackSession,
    ),
  };
}

/** Map one foreign record to a TrailEvent; returns an error string on bad records. */
export function mapRecord(
  source: ImportSource,
  rec: unknown,
  fallbackSession: string,
): MapResult {
  try {
    const mapped = mapRecordBySource(source, rec, fallbackSession);
    // Stamp the source format so the report can break imports down per format
    // even when the foreign record carried its own session id.
    return mapped.ok ? { ok: true, event: { ...mapped.event, importFormat: source } } : mapped;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function mapRecordBySource(
  source: ImportSource,
  rec: unknown,
  fallbackSession: string,
): MapResult {
  switch (source) {
    case "langsmith":
      return mapLangSmith(rec, fallbackSession);
    case "langfuse":
      return mapLangfuse(rec, fallbackSession);
    case "phoenix":
      return mapPhoenix(rec, fallbackSession);
    case "otel":
      return mapOtel(rec, fallbackSession);
  }
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/** Flatten an OTLP/JSON payload (resourceSpans/scopeSpans/spans) to a span list. */
function otlpSpans(json: Record<string, unknown>): unknown[] | undefined {
  const resourceSpans = json.resourceSpans;
  if (!Array.isArray(resourceSpans)) return undefined;
  const out: unknown[] = [];
  for (const rs of resourceSpans) {
    if (!isObj(rs)) continue;
    const scopeSpans = rs.scopeSpans ?? rs.instrumentationLibrarySpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      if (!isObj(ss)) continue;
      const spans = ss.spans;
      if (Array.isArray(spans)) out.push(...spans);
    }
  }
  return out;
}

/**
 * Extract the record list from a whole-file JSON document, per source.
 * Bare arrays are accepted for every source; otherwise the known container
 * keys are tried. Returns [] when the shape is not recognized.
 */
export function extractRecords(source: ImportSource, json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!isObj(json)) return [];
  switch (source) {
    case "langsmith":
      return arr(json.runs) ?? arr(json.data) ?? [];
    case "langfuse":
      return arr(json.observations) ?? arr(json.traces) ?? arr(json.data) ?? [];
    case "phoenix":
      return arr(json.spans) ?? arr(json.data) ?? [];
    case "otel":
      return otlpSpans(json) ?? arr(json.spans) ?? arr(json.data) ?? [];
  }
}
