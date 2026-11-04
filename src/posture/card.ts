/**
 * The posture view for the receipt report, the live server and `kya dash`. Shows what would be
 * sent and the local toggle. Sync and local only. The device id and the label are never part of
 * this view, so a shared report page cannot carry them.
 */
import { readIocResult } from "../ioc/result.js";
import { previewPosture } from "./send.js";
import { readCredentials } from "../login/credentials.js";
import { readPostureState, shareOn, writePostureConfig } from "./store.js";
import type { Violation } from "./validate.js";

export interface PostureCard {
  readonly share: boolean;
  readonly hosted: boolean;
  readonly hosts: readonly string[];
  readonly extensions: readonly string[];
  readonly mcpServers: readonly string[];
  readonly iocLine: string;
  readonly neverMode: string;
  readonly violations: readonly Violation[];
  readonly policy: string;
  readonly lastSentAt: string | undefined;
}

export function postureCard(env: NodeJS.ProcessEnv, now: Date = new Date()): PostureCard {
  const { report, violations } = previewPosture(env, now);
  const r = report as Record<string, unknown>;
  const arr = (k: string): Record<string, unknown>[] => (Array.isArray(r[k]) ? (r[k] as Record<string, unknown>[]) : []);
  const ioc = readIocResult(env);
  const state = readPostureState(env);
  return {
    share: shareOn(env),
    hosted: readCredentials(env) !== undefined,
    hosts: arr("hosts").map((h) => String(h["id"])),
    extensions: arr("extensions").map((e) => `${e["id"]}${e["version"] ? ` ${e["version"]}` : ""} (${e["editor"]})`),
    mcpServers: arr("mcpServers").map((m) => `${m["name"]} (${m["transport"]}${m["command"] ? `, ${m["command"]}` : ""})`),
    iocLine: ioc
      ? `${ioc.findings.length} finding(s), list ${ioc.listVersion}, checked ${ioc.checkedAt}`
      : "no result yet (run kya doctor --iocs)",
    neverMode: String((r["never"] as Record<string, unknown> | undefined)?.["mode"] ?? "unknown"),
    // Before the first IoC scan the preview has no ioc part; that is shown on its own line, not as a fault.
    violations: violations.filter((v) => v.path !== "ioc"),
    policy: state.policy ? (state.policy.enabled ? "enabled" : "disabled") : "not checked yet",
    lastSentAt: state.lastSentAt,
  };
}

/**
 * Local toggle from the live server or the dashboard. Turning on refuses when the preview
 * does not pass the local check (nothing would be sent, so nothing is switched on).
 */
export function setPostureShare(
  env: NodeJS.ProcessEnv,
  share: boolean,
): { ok: true; share: boolean } | { ok: false; error: string } {
  if (share) {
    // The ioc part is absent until a first scan; the send scans, so it does not block turning on.
    const violations = previewPosture(env).violations.filter((v) => v.path !== "ioc");
    if (violations.length > 0) return { ok: false, error: "the report fails the local check; nothing was switched on" };
  }
  writePostureConfig(env, { share });
  return { ok: true, share };
}
