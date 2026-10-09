/**
 * `kya receipt --share` - publish a redacted summary of the current report
 * window to the hosted platform and get back a public URL.
 *
 * The payload is built FROM THE RECEIPT MODEL, never from the raw trail:
 * aggregate counts and public labels only. No absolute paths, no session ids,
 * no tool arguments, no identity (baseUrl/IP) - anything that could identify
 * a machine, project, or person stays local. Dependency-free: global fetch.
 */
import { CLI_VERSION } from "../version.js";
import { aggregateEvents, type ReceiptModel } from "./render-receipt.js";

export const SHARE_DEFAULT_BASE_URL = "https://shield-agent.com";
export const SHARE_PATH = "/api/v1/share/reports";
export const SHARE_TIMEOUT_MS = 15_000;
export const SHARE_MAX_RETRIES = 3;

/** Exponential backoff per retry attempt (index 0 = first retry). */
const RETRY_BASE_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const RETRY_JITTER_MS = 250;
/** Cap on a server-supplied Retry-After so a hostile header can't park the CLI. */
const RETRY_AFTER_CAP_S = 60;

export interface ShareStats {
  readonly total: number;
  readonly allow: number;
  readonly review: number;
  readonly deny: number;
  readonly never: number;
  /** Distinct sessions in the window - a count, never ids. */
  readonly sessions: number;
}

export interface ShareCertify {
  readonly status: "pass" | "gap";
  readonly pass: number;
  readonly gap: number;
  readonly insufficient: number;
  readonly attested: number;
  readonly topGaps: readonly { readonly id: string; readonly severity: string; readonly title: string }[];
}

export interface SharePayload {
  readonly version: 1;
  readonly title: string;
  readonly rangeLabel: string;
  readonly generatedAt: string;
  readonly cliVersion: string;
  readonly stats: ShareStats;
  readonly products: readonly { readonly label: string; readonly count: number }[];
  readonly reasonCodes: readonly { readonly code: string; readonly count: number }[];
  readonly certify: ShareCertify | null;
}

/**
 * Roll the model into the share payload. Only fields that are already public
 * labels or aggregates leave the machine: verdict counts, product/reason
 * labels, and certify requirement ids (catalog identifiers). Events, session
 * ids, tool args, paths, and identity never enter the payload.
 */
export function buildSharePayload(model: ReceiptModel): SharePayload {
  const events = model.events;
  let allow = 0;
  let review = 0;
  let deny = 0;
  let never = 0;
  const sessions = new Set<string>();
  for (const e of events) {
    const v = e.verdict.toUpperCase();
    if (e.neverEvent || e.reasonCode === "NEVER_EVENT") never++;
    if (v === "ALLOW") allow++;
    else if (v === "DENY") deny++;
    else if (v === "REQUIRE_APPROVE") review++;
    sessions.add(e.sessionId?.trim() || "unknown");
  }
  const agg = aggregateEvents(events);
  return {
    version: 1,
    title: model.title,
    rangeLabel: model.rangeLabel,
    generatedAt: model.generatedAt,
    cliVersion: CLI_VERSION,
    stats: {
      total: events.length,
      allow,
      review,
      deny,
      never,
      sessions: sessions.size,
    },
    products: agg.products.slice(0, 6).map(({ label, count }) => ({ label, count })),
    reasonCodes: agg.reasons.slice(0, 8).map(({ label, count }) => ({ code: label, count })),
    certify: model.certify
      ? {
          status: model.certify.result,
          pass: model.certify.pass,
          gap: model.certify.gap,
          insufficient: model.certify.insufficientEvidence,
          attested: model.certify.attested,
          topGaps: model.certify.topGaps.slice(0, 5).map(({ id, severity, title }) => ({ id, severity, title })),
        }
      : null,
  };
}

/** Resolve the endpoint base: --share-url flag > KYA_SHARE_URL > default. */
export function shareBaseUrl(override: string | undefined, env: NodeJS.ProcessEnv): string {
  const raw = override?.trim() || env.KYA_SHARE_URL?.trim() || SHARE_DEFAULT_BASE_URL;
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 47 /* / */) end--;
  return raw.slice(0, end);
}

export type ShareResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly error: string;
      /** HTTP status when the failure came from a response (absent on network/timeout). */
      readonly status?: number;
      /** Parsed Retry-After seconds from a 429, when present. */
      readonly retryAfterSeconds?: number;
    };

/** Parse a Retry-After header as integer seconds; undefined when absent/malformed. */
function parseRetryAfterSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Clamp a --share-retries flag value: negative/non-numeric → 0, cap at SHARE_MAX_RETRIES. */
export function clampShareRetries(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, SHARE_MAX_RETRIES);
}

/** POST the payload; 15s timeout. Never throws - failures come back as {ok:false}. */
export async function shareReceiptPayload(
  payload: SharePayload,
  opts: { readonly baseUrl: string; readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number },
): Promise<ShareResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SHARE_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}${SHARE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        error: timedOut ? "share failed: request timed out" : `share failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (res.status !== 200 && res.status !== 201) {
      if (res.status === 429) {
        const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get("Retry-After"));
        return {
          ok: false,
          status: 429,
          retryAfterSeconds,
          error:
            retryAfterSeconds != null
              ? `share failed: rate limited - retry in ~${retryAfterSeconds}s`
              : "share failed: rate limited - retry later",
        };
      }
      return { ok: false, status: res.status, error: `share failed: HTTP ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as { url?: unknown } | null;
    if (!data || typeof data.url !== "string" || !data.url) {
      return { ok: false, error: "share failed: response did not include a url" };
    }
    return { ok: true, url: data.url };
  } finally {
    clearTimeout(timer);
  }
}

/** Retryable failures: 429, 5xx, or network/timeout. 4xx validation errors are final. */
function isShareRetryable(result: ShareResult): boolean {
  return !result.ok && (result.status === undefined || result.status === 429 || result.status >= 500);
}

/** Backoff for the next attempt: Retry-After wins (capped), else exponential + jitter. */
function shareRetryDelayMs(
  failure: Extract<ShareResult, { ok: false }>,
  attempt: number,
): number {
  if (failure.retryAfterSeconds != null) {
    return Math.min(failure.retryAfterSeconds, RETRY_AFTER_CAP_S) * 1000;
  }
  const base = RETRY_BASE_DELAYS_MS[Math.min(attempt, RETRY_BASE_DELAYS_MS.length - 1)]!;
  return base + Math.floor(Math.random() * (RETRY_JITTER_MS + 1));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opt-in bounded retry around the single-attempt shareReceiptPayload: at most
 * SHARE_MAX_RETRIES retries on 429/5xx/network failures, exponential backoff
 * with jitter, honoring Retry-After. Default (retries 0) stays single-attempt.
 */
export async function shareReceiptWithRetry(
  payload: SharePayload,
  opts: {
    readonly baseUrl: string;
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
    readonly retries?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<ShareResult> {
  const requested = opts.retries ?? 0;
  const retries =
    Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), SHARE_MAX_RETRIES) : 0;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const result = await shareReceiptPayload(payload, opts);
    if (result.ok || !isShareRetryable(result) || attempt >= retries) return result;
    await sleep(shareRetryDelayMs(result, attempt));
  }
}
