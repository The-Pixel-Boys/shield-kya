/**
 * One-line calls to action (CTAs) for the hosted console: after `kya certify` finds gaps,
 * when the local receipt shows only the newest part of the trail, and after a plain
 * `kya receipt` (the --share hint).
 *
 * Silent (no output, no state written) when: --json, CI (CI or GITHUB_ACTIONS set), stdout is not a
 * terminal, KYA_QUIET is set (or certify --quiet), KYA_CTA is off, the config opt-out is set
 * (.kya/config.json ctaOptOut, or ~/.kya/cta.json optOut), or a CTA already printed in the last 24 hours.
 * The CTA makes no network call and sends no telemetry. A failure here never changes an exit code.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir, readFileConfig } from "./config.js";
import { atomicWriteSync } from "./fs-atomic.js";

export type CtaKind = "certify-gaps" | "receipt-truncated" | "receipt-share";

export const CTA_LINES: Readonly<Record<CtaKind, string>> = {
  "certify-gaps": "Gaps found. Run kya login to see them tracked over time in the hosted console.",
  "receipt-truncated": "This report shows only the newest part of the trail. Run kya login for the full history.",
  "receipt-share": "Run kya receipt --share for a redacted link to send to a colleague.",
};

export const CTA_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CtaGate {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Whether stdout is a terminal. */
  readonly isTty: boolean;
  /** The command printed machine-readable output (--json, --json-stdout). */
  readonly json?: boolean;
  /** certify --quiet, or any other command-level quiet flag. */
  readonly quiet?: boolean;
  readonly now?: number;
}

interface CtaState {
  readonly optOut?: boolean;
  readonly lastShownAt?: string;
}

const OFF_RE = /^(0|false|no|off)$/i;
const truthy = (v: string | undefined): boolean => v !== undefined && v.trim() !== "" && !OFF_RE.test(v.trim());

export function ctaStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "cta.json");
}

function readState(env: NodeJS.ProcessEnv): CtaState {
  try {
    const path = ctaStatePath(env);
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as CtaState;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** Why no CTA may print now, or undefined when one may. Pure apart from reading the opt-out files. */
export function ctaSkipReason(gate: CtaGate): string | undefined {
  if (gate.json) return "machine-readable output";
  if (truthy(gate.env.CI) || gate.env.GITHUB_ACTIONS === "true") return "running in CI";
  if (!gate.isTty) return "not a terminal";
  if (gate.quiet || truthy(gate.env.KYA_QUIET)) return "quiet";
  if (gate.env.KYA_CTA !== undefined && OFF_RE.test(gate.env.KYA_CTA.trim())) return "KYA_CTA is off";
  if (readFileConfig(gate.cwd).ctaOptOut === true) return "opted out in .kya/config.json";
  const state = readState(gate.env);
  if (state.optOut === true) return "opted out";
  const now = gate.now ?? Date.now();
  const last = state.lastShownAt ? Date.parse(state.lastShownAt) : Number.NaN;
  // A time in the future (clock moved back) gives a negative difference, so it also counts as recent.
  if (Number.isFinite(last) && now - last < CTA_INTERVAL_MS) {
    return "already shown in the last 24 hours";
  }
  return undefined;
}

/**
 * Print the CTA line when no skip reason applies, and record the time shown. Returns whether it printed.
 * Every failure is swallowed: a CTA must never break a command.
 */
export function maybeCta(kind: CtaKind, gate: CtaGate, log: (msg: string) => void): boolean {
  try {
    if (ctaSkipReason(gate) !== undefined) return false;
    log(CTA_LINES[kind]);
    try {
      const state = readState(gate.env);
      mkdirSync(globalConfigDir(gate.env), { recursive: true });
      atomicWriteSync(
        ctaStatePath(gate.env),
        `${JSON.stringify({ ...state, lastShownAt: new Date(gate.now ?? Date.now()).toISOString() }, null, 2)}\n`,
      );
    } catch {
      /* worst case the CTA prints again tomorrow */
    }
    return true;
  } catch {
    return false;
  }
}
