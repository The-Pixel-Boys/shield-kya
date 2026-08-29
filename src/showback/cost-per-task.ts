/**
 * Cost-per-task showback (observe only). Not a PEP. Not a billing meter.
 * Subagents are nested steps on one run (parentRunId), not extra registry seats.
 */

import { estimateRequestUsd } from "./rates.js";
import { redactEvidence } from "../orr/agentshield.js";

export interface UsageRecord {
  readonly agentId: string;
  readonly parentRunId?: string;
  readonly runId?: string;
  readonly model?: string;
  readonly route?: string;
  readonly environment?: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly reasoningTokens?: number;
  /** Extra request-like steps beyond the first (retries). Default 0. */
  readonly retries?: number;
}

export interface RunShowback {
  readonly runId: string;
  readonly parentAgentId: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly estimatedUsd: number | null;
  readonly steps: number;
  readonly subagentIds: readonly string[];
}

export interface AgentShowback {
  readonly agentId: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly estimatedUsd: number | null;
  readonly runs: number;
}

export interface ShowbackReport {
  readonly billingMeter: false;
  readonly disclaimer: string;
  readonly totalTokensIn: number;
  readonly totalTokensOut: number;
  readonly estimatedUsd: number | null;
  readonly perRun: readonly RunShowback[];
  readonly perAgent: readonly AgentShowback[];
}

export const SHOWBACK_DISCLAIMER =
  "Estimate from published list prices. Not a billing meter. Not a PEP.";

