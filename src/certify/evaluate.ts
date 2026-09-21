/**
 * Agent Trust Baseline evaluators. Pure functions over a pre-assembled
 * EvidenceContext — no I/O here; all loading lives in commands/certify.ts.
 * Evidence only: never a second PEP, never ALLOWs anything. Empty evidence
 * windows yield insufficient_evidence, never a vacuous pass.
 */
import type { OrrRating } from "../commands/orr.js";
import type { OrrCard } from "../receipt/enrich.js";
import type { TrailEvent } from "../trail.js";
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
  readonly receiptCount: number;
  readonly showbackPresent: boolean;
  readonly attestations: ReadonlyMap<string, RequirementAttestation>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function matchEvent(e: TrailEvent, m: TrailMatch): boolean {
  if (m.verdict !== undefined && e.verdict.toUpperCase() !== m.verdict.toUpperCase()) {
    return false;
  }
  if (m.reasonCode !== undefined && e.reasonCode !== m.reasonCode) return false;
  if (m.mode !== undefined && e.mode !== m.mode) return false;
  if (m.neverEvent !== undefined && (e.neverEvent === true) !== m.neverEvent) return false;
  return true;
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
      const matches = window.filter((e) => matchEvent(e, check.match)).length;
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
          `gate mode is ${ctx.gateMode} — set KYA_HOLD=1 / KYA_OFFLINE=1 or "gateMode" in .kya/config.json`,
        );
      }
      return result("pass", `gate mode is ${ctx.gateMode}`);
    }
    case "hooks_wired": {
      if (ctx.wiredHostCount >= check.min) {
        return result("pass", `${ctx.wiredHostCount} wired host(s) (need ${check.min})`);
      }
      return result(
        "gap",
        `${ctx.wiredHostCount} wired host(s), need ${check.min} — kya connect <host> --hooks`,
      );
    }
    case "sandbox_inventory": {
      if (ctx.sandboxCount >= check.min) {
        return result("pass", `${ctx.sandboxCount} sandbox record(s)`);
      }
      return result(
        "gap",
        `no sandbox inventory — KYA_SANDBOX=mock kya sandbox spawn`,
      );
    }
    case "receipts_present": {
      if (ctx.receiptCount >= check.min) {
        return result("pass", `${ctx.receiptCount} receipt file(s) in .kya/receipts`);
      }
      return result("gap", `no receipts yet — run kya receipt`);
    }
    case "showback_present": {
      return ctx.showbackPresent
        ? result("pass", "showback card present (.kya/usage.json)")
        : result("gap", "no showback card — add .kya/usage.json or run orr with --usage");
    }
    case "attest": {
      if (attestation) return result("attested", `attested ${attestation.at}`);
      return result(
        "gap",
        `no attestation recorded — kya certify --attest ${req.id} --text "…" (${check.prompt})`,
      );
    }
    case "orr_overall": {
      if (!ctx.orr) {
        return result("insufficient_evidence", "no ORR report — kya orr run --path .");
      }
      if (RATING_RANK[ctx.orr.overall] <= RATING_RANK[check.max]) {
        return result("pass", `ORR overall ${ctx.orr.overall} (max ${check.max})`);
      }
      return result("gap", `ORR overall ${ctx.orr.overall} exceeds max ${check.max}`);
    }
    case "orr_category": {
      if (!ctx.orrCategories) {
        return result("insufficient_evidence", "no ORR report — kya orr run --path .");
      }
      const rating = ctx.orrCategories[check.id];
      if (!rating) {
        return result(
          "insufficient_evidence",
          `ORR category ${check.id} not present in latest report`,
        );
      }
      if (RATING_RANK[rating] <= RATING_RANK[check.max]) {
        return result("pass", `ORR ${check.id} ${rating} (max ${check.max})`);
      }
      return result("gap", `ORR ${check.id} ${rating} exceeds max ${check.max}`);
    }
    case "orr_fresh": {
      if (!ctx.orr || !ctx.orr.generatedAt) {
        return result("insufficient_evidence", "no ORR report — kya orr run --path .");
      }
      const t = Date.parse(ctx.orr.generatedAt);
      if (Number.isNaN(t)) {
        return result("insufficient_evidence", "ORR generatedAt unparseable");
      }
      const nowMs = ctx.now.getTime();
      if (t > nowMs) {
        return result(
          "insufficient_evidence",
          "ORR generatedAt is in the future — clock skew, re-run kya orr run",
        );
      }
      const ageMs = nowMs - t;
      // Exact ms comparison decides; the floored day count is display-only.
      const ageDays = Math.floor(ageMs / DAY_MS);
      if (ageMs <= check.maxAgeDays * DAY_MS) {
        return result("pass", `ORR is ${ageDays}d old (max ${check.maxAgeDays}d)`);
      }
      return result(
        "gap",
        `ORR is ${ageDays}d old (max ${check.maxAgeDays}d) — re-run kya orr run`,
      );
    }
  }
  // Unreachable: RequirementCheck union is exhaustive (checked at compile time).
  const exhaustive: never = check;
  throw new Error(`unknown check kind ${JSON.stringify(exhaustive)}`);
}
