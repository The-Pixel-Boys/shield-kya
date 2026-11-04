/**
 * Posture sending. Order of gates, each one stops the send before any later step:
 *   1. local toggle (~/.kya/config.json posture.share === true), checked before every request;
 *   2. hosted credentials from `kya login` (remote http is refused by the credentials reader);
 *   3. workspace policy (GET .../posture/policy), cached for one day; a 403 from the report
 *      endpoint stops sending until the next policy check;
 *   4. the report is built, checked by the validator, and only then posted (5 s timeout,
 *      no redirects, https or loopback http only).
 * Fail open for the user: every failure returns an outcome, never throws, never blocks a hook.
 */
import { hostname, userInfo } from "node:os";
import { readCredentials } from "../login/credentials.js";
import { validateConsoleUrl } from "../login/device-flow.js";
import { applyPlaneAuth } from "../client.js";
import { kyaHome } from "../config.js";
import { readIocResult, type IocResult } from "../ioc/result.js";
import { loadIocList } from "../ioc/list.js";
import { runIocScan } from "../ioc/scan.js";
import { collectReport } from "./collect.js";
import { checkReport, forbiddenContext, type Violation } from "./validate.js";
import {
  deviceId,
  effectiveLabel,
  readPostureState,
  shareOn,
  writePostureState,
} from "./store.js";

export const POLICY_PATH = "/api/v1/kya/posture/policy";
export const REPORT_PATH = "/api/v1/kya/posture";
export const POLICY_TTL_MS = 24 * 60 * 60_000;
export const REQUEST_TIMEOUT_MS = 5_000;

export type PostureOutcome =
  | "off"
  | "no-credentials"
  | "policy-disabled"
  | "policy-unavailable"
  | "invalid"
  | "sent"
  | "rejected"
  | "failed";

export interface PostureResult {
  readonly outcome: PostureOutcome;
  readonly detail?: string;
}

export interface BuiltReport {
  readonly report: Record<string, unknown>;
  readonly violations: readonly Violation[];
}

function identity(): { user: string; host: string } {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    /* no user database entry: nothing to hide */
  }
  return { user, host: hostname() };
}

/** Read-only views pass create=false: they never write the device id file. */
const PREVIEW_ID = "00000000-0000-4000-8000-000000000000";

function build(env: NodeJS.ProcessEnv, ioc: IocResult | undefined, now: Date, create: boolean): BuiltReport {
  const id = deviceId(env, create) ?? PREVIEW_ID;
  const { user, host } = identity();
  const report = collectReport({
    deviceId: id,
    label: effectiveLabel(env, id),
    now,
    home: kyaHome(env),
    pathDirs: (env["PATH"] ?? "").split(process.platform === "win32" ? ";" : ":").filter((p) => p.trim() !== ""),
    platform: process.platform,
    arch: process.arch,
    ioc,
    iocExtensionIds: loadIocList()
      .iocs.flatMap((i) => i.checks.filter((c) => c.kind === "extension").map((c) => c.id ?? ""))
      .filter((s) => s !== ""),
    hosted: readCredentials(env) !== undefined,
  });
  const violations = checkReport(report, forbiddenContext(env, user, host, kyaHome(env)));
  return { report, violations };
}

/** Full report for `posture send --dry-run`, `posture on` and the detached send. Scans once if no result is stored. */
export async function buildPostureReport(env: NodeJS.ProcessEnv, now: Date = new Date()): Promise<BuiltReport> {
  const ioc = readIocResult(env) ?? (await runIocScan({ env, now }));
  return build(env, ioc, now, true);
}

/** Sync preview for the dashboards: no scan, no network. The IoC part is absent until a result is stored. */
export function previewPosture(env: NodeJS.ProcessEnv, now: Date = new Date()): BuiltReport {
  return build(env, readIocResult(env), now, false);
}

interface Json {
  readonly status: number;
  readonly json: unknown;
}

async function request(
  method: "GET" | "POST",
  url: URL,
  apiKey: string,
  body: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Json> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  applyPlaneAuth(headers, apiKey);
  try {
    const res = await fetchImpl(url.toString(), {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: "error",
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

/** One send attempt. Never throws. Returns what happened, with a detail that carries no user data. */
export async function runPostureSend(
  env: NodeJS.ProcessEnv,
  deps: { readonly fetch?: typeof fetch; readonly now?: Date } = {},
): Promise<PostureResult> {
  try {
    if (!shareOn(env)) return { outcome: "off" };
    const creds = readCredentials(env);
    if (creds === undefined) return { outcome: "no-credentials", detail: "no hosted login (kya login)" };
    const base = validateConsoleUrl(creds.baseUrl);
    const fetchImpl = deps.fetch ?? fetch;
    const now = deps.now ?? new Date();
    let state = readPostureState(env);

    const fresh =
      state.policy !== undefined &&
      now.getTime() - Date.parse(state.policy.checkedAt) < POLICY_TTL_MS &&
      Date.parse(state.policy.checkedAt) <= now.getTime();
    let enabled: boolean;
    if (fresh && state.policy) {
      enabled = state.policy.enabled;
    } else {
      let res: Json;
      try {
        res = await request("GET", new URL(POLICY_PATH, base), creds.apiKey, undefined, fetchImpl);
      } catch {
        return { outcome: "policy-unavailable", detail: "network" };
      }
      if (res.status !== 200 || !isObj(res.json) || typeof res.json["enabled"] !== "boolean") {
        return { outcome: "policy-unavailable", detail: `status ${res.status}` };
      }
      enabled = res.json["enabled"];
      writePostureState(env, { ...state, policy: { enabled, checkedAt: now.toISOString() } });
    }
    if (!enabled) return { outcome: "policy-disabled" };
    // The toggle may have been switched off while the policy request was in flight.
    if (!shareOn(env)) return { outcome: "off" };

    const { report, violations } = await buildPostureReport(env, now);
    if (violations.length > 0) {
      return { outcome: "invalid", detail: violations.map((v) => `${v.path || "report"}: ${v.reason}`).join("; ") };
    }
    let res: Json;
    try {
      res = await request("POST", new URL(REPORT_PATH, base), creds.apiKey, JSON.stringify(report), fetchImpl);
    } catch {
      return { outcome: "failed", detail: "network" };
    }
    if (res.status === 403) {
      // Workspace toggle is off: stop until the next daily policy check.
      state = readPostureState(env);
      writePostureState(env, { ...state, policy: { enabled: false, checkedAt: now.toISOString() } });
      return { outcome: "rejected", detail: "workspace has posture sharing off" };
    }
    if (res.status >= 200 && res.status < 300) {
      state = readPostureState(env);
      writePostureState(env, { ...state, lastSentAt: now.toISOString() });
      return { outcome: "sent" };
    }
    return { outcome: "failed", detail: `status ${res.status}` };
  } catch {
    return { outcome: "failed", detail: "internal" };
  }
}

