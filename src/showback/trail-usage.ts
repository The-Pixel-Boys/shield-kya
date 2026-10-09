/**
 * Trail-usage showback (observe only). Aggregates per-event usage captured on
 * the trail: real token counts when the host reported them, a static
 * per-event estimate when it did not. Not a billing meter. Not a PEP -
 * spend must never influence verdicts, so nothing here feeds the gate.
 */

import type { TrailEvent } from "../trail.js";

/** Static fallback estimate for one gated tool call without reported usage. */
export const STATIC_ESTIMATE_TOKENS_IN = 2000;
export const STATIC_ESTIMATE_TOKENS_OUT = 500;

export interface TrailUsageSummary {
  readonly events: number;
  /** Events whose token counts came from the host, not the estimate. */
  readonly realUsageEvents: number;
  /** events - realUsageEvents (rows priced at the static estimate). */
  readonly estimatedEvents: number;
  /** real + estimated, what the panel totals display. */
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly realTokensIn: number;
  readonly realTokensOut: number;
  readonly estimatedTokensIn: number;
  readonly estimatedTokensOut: number;
}

function realTokens(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : undefined;
}

/**
 * Per event: prefer reported tokensIn/tokensOut; fall back to the static
 * estimate only when the event carries no real usage at all.
 */
export function summarizeTrailUsage(
  events: readonly TrailEvent[],
): TrailUsageSummary {
  let realUsageEvents = 0;
  let realIn = 0;
  let realOut = 0;
  let estimatedEvents = 0;
  for (const e of events) {
    const tin = realTokens(e.tokensIn);
    const tout = realTokens(e.tokensOut);
    if (tin !== undefined || tout !== undefined) {
      realUsageEvents += 1;
      realIn += tin ?? 0;
      realOut += tout ?? 0;
    } else {
      estimatedEvents += 1;
    }
  }
  const estimatedTokensIn = estimatedEvents * STATIC_ESTIMATE_TOKENS_IN;
  const estimatedTokensOut = estimatedEvents * STATIC_ESTIMATE_TOKENS_OUT;
  return {
    events: events.length,
    realUsageEvents,
    estimatedEvents,
    tokensIn: realIn + estimatedTokensIn,
    tokensOut: realOut + estimatedTokensOut,
    realTokensIn: realIn,
    realTokensOut: realOut,
    estimatedTokensIn,
    estimatedTokensOut,
  };
}