function nonNeg(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function requestCost(rec: UsageRecord): number | null {
  const retries = nonNeg(rec.retries);
  const multiplier = 1 + retries;
  const one = estimateRequestUsd(
    rec.model,
    nonNeg(rec.tokensIn),
    nonNeg(rec.tokensOut),
    nonNeg(rec.reasoningTokens),
  );
  if (one === null) return null;
  return one * multiplier;
}

function requestTokens(rec: UsageRecord): { in: number; out: number; steps: number } {
  const retries = nonNeg(rec.retries);
  const multiplier = 1 + retries;
  return {
    in: nonNeg(rec.tokensIn) * multiplier,
    out: (nonNeg(rec.tokensOut) + nonNeg(rec.reasoningTokens)) * multiplier,
    steps: multiplier,
  };
}

function runKey(rec: UsageRecord): string {
  if (rec.parentRunId && rec.parentRunId.trim()) return rec.parentRunId.trim();
  if (rec.runId && rec.runId.trim()) return rec.runId.trim();
  return `solo:${rec.agentId}`;
}

/**
 * Roll usage into per-run and per-agent showback.
 * Nested subagents share parentRunId and roll into that run's cost-per-task.
 */
export function buildShowback(records: readonly UsageRecord[]): ShowbackReport {
  const byRun = new Map<
    string,
    {
      parentAgentId: string;
      tokensIn: number;
      tokensOut: number;
      usd: number | null;
      usdKnown: boolean;
      steps: number;
      subagents: Set<string>;
    }
  >();

  for (const rec of records) {
    if (!rec.agentId || !rec.agentId.trim()) continue;
    const key = runKey(rec);
    const tok = requestTokens(rec);
    const usd = requestCost(rec);
    let row = byRun.get(key);
    if (!row) {
      row = {
        parentAgentId: rec.agentId,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        usdKnown: true,
        steps: 0,
        subagents: new Set(),
      };
      byRun.set(key, row);
    }
    if (rec.parentRunId) {
      row.subagents.add(rec.agentId);
    } else {
      row.parentAgentId = rec.agentId;
    }
    row.tokensIn += tok.in;
    row.tokensOut += tok.out;
    row.steps += tok.steps;
    if (usd === null) {
      row.usdKnown = false;
    } else if (row.usdKnown) {
      row.usd = (row.usd ?? 0) + usd;
    }
  }

  const perRun: RunShowback[] = [...byRun.entries()].map(([runId, row]) => ({
    runId,
    parentAgentId: row.parentAgentId,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    estimatedUsd: row.usdKnown ? roundUsd(row.usd ?? 0) : null,
    steps: row.steps,
    subagentIds: [...row.subagents].sort(),
  }));
  perRun.sort((a, b) => a.runId.localeCompare(b.runId));

  const byAgent = new Map<
    string,
    { tokensIn: number; tokensOut: number; usd: number | null; usdKnown: boolean; runs: Set<string> }
  >();
  for (const rec of records) {
    if (!rec.agentId || !rec.agentId.trim()) continue;
    const tok = requestTokens(rec);
    const usd = requestCost(rec);
    let row = byAgent.get(rec.agentId);
    if (!row) {
      row = { tokensIn: 0, tokensOut: 0, usd: 0, usdKnown: true, runs: new Set() };
      byAgent.set(rec.agentId, row);
    }
    row.tokensIn += tok.in;
    row.tokensOut += tok.out;
    row.runs.add(runKey(rec));
    if (usd === null) row.usdKnown = false;
    else if (row.usdKnown) row.usd = (row.usd ?? 0) + usd;
  }

  const perAgent: AgentShowback[] = [...byAgent.entries()].map(([agentId, row]) => ({
    agentId,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    estimatedUsd: row.usdKnown ? roundUsd(row.usd ?? 0) : null,
    runs: row.runs.size,
  }));
  perAgent.sort((a, b) => a.agentId.localeCompare(b.agentId));

  let totalIn = 0;
  let totalOut = 0;
  let totalUsd = 0;
  let usdKnown = true;
  for (const r of perRun) {
    totalIn += r.tokensIn;
    totalOut += r.tokensOut;
    if (r.estimatedUsd === null) usdKnown = false;
    else totalUsd += r.estimatedUsd;
  }

  return {
    billingMeter: false,
    disclaimer: SHOWBACK_DISCLAIMER,
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
    estimatedUsd: usdKnown && perRun.length > 0 ? roundUsd(totalUsd) : perRun.length === 0 ? 0 : null,
    perRun,
    perAgent,
  };
}

function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

const MAX_USAGE_ROWS = 100;
const MAX_AGENT_ID = 128;
const MAX_LABEL = 64;
const MAX_TOKENS = 50_000_000;
function secretShaped(value: string | undefined): boolean {
  if (!value) return false;
  return redactEvidence(value) !== value;
}

export function parseUsageRecords(raw: unknown): UsageRecord[] {
  if (!Array.isArray(raw)) {
    throw new Error("usage must be an array");
  }
  if (raw.length > MAX_USAGE_ROWS) {
    throw new Error("usage exceeds 100 rows");
  }
  const out: UsageRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const agentId = boundRequired(
      typeof o.agentId === "string" ? o.agentId : typeof o.agent_id === "string" ? o.agent_id : "",
      MAX_AGENT_ID,
    );
    if (!agentId) continue;
    const parentRunId = boundOptional(str(o.parentRunId ?? o.parent_run_id), MAX_LABEL);
    const runId = boundOptional(str(o.runId ?? o.run_id), MAX_LABEL);
    const model = boundOptional(str(o.model), MAX_LABEL);
    const route = boundOptional(str(o.route), MAX_LABEL);
    const environment = boundOptional(str(o.environment ?? o.env), MAX_LABEL);
    if (
      secretShaped(agentId) ||
      secretShaped(parentRunId) ||
      secretShaped(runId) ||
      secretShaped(model) ||
      secretShaped(route) ||
      secretShaped(environment)
    ) {
      continue;
    }
    out.push({
      agentId,
      parentRunId,
      runId,
      model,
      route,
      environment,
      tokensIn: clampTokens(num(o.tokensIn ?? o.tokens_in)),
      tokensOut: clampTokens(num(o.tokensOut ?? o.tokens_out)),
      reasoningTokens: clampTokens(optionalNum(o.reasoningTokens ?? o.reasoning_tokens) ?? 0),
      retries: Math.min(100, optionalNum(o.retries) ?? 0),
    });
  }
  return out;
}



function boundRequired(raw: string, max: number): string | undefined {
  const t = raw.trim();
  if (!t || t.length > max) return undefined;
  return t;
}

function boundOptional(raw: string | undefined, max: number): string | undefined {
  if (!raw) return undefined;
  if (raw.length > max) return undefined;
  return raw;
}

function clampTokens(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_TOKENS, Math.floor(n));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Math.max(0, Math.floor(Number(v)));
  }
  return 0;
}

function optionalNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return num(v);
}
