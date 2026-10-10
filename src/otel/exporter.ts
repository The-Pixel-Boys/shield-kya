/**
 * Best-effort OTLP/HTTP export of KYA verdicts as GenAI spans. Opt-in:
 * disabled unless an endpoint is configured (env KYA_OTLP_EXPORT_ENDPOINT or
 * "otlpExport" in .kya/config.json). Fire-and-forget: export NEVER blocks,
 * delays, or changes a verdict. Every failure is swallowed and counted
 * in-memory (otlpExportStats) plus persisted to .kya/otel-stats.json
 * (stats.ts) so the report can show export health across processes.
 *
 * Privacy: only verdict metadata ships (tool id, verdict, reason code, mode,
 * host, session id, token counts when known). Tool args, prompts, approval
 * bodies, and API keys are never exported - same rule as docs/otlp.md.
 *
 * No new dependencies: one hand-built OTLP/JSON payload and the global fetch.
 */

import { randomBytes } from "node:crypto";
import { CLI_VERSION } from "../version.js";
import { recordOtlpExport } from "./stats.js";

const EXPORT_TIMEOUT_MS = 2_000;
const SERVICE_NAME = "shield-kya-cli";
const SCOPE_NAME = "shield-kya-cli";

export interface OtlpExportConfig {
  /** Base OTLP/HTTP endpoint, e.g. http://127.0.0.1:4318 ("/v1/traces" appended). */
  readonly endpoint: string;
  /** Extra headers (auth tokens live here or on the Collector, never in code). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Permit plaintext http to a non-loopback host. Default false. */
  readonly insecure?: boolean;
}

export interface VerdictEvent {
  readonly ts?: string;
  readonly sessionId: string;
  readonly toolId: string;
  readonly verdict: string;
  readonly reasonCode: string;
  readonly mode: string;
  readonly host?: string;
  /** GenAI usage, when the caller knows it. */
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

interface OtlpExportFileKey {
  readonly endpoint?: unknown;
  readonly headers?: unknown;
  readonly insecure?: unknown;
}

const stats = { attempted: 0, exported: 0, failed: 0 };

/** In-memory counters for a future status command; process-local only. */
export function otlpExportStats(): { attempted: number; exported: number; failed: number } {
  return { ...stats };
}

/**
 * Resolve export config from env > parsed .kya/config.json. Accepts the parsed
 * config object so callers that already read the file (resolveConfig) need no
 * config.ts change. Returns undefined when disabled (no endpoint anywhere).
 */
export function resolveOtlpExportConfig(
  env: NodeJS.ProcessEnv = process.env,
  configJson?: unknown,
): OtlpExportConfig | undefined {
  const file = readFileKey(configJson);
  const endpoint = env.KYA_OTLP_EXPORT_ENDPOINT?.trim() || file?.endpoint;
  if (!endpoint) return undefined;
  return {
    endpoint,
    ...(file?.headers ? { headers: file.headers } : {}),
    insecure: file?.insecure === true,
  };
}

function readFileKey(configJson: unknown): OtlpExportConfig | undefined {
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) {
    return undefined;
  }
  const raw = (configJson as Record<string, unknown>).otlpExport;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const key = raw as OtlpExportFileKey;
  const endpoint = typeof key.endpoint === "string" && key.endpoint.trim()
    ? key.endpoint.trim()
    : undefined;
  if (!endpoint) return undefined;
  let headers: Record<string, string> | undefined;
  if (key.headers && typeof key.headers === "object" && !Array.isArray(key.headers)) {
    headers = {};
    for (const [k, v] of Object.entries(key.headers as Record<string, unknown>)) {
      if (typeof v === "string" && k.trim()) headers[k.trim()] = v;
    }
    if (Object.keys(headers).length === 0) headers = undefined;
  }
  return {
    endpoint,
    ...(headers ? { headers } : {}),
    insecure: key.insecure === true,
  };
}

