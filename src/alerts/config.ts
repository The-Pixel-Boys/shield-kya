/**
 * Incident alert settings. User level only: they come from <KYA_HOME|home>/.kya/config.json
 * and the KYA_ALERTS env switch. A project `.kya/config.json` is never read here, so a repo
 * cannot turn alerts off, lower the floor, or add a receiver. Advisory: local KYA never blocks on this.
 */
import { kyaHome, readFileConfig, writeFileConfig } from "../config.js";
import type { Severity } from "../investigate/detectors.js";

export const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];
export const DEFAULT_MIN_SEVERITY: Severity = "high";
export const DEFAULT_WINDOW_MINUTES = 120;
/** Upper bound so a typo cannot make every flush read a huge window. */
export const MAX_WINDOW_MINUTES = 7 * 24 * 60;

export interface AlertsConfig {
  readonly enabled: boolean;
  readonly minSeverity: Severity;
  readonly windowMinutes: number;
  /** Desktop notification for each new incident alert. `alerts.desktop: false` or KYA_ALERTS_DESKTOP=off turns it off. */
  readonly desktop: boolean;
  /** Where `enabled` came from. */
  readonly source: "env" | "config" | "default";
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

/** KYA_ALERTS=on|off (also 1/true, 0/false). Anything else: no override. */
function envSwitch(env: NodeJS.ProcessEnv): boolean | undefined {
  const v = env.KYA_ALERTS?.trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true") return true;
  if (v === "off" || v === "0" || v === "false") return false;
  return undefined;
}

/** The user-level `alerts` object, defensively parsed. Never throws. */
export function resolveAlertsConfig(env: NodeJS.ProcessEnv = process.env): AlertsConfig {
  let raw: Record<string, unknown> = {};
  try {
    const a = (readFileConfig(kyaHome(env)) as { alerts?: unknown }).alerts;
    if (a && typeof a === "object" && !Array.isArray(a)) raw = a as Record<string, unknown>;
  } catch {
    /* unreadable config: defaults */
  }
  const minSeverity = isSeverity(raw["minSeverity"]) ? raw["minSeverity"] : DEFAULT_MIN_SEVERITY;
  const w = raw["windowMinutes"];
  const windowMinutes =
    typeof w === "number" && Number.isFinite(w) && w > 0
      ? Math.min(Math.floor(w), MAX_WINDOW_MINUTES)
      : DEFAULT_WINDOW_MINUTES;
  const desktop = raw["desktop"] !== false && !/^(off|0|false)$/i.test(env.KYA_ALERTS_DESKTOP?.trim() ?? "");
  const override = envSwitch(env);
  if (override !== undefined) return { enabled: override, minSeverity, windowMinutes, desktop, source: "env" };
  if (typeof raw["enabled"] === "boolean") {
    return { enabled: raw["enabled"], minSeverity, windowMinutes, desktop, source: "config" };
  }
  return { enabled: false, minSeverity, windowMinutes, desktop, source: "default" };
}

/** `kya alerts on|off`: write `alerts.enabled` to the user-level config, keep the other keys. */
export function writeAlertsEnabled(env: NodeJS.ProcessEnv, enabled: boolean): void {
  const home = kyaHome(env);
  const prev = (readFileConfig(home) as { alerts?: unknown }).alerts;
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
  writeFileConfig(home, { alerts: { ...base, enabled } } as never);
}
