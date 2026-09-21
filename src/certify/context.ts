/**
 * Shared evidence-context assembly for `kya certify` and live report panels.
 * Single source of truth: runCertify and the receipt report panel both build
 * their EvidenceContext here so they can never diverge. Local readers only:
 * no network, no account, no key check.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { kyaHome, resolveGateMode } from "../config.js";
import {
  loadOrrCard,
  loadOrrCategoryRatings,
  loadSandboxes,
  loadShowbackCard,
  loadWiredHosts,
} from "../receipt/enrich.js";
import { readTrail, receiptsDir } from "../trail.js";
import { loadAttestations } from "./attest.js";
import type { EvidenceContext } from "./evaluate.js";

/** Receipt artifacts (html/json/md) in .kya/receipts. */
export function countReceipts(cwd: string): number {
  try {
    const dir = receiptsDir(cwd);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
    return readdirSync(dir).filter((n) => /\.(html|json|md)$/i.test(n)).length;
  } catch {
    return 0;
  }
}

/**
 * Assemble the EvidenceContext every certify evaluation runs against.
 * The trail is read once and passed through unfiltered (0.6.0 parity):
 * each check windows it per its own windowDays via trailWindow. Callers
 * that need a report window (runCertify stats/bundle) re-filter themselves.
 */
export function assembleEvidenceContext(
  cwd: string,
  env: NodeJS.ProcessEnv,
  now: Date = new Date(),
): EvidenceContext {
  const events = readTrail(cwd, env);
  const wiredHosts = loadWiredHosts(cwd, kyaHome(env));
  const sandboxes = loadSandboxes(cwd, env);
  return {
    now,
    events,
    // The shared resolver the gate itself uses (config.ts) — certify can
    // never report a mode the gate would not actually run.
    gateMode: resolveGateMode({ cwd, env }),
    wiredHostCount: wiredHosts.filter((h) => h.wired !== "none").length,
    orr: loadOrrCard(cwd),
    orrCategories: loadOrrCategoryRatings(cwd),
    sandboxCount: sandboxes.sandboxes.length,
    receiptCount: countReceipts(cwd),
    showbackPresent: loadShowbackCard(cwd) !== undefined,
    attestations: loadAttestations(cwd),
  };
}