/** Loopback plaintext is fine; anything else over http requires insecure:true. */
function endpointAllowed(cfg: OtlpExportConfig): boolean {
  let url: URL;
  try {
    url = new URL(cfg.endpoint);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  if (cfg.insecure === true) return true;
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function tracesUrl(cfg: OtlpExportConfig): string {
  // No regex here: trailing-slash stripping with a loop keeps static
  // analyzers (and reviewers) sure this is linear on uncontrolled input.
  let base = cfg.endpoint;
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nano(ts: string | undefined): string {
  const ms = ts ? Date.parse(ts) : Number.NaN;
  const base = Number.isFinite(ms) ? ms : Date.now();
  return (BigInt(Math.floor(base)) * 1_000_000n).toString();
}

type AttrValue = { stringValue: string } | { intValue: string };

function attr(key: string, value: AttrValue): { key: string; value: AttrValue } {
  return { key, value };
}

function strAttr(key: string, value: string | undefined): ReturnType<typeof attr> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return attr(key, { stringValue: value });
}

function intAttr(key: string, value: number | undefined): ReturnType<typeof attr> | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return attr(key, { intValue: String(Math.floor(value)) });
}

/** One OTLP/JSON ExportTraceServiceRequest carrying exactly one verdict span. */
export function buildVerdictTracePayload(event: VerdictEvent): unknown {
  const start = nano(event.ts);
  const attributes = [
    strAttr("gen_ai.tool.name", event.toolId),
    strAttr("kya.verdict", event.verdict),
    strAttr("kya.reason_code", event.reasonCode),
    strAttr("kya.mode", event.mode),
    strAttr("kya.host", event.host),
    strAttr("kya.session_id", event.sessionId),
    intAttr("gen_ai.usage.input_tokens", event.tokensIn),
    intAttr("gen_ai.usage.output_tokens", event.tokensOut),
  ].filter((a): a is NonNullable<typeof a> => a !== undefined);

  const denied = event.verdict === "DENY";
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", { stringValue: SERVICE_NAME }),
            attr("service.version", { stringValue: CLI_VERSION }),
          ],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: CLI_VERSION },
            spans: [
              {
                traceId: hex(16),
                spanId: hex(8),
                name: `kya.verdict ${event.toolId}`,
                // SPAN_KIND_INTERNAL: the verdict is a local policy decision.
                kind: 1,
                startTimeUnixNano: start,
                endTimeUnixNano: start,
                attributes,
                status: denied
                  ? { code: 2, message: event.reasonCode || "DENY" }
                  : { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Export one verdict span. Never throws, never blocks the caller beyond the
 * 2s timeout budget, and never touches the verdict itself. No-op when the
 * config is undefined (unconfigured) or the endpoint fails the scheme check.
 * Flush outcomes are accumulated in .kya/otel-stats.json (see stats.ts) so the
 * report can show sent/failed counts across processes.
 */
export async function exportVerdictSpan(
  event: VerdictEvent,
  config: OtlpExportConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!config || !endpointAllowed(config)) return;
  stats.attempted += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  try {
    const res = await fetch(tracesUrl(config), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(buildVerdictTracePayload(event)),
      signal: controller.signal,
    });
    // Drain so the socket is released back to the pool.
    await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    if (res.ok) stats.exported += 1;
    else stats.failed += 1;
    recordOtlpExport(env, config.endpoint, res.ok);
  } catch {
    stats.failed += 1;
    recordOtlpExport(env, config.endpoint, false);
  } finally {
    clearTimeout(timer);
  }
}

export interface OtlpExportSelfTestResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * CLI-invocable self-test: POST one synthetic span and report the outcome.
 * Unlike exportVerdictSpan it reports failure detail instead of only counting
 * it - still never throws.
 */
export async function otlpExportSelfTest(
  config: OtlpExportConfig | undefined,
): Promise<OtlpExportSelfTestResult> {
  if (!config) return { ok: false, detail: "otlpExport not configured (no endpoint)" };
  if (!endpointAllowed(config)) {
    return {
      ok: false,
      detail: `endpoint refused: non-https to a non-loopback host needs "insecure": true (${config.endpoint})`,
    };
  }
  const event: VerdictEvent = {
    ts: new Date().toISOString(),
    sessionId: "otlp-selftest",
    toolId: "kya__selftest",
    verdict: "ALLOW",
    reasonCode: "SELFTEST",
    mode: "observe",
    host: "ide",
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  try {
    const res = await fetch(tracesUrl(config), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(buildVerdictTracePayload(event)),
      signal: controller.signal,
    });
    await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    if (res.ok) {
      return { ok: true, detail: `span accepted (${res.status}) at ${tracesUrl(config)}` };
    }
    return { ok: false, detail: `endpoint returned HTTP ${res.status} at ${tracesUrl(config)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `export failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
