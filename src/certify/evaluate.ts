/**
 * Agent Trust Baseline evaluators. Pure functions over a pre-assembled
 * EvidenceContext - no I/O here; all loading lives in certify/context.ts.
 * Evidence only: never a second PEP, never ALLOWs anything. Empty evidence
 * windows yield insufficient_evidence, never a vacuous pass.
 */
import type { OrrRating } from "../commands/orr.js";
import type { OrrCard } from "../receipt/enrich.js";
import type { TrailEvent } from "../trail.js";
import type { OpenshellProverOutcome } from "./openshell-prover.js";
import type {
  CatalogRequirement,
  RequirementCheck,
  RequirementSeverity,
  TrailMatch,
} from "./catalog.js";

export type RequirementStatus = "pass" | "gap" | "insufficient_evidence" | "attested";

export interface RequirementAttestation {
  readonly text: string;
  readonly at: string;
}

export interface CertifyRequirementResult {
  readonly id: string;
  readonly domain: string;
  readonly title: string;
  readonly severity: RequirementSeverity;
  readonly status: RequirementStatus;
  /** One line, redacted, safe for reports and bundles. */
  readonly evidence: string;
  readonly attestation?: RequirementAttestation;
}

export interface CertifyTrailStats {
  readonly eventCount: number;
  readonly verdictMix: {
    readonly ALLOW: number;
    readonly DENY: number;
    readonly REQUIRE_APPROVE: number;
  };
  readonly modes: {
    readonly observe: number;
    readonly hold: number;
    readonly offline: number;
  };
}

export interface CertifyReport {
  readonly format: "shield-kya-certify-report";
  readonly version: 1;
  readonly generatedAt: string;
  readonly catalog: {
    readonly id: string;
    readonly version: string;
    readonly updated: string;
  };
  readonly window: {
    readonly days: number;
    readonly since: string;
    readonly until: string;
  };
  readonly trail: CertifyTrailStats;
  readonly requirements: readonly CertifyRequirementResult[];
  readonly overall: {
    readonly pass: number;
    readonly gap: number;
    readonly insufficientEvidence: number;
    readonly attested: number;
    readonly result: "pass" | "gap";
  };
}

