/**
 * Webhook delivery for trail verdicts. Reliability contract (a notify failure must never change
 * what the gate does with the tool call itself):
 *
 *  - up to 3 retries after the first attempt, backoff 250ms / 1s / 4s with up to +25% jitter;
 *  - per-attempt timeout (default 3s) via AbortController;
 *  - process-wide rate limit: max 20 sends per rolling minute, overflow counted and dropped;
 *  - per-URL circuit breaker: 5 consecutive failed deliveries open the circuit for 5 minutes,
 *    while open the URL gets nothing (drops counted separately);
 *  - nothing in this module throws.
 */

export type NotifyFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status">>;

export interface NotifyDeps {
  readonly fetchImpl?: NotifyFetchLike;
  /** Test seam: replaces the backoff wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam: jitter source, defaults to Math.random. */
  readonly random?: () => number;
  /** Test seam: clock for the rate window and circuit breaker. */
  readonly nowMs?: () => number;
}

export interface SendOptions {
  readonly url: string;
  readonly body: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  /** Test seam: replaces RETRY_DELAYS_MS. */
  readonly retryDelaysMs?: readonly number[];
}

export const DEFAULT_TIMEOUT_MS = 3_000;
/** Wait before retry attempts 1..3 (the first send is immediate, so 4 sends worst case). */
export const RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000];
export const JITTER_RATIO = 0.25;

export const RATE_LIMIT_MAX_SENDS = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export const CIRCUIT_FAILURES_TO_OPEN = 5;
export const CIRCUIT_OPEN_MS = 5 * 60_000;

// Process-wide state: the hook path is spawn-per-tool-call in some hosts, but long-lived MCP /
// gateway processes share one limiter so a flood of denies cannot hammer a receiver.
const sendTimestamps: number[] = [];
let droppedByRateLimit = 0;
let droppedByCircuitOpen = 0;

interface CircuitState {
  failures: number;
  openUntil: number;
}

const circuits = new Map<string, CircuitState>();

/** Snapshot of drop counters, for `kya` diagnostics and tests. */
export function notifyStats(): { droppedByRateLimit: number; droppedByCircuitOpen: number } {
  return { droppedByRateLimit, droppedByCircuitOpen };
}

/** Test helper: clears the rate window, the drop counters and every circuit. */
export function resetNotifyState(): void {
  sendTimestamps.length = 0;
  droppedByRateLimit = 0;
  droppedByCircuitOpen = 0;
  circuits.clear();
}

/** One POST against the rolling-minute quota. False (and counted) when the window is full. */
function consumeSendQuota(nowMs: number): boolean {
  while (sendTimestamps.length > 0 && nowMs - (sendTimestamps[0] ?? 0) >= RATE_LIMIT_WINDOW_MS) {
    sendTimestamps.shift();
  }
  if (sendTimestamps.length >= RATE_LIMIT_MAX_SENDS) {
    droppedByRateLimit += 1;
    return false;
  }
  sendTimestamps.push(nowMs);
  return true;
}

function circuitOpen(url: string, nowMs: number): boolean {
  const state = circuits.get(url);
  if (state === undefined) return false;
  if (state.openUntil > nowMs) return true;
  if (state.failures >= CIRCUIT_FAILURES_TO_OPEN) {
    // Cooldown elapsed: half-open, the next delivery decides.
    state.failures = 0;
    state.openUntil = 0;
  }
  return false;
}

function recordDeliverySuccess(url: string): void {
  circuits.delete(url);
}

function recordDeliveryFailure(url: string, nowMs: number): void {
  const state = circuits.get(url) ?? { failures: 0, openUntil: 0 };
  state.failures += 1;
  if (state.failures >= CIRCUIT_FAILURES_TO_OPEN) {
    state.openUntil = nowMs + CIRCUIT_OPEN_MS;
  }
  circuits.set(url, state);
}

function backoffWithJitter(baseMs: number, random: () => number): number {
  return baseMs + Math.floor(baseMs * JITTER_RATIO * random());
}

/** Single attempt. ok only on a 2xx; timeout, abort, redirect and network errors are all false. */
export async function postWebhook(
  url: string,
  body: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
  fetchImpl: NotifyFetchLike = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutMs =
    opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "shield-agent-kya-cli/notify",
        ...opts.headers,
      },
      body,
      redirect: "error",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver one serialized payload with retries. Returns whether it was delivered (or at least
 * accepted by the receiver). Rate-limited attempts drop the whole delivery without counting as a
 * receiver failure; an exhausted retry sequence feeds the circuit breaker. Never throws.
 */
export async function sendWithRetry(opts: SendOptions, deps: NotifyDeps = {}): Promise<boolean> {
  try {
    const nowMs = deps.nowMs ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const random = deps.random ?? Math.random;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;

    if (circuitOpen(opts.url, nowMs())) {
      droppedByCircuitOpen += 1;
      return false;
    }

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) {
        await sleep(backoffWithJitter(delays[attempt - 1] ?? 0, random));
      }
      if (!consumeSendQuota(nowMs())) return false;
      const ok = await postWebhook(
        opts.url,
        opts.body,
        { headers: opts.headers, timeoutMs: opts.timeoutMs },
        fetchImpl,
      );
      if (ok) {
        recordDeliverySuccess(opts.url);
        return true;
      }
    }
    recordDeliveryFailure(opts.url, nowMs());
    return false;
  } catch {
    return false;
  }
}
