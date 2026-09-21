/**
 * Live in-memory certify evaluation — the "certified right now" panel data.
 * Recomputes the full Agent Trust Baseline from local evidence on every call
 * and returns a real CertifyReport, identical in shape to `kya certify` output
 * so the receipt panel and any other consumer can treat them interchangeably.
 * Read-only: no report files, no .kya/certify writes, no side effects beyond
 * the local readers the evidence context already uses.
 */
import { UsageError } from "../errors.js";
import { loadCatalog } from "./catalog.js";
import { assembleEvidenceContext } from "./context.js";
import {
  computeOverall,
  countRequirements,
  DAY_MS,
  evaluateRequirement,
  trailStats,
  trailWindow,
  type CertifyReport,
} from "./evaluate.js";

export function computeLiveCertify(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  windowDays = 30,
  now: Date = new Date(),
): CertifyReport {
  // Public SDK surface — enforce the same window rule as the CLI boundary.
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) {
    throw new UsageError("windowDays must be an integer between 1 and 366");
  }
  const catalog = loadCatalog();
  const ctx = assembleEvidenceContext(cwd, env, now);
  const requirements = catalog.requirements.map((r) => evaluateRequirement(r, ctx));
  // Report-window stats mirror runCertify: ctx.events is the full trail;
  // per-check windows are owned by the evaluators.
  const inWindow = trailWindow(ctx.events, windowDays, now);
  return {
    format: "shield-kya-certify-report",
    version: 1,
    generatedAt: now.toISOString(),
    catalog: { id: catalog.id, version: catalog.version, updated: catalog.updated },
    window: {
      days: windowDays,
      since: new Date(now.getTime() - windowDays * DAY_MS).toISOString(),
      until: now.toISOString(),
    },
    trail: trailStats(inWindow),
    requirements,
    overall: computeOverall(countRequirements(requirements)),
  };
}
