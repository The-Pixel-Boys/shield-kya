/**
 * Persistent OTLP export counters at <kya-home>/.kya/otel-stats.json. The
 * exporter's in-memory counters (exporter.ts) vanish with each process - and
 * the notify-flush path is a fresh process per event - so flush outcomes are
 * accumulated here for the report's OTel section. Read-modify-write on every
 * export, best-effort: nothing here ever throws or blocks a flush.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";

export const OTEL_STATS_FILE = "otel-stats.json";

const MAX_STATS_BYTES = 16 * 1024;
const MAX_ENDPOINT_LEN = 120;

export interface OtelStats {
  /** Endpoint host[:port] label only - never the full URL (may embed auth). */
  readonly endpoint: string;
  readonly spansSent: number;
  readonly spansFailed: number;
  /** ISO timestamp of the last export attempt (success or failure). */
  readonly lastExportAt: string;
}

export function otelStatsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), OTEL_STATS_FILE);
}

/** host[:port] label for an endpoint URL, safe to persist; "" when unparseable. */
export function otelEndpointLabel(endpoint: string): string {
  try {
    return new URL(endpoint).host.slice(0, MAX_ENDPOINT_LEN);
  } catch {
    return "";
  }
}

/** Read the persisted counters; missing/oversize/corrupt state yields undefined. */
export function readOtelStats(env: NodeJS.ProcessEnv = process.env): OtelStats | undefined {
  try {
    const path = otelStatsPath(env);
    if (!existsSync(path)) return undefined;
    if (statSync(path).size > MAX_STATS_BYTES) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    const spansSent = nonNeg(o.spansSent);
    const spansFailed = nonNeg(o.spansFailed);
    if (spansSent === undefined || spansFailed === undefined) return undefined;
    if (spansSent + spansFailed === 0) return undefined;
    return {
      endpoint: typeof o.endpoint === "string" ? o.endpoint.slice(0, MAX_ENDPOINT_LEN) : "",
      spansSent,
      spansFailed,
      lastExportAt: typeof o.lastExportAt === "string" ? o.lastExportAt : "",
    };
  } catch {
    return undefined;
  }
}

function nonNeg(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

/**
 * Accumulate one flush outcome. The previous file (possibly written by another
 * process) is the base, so detached notify-flush children add onto the same
 * counters. Never throws.
 */
export function recordOtlpExport(
  env: NodeJS.ProcessEnv,
  endpoint: string,
  ok: boolean,
  now: string = new Date().toISOString(),
): void {
  try {
    const prev = readOtelStats(env);
    const label = otelEndpointLabel(endpoint);
    const next: OtelStats = {
      endpoint: label || prev?.endpoint || "",
      spansSent: (prev?.spansSent ?? 0) + (ok ? 1 : 0),
      spansFailed: (prev?.spansFailed ?? 0) + (ok ? 0 : 1),
      lastExportAt: now,
    };
    mkdirSync(globalConfigDir(env), { recursive: true });
    writeFileSync(otelStatsPath(env), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    /* stats must never affect the export path */
  }
}