export interface EvidenceContext {
  readonly now: Date;
  /**
   * Full merged trail (global + legacy). Each check filters its own window.
   * Merged `readTrail` output is ts-ascending, but evaluators do not rely on
   * that ordering.
   */
  readonly events: readonly TrailEvent[];
  readonly gateMode: "observe" | "hold" | "offline";
  readonly wiredHostCount: number;
  readonly orr: OrrCard | undefined;
  /** Category id → rating from the latest ORR report, when present. */
  readonly orrCategories: Readonly<Record<string, OrrRating>> | undefined;
  readonly sandboxCount: number;
  /**
   * openshell-prover verdict over the sandbox boundary policy, assembled by
   * certify/context.ts. Absent binary or unparseable output stays optional
   * evidence: insufficient_evidence, never a fail on machines without
   * OpenShell.
   */
  readonly openshellProver?: OpenshellProverOutcome;
  readonly receiptCount: number;
  readonly showbackPresent: boolean;
  readonly attestations: ReadonlyMap<string, RequirementAttestation>;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface CertifyOverallCounts {
  readonly pass: number;
  readonly gap: number;
  readonly insufficientEvidence: number;
  readonly attested: number;
}

export function countRequirements(
  requirements: readonly CertifyRequirementResult[],
): CertifyOverallCounts {
  const counts = { pass: 0, gap: 0, insufficientEvidence: 0, attested: 0 };
  for (const r of requirements) {
    if (r.status === "pass") counts.pass++;
    else if (r.status === "gap") counts.gap++;
    else if (r.status === "attested") counts.attested++;
    else counts.insufficientEvidence++;
  }
  return counts;
}

/**
 * Fail-closed overall: zero certifiable evidence (all insufficient_evidence)
 * must never headline as pass - a green badge requires real evidence.
 * Shared by runCertify and computeLiveCertify so they can never diverge.
 */
export function computeOverall(
  counts: CertifyOverallCounts,
): CertifyReport["overall"] {
  return {
    ...counts,
    result: counts.gap > 0 ? "gap" : counts.pass + counts.attested > 0 ? "pass" : "gap",
  };
}

export function trailStats(events: readonly TrailEvent[]): CertifyTrailStats {
  const verdictMix = { ALLOW: 0, DENY: 0, REQUIRE_APPROVE: 0 };
  const modes = { observe: 0, hold: 0, offline: 0 };
  for (const e of events) {
    const v = e.verdict.toUpperCase();
    if (v === "ALLOW") verdictMix.ALLOW++;
    else if (v === "DENY") verdictMix.DENY++;
    else if (v === "REQUIRE_APPROVE") verdictMix.REQUIRE_APPROVE++;
    if (e.mode === "observe") modes.observe++;
    else if (e.mode === "hold") modes.hold++;
    else modes.offline++;
  }
  return { eventCount: events.length, verdictMix, modes };
}

export function matchEvent(e: TrailEvent, m: TrailMatch): boolean {
  if (m.verdict !== undefined && e.verdict.toUpperCase() !== m.verdict.toUpperCase()) {
    return false;
  }
  if (m.reasonCode !== undefined && e.reasonCode !== m.reasonCode) return false;
  if (m.mode !== undefined && e.mode !== m.mode) return false;
  if (m.neverEvent !== undefined && (e.neverEvent === true) !== m.neverEvent) return false;
  return true;
}

/**
 * trail_min only (a control that PASSES on presence): AGT review/ask is the
 * host's permission prompt, not a KYA human approval, so imported AGT rows never
 * prove an approval path is exercised. trail_zero/trail_ratio keep counting them
 * (excluding them there would false-pass); unverified AGT rows are already dropped
 * for every check by certifyEvidenceEvents.
 */
function countsAsPresence(e: TrailEvent, m: TrailMatch): boolean {
  if (e.importedFrom === "agt" && m.verdict?.toUpperCase() === "REQUIRE_APPROVE") return false;
  return matchEvent(e, m);
}

/** Events with parseable ts within [now - windowDays, now]. */
export function trailWindow(
  events: readonly TrailEvent[],
  windowDays: number,
  now: Date,
): TrailEvent[] {
  const sinceMs = now.getTime() - windowDays * DAY_MS;
  return events.filter((e) => {
    const t = Date.parse(e.ts);
    return !Number.isNaN(t) && t >= sinceMs && t <= now.getTime();
  });
}

function describeMatch(m: TrailMatch): string {
  const parts: string[] = [];
  if (m.verdict) parts.push(`verdict=${m.verdict.toUpperCase()}`);
  if (m.reasonCode) parts.push(`reason=${m.reasonCode}`);
  if (m.mode) parts.push(`mode=${m.mode}`);
  if (m.neverEvent !== undefined) parts.push(`neverEvent=${m.neverEvent}`);
  return parts.length > 0 ? parts.join(" ") : "any event";
}

const RATING_RANK: Record<OrrRating, number> = { green: 0, amber: 1, red: 2 };

export function evaluateRequirement(
  req: CatalogRequirement,
  ctx: EvidenceContext,
): CertifyRequirementResult {
  const attestation = ctx.attestations.get(req.id);
  const result = (status: RequirementStatus, evidence: string): CertifyRequirementResult => ({
    id: req.id,
    domain: req.domain,
    title: req.title,
    severity: req.severity,
    status,
    evidence,
    ...(attestation
      ? { attestation: { text: attestation.text, at: attestation.at } }
      : {}),
  });
  const check: RequirementCheck = req.check;
  switch (check.kind) {
    case "trail_zero": {
      const window = trailWindow(ctx.events, check.windowDays, ctx.now);
      if (window.length === 0) {
        return result(
          "insufficient_evidence",
          `no trail events in the last ${check.windowDays}d`,
        );
      }
      const matches = window.filter((e) => matchEvent(e, check.match));
      if (matches.length === 0) {
        return result(
          "pass",
          `0/${window.length} events match ${describeMatch(check.match)} in ${check.windowDays}d`,
        );
      }
      const latestMs = matches.reduce((acc, e) => {
        const t = Date.parse(e.ts);
        return Number.isNaN(t) ? acc : Math.max(acc, t);
      }, Number.NEGATIVE_INFINITY);
      // ISO-normalized: raw event ts is attacker-controllable, the quoted
      // value in evidence must stay a single line.
      const latest = new Date(latestMs).toISOString();
      return result(
        "gap",
        `${matches.length} event(s) match ${describeMatch(check.match)} in ${check.windowDays}d (latest ${latest})`,
      );
    }
    case "trail_min": {
      const window = trailWindow(ctx.events, check.windowDays, ctx.now);
      if (window.length === 0) {
        return result(
          "insufficient_evidence",
          `no trail events in the last ${check.windowDays}d`,
        );
      }
      const matches = window.filter((e) => countsAsPresence(e, check.match)).length;
      if (matches >= check.min) {
        return result(
          "pass",
          `${matches} event(s) match ${describeMatch(check.match)} in ${check.windowDays}d (min ${check.min})`,
        );
      }
      return result(
        "gap",
        `${matches} event(s) match ${describeMatch(check.match)} in ${check.windowDays}d, need ${check.min}`,
      );
    }
    case "trail_ratio": {
      const window = trailWindow(ctx.events, check.windowDays, ctx.now);
      if (window.length === 0) {
        return result(
          "insufficient_evidence",
          `no trail events in the last ${check.windowDays}d`,
        );
      }
      const matches = window.filter((e) => matchEvent(e, check.match)).length;
      const ratio = matches / window.length;
      const pct = `${(ratio * 100).toFixed(1)}%`;
      // Clean threshold rendering: 0.29 * 100 would print 28.999999999999996.
      const maxPct = `${+(check.maxRatio * 100).toFixed(4)}%`;
      if (ratio <= check.maxRatio) {
        return result(
          "pass",
          `${matches}/${window.length} = ${pct} ≤ ${maxPct} for ${describeMatch(check.match)}`,
        );
      }
      return result(
        "gap",
        `${matches}/${window.length} = ${pct} > ${maxPct} for ${describeMatch(check.match)}`,
      );
    }
    case "config_mode": {
      if (ctx.gateMode === check.not) {
        return result(
          "gap",
          `the gate is in ${ctx.gateMode} mode (watch only, blocks nothing) - to make it block, set KYA_HOLD=1 or KYA_OFFLINE=1, or "gateMode" in .kya/config.json`,
        );
      }
      return result("pass", `the gate is in ${ctx.gateMode} mode`);
    }
    case "hooks_wired": {
      if (ctx.wiredHostCount >= check.min) {
        return result("pass", `${ctx.wiredHostCount} coding tool(s) connected (need ${check.min})`);
      }
      return result(
        "gap",
        `${ctx.wiredHostCount} coding tool(s) connected, need ${check.min} - run kya connect <host> --hooks`,
      );
    }
    case "sandbox_inventory": {
      if (ctx.sandboxCount >= check.min) {
        return result("pass", `${ctx.sandboxCount} sandbox(es) available`);
      }
      return result(
        "gap",
        `no sandbox found - run KYA_SANDBOX=mock kya sandbox spawn`,
      );
    }
    case "openshell_prover": {
      const prover = ctx.openshellProver;
      if (!prover || prover.status === "unavailable" || prover.status === "unparseable") {
        return result("insufficient_evidence", prover?.detail ?? "openshell-prover not evaluated");
      }
      if (prover.status === "violation") {
        return result("gap", prover.detail);
      }
      return result("pass", prover.detail);
    }
    case "receipts_present": {
      if (ctx.receiptCount >= check.min) {
        return result("pass", `${ctx.receiptCount} report file(s) in .kya/receipts`);
      }
      return result("gap", `no reports yet - run kya receipt`);
    }
    case "showback_present": {
      return ctx.showbackPresent
        ? result("pass", "usage file present (.kya/usage.json)")
        : result("gap", "no usage file - add .kya/usage.json or run kya orr with --usage");
    }
    case "attest": {
      if (attestation) return result("attested", `attested ${attestation.at}`);
      return result(
        "gap",
        `no statement recorded - run kya certify --attest ${req.id} --text "…" to answer: ${check.prompt}`,
      );
    }
    case "orr_overall": {
      if (!ctx.orr) {
        return result("insufficient_evidence", "no readiness check yet - run kya orr run --path .");
      }
      if (RATING_RANK[ctx.orr.overall] <= RATING_RANK[check.max]) {
        return result("pass", `readiness check is ${ctx.orr.overall} (must be ${check.max} or better)`);
      }
      return result("gap", `readiness check is ${ctx.orr.overall}, which is worse than ${check.max}`);
    }
    case "orr_category": {
      if (!ctx.orrCategories) {
        return result("insufficient_evidence", "no readiness check yet - run kya orr run --path .");
      }
      const rating = ctx.orrCategories[check.id];
      if (!rating) {
        return result(
          "insufficient_evidence",
          `readiness check has no ${check.id} section`,
        );
      }
      if (RATING_RANK[rating] <= RATING_RANK[check.max]) {
        return result("pass", `readiness check section ${check.id} is ${rating} (must be ${check.max} or better)`);
      }
      return result("gap", `readiness check section ${check.id} is ${rating}, which is worse than ${check.max}`);
    }
    case "orr_fresh": {
      if (!ctx.orr || !ctx.orr.generatedAt) {
        return result("insufficient_evidence", "no readiness check yet - run kya orr run --path .");
      }
      const t = Date.parse(ctx.orr.generatedAt);
      if (Number.isNaN(t)) {
        return result("insufficient_evidence", "readiness check date is unreadable");
      }
      const nowMs = ctx.now.getTime();
      if (t > nowMs) {
        return result(
          "insufficient_evidence",
          "readiness check date is in the future (clock skew) - re-run kya orr run",
        );
      }
      const ageMs = nowMs - t;
      // Exact ms comparison decides; the floored day count is display-only.
      const ageDays = Math.floor(ageMs / DAY_MS);
      if (ageMs <= check.maxAgeDays * DAY_MS) {
        return result("pass", `readiness check is ${ageDays}d old (max ${check.maxAgeDays}d)`);
      }
      return result(
        "gap",
        `readiness check is ${ageDays}d old (max ${check.maxAgeDays}d) - re-run kya orr run`,
      );
    }
  }
  // Unreachable: RequirementCheck union is exhaustive (checked at compile time).
  const exhaustive: never = check;
  throw new Error(`unknown check kind ${JSON.stringify(exhaustive)}`);
}
