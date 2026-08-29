/**
 * Published list-price estimates for display-only showback.
 * Dated 2026-08-29. Not an invoice. Unknown models return null USD.
 * Keep in lockstep with Java PublishedModelRates (same test vectors).
 */

export interface ModelRate {
  readonly model: string;
  /** USD per 1M input tokens */
  readonly inputPer1M: number;
  /** USD per 1M output tokens (reasoning billed as output when present) */
  readonly outputPer1M: number;
}

/** Rates table as of 2026-08-29. Estimate only. */
export const PUBLISHED_MODEL_RATES: readonly ModelRate[] = [
  { model: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10 },
  { model: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6 },
  { model: "claude-sonnet-4", inputPer1M: 3, outputPer1M: 15 },
  { model: "claude-3-5-sonnet", inputPer1M: 3, outputPer1M: 15 },
  { model: "claude-3-5-haiku", inputPer1M: 0.8, outputPer1M: 4 },
  { model: "grok-4", inputPer1M: 3, outputPer1M: 15 },
  { model: "grok-2", inputPer1M: 2, outputPer1M: 10 },
];

const byModel = new Map(
  PUBLISHED_MODEL_RATES.map((r) => [r.model.toLowerCase(), r] as const),
);

export function lookupRate(model: string | undefined | null): ModelRate | null {
  if (!model) return null;
  const key = model.trim().toLowerCase();
  if (!key) return null;
  return byModel.get(key) ?? null;
}

/** USD for one request. Returns null when the model has no published rate. */
export function estimateRequestUsd(
  model: string | undefined | null,
  tokensIn: number,
  tokensOut: number,
  reasoningTokens = 0,
): number | null {
  const rate = lookupRate(model);
  if (!rate) return null;
  const inTok = Math.max(0, tokensIn);
  const outTok = Math.max(0, tokensOut) + Math.max(0, reasoningTokens);
  return (inTok * rate.inputPer1M + outTok * rate.outputPer1M) / 1_000_000;
}
