/**
 * OAuth 2.0 device authorization grant (RFC 8628) against the hosted console, for `kya login`.
 *
 * Endpoints (hosted side: web device-login controller, behind a feature flag):
 *   POST {base}/api/v1/kya/device/code   {"client":"kya-cli","version":"x"}  -> device_code, user_code, ...
 *   POST {base}/api/v1/kya/device/token  {"device_code":"..."}              -> 200 access_token | 400 error
 * A 404 on either route means the feature is off on that server.
 *
 * Fails closed for login itself: any unknown answer aborts with a LoginError and nothing is stored.
 * Nothing here runs in the OSS hook or evaluate path.
 */
import { isLoopbackUrl } from "../config.js";

export type LoginErrorCode =
  | "LOGIN_UNAVAILABLE"
  | "LOGIN_NETWORK"
  | "LOGIN_WRONG_STATE"
  | "LOGIN_EXPIRED"
  | "LOGIN_DENIED"
  | "LOGIN_CAP_REACHED"
  | "LOGIN_RATE_LIMITED"
  | "LOGIN_BAD_URL";

/** A login failure. `message` is fixed text chosen here, never server output or key material. */
export class LoginError extends Error {
  constructor(
    readonly code: LoginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSec: number;
  readonly intervalSec: number;
}

export interface IssuedToken {
  readonly apiKey: string;
  readonly keyPrefix: string;
}

export interface DeviceFlowDeps {
  readonly clientVersion: string;
  readonly fetch?: typeof fetch;
  /** Injected in tests so slow_down and expiry run without real waits. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Per-request timeout. A slower answer counts as a transient failure. */
  readonly requestTimeoutMs?: number;
}

export const DEVICE_CODE_PATH = "/api/v1/kya/device/code";
export const DEVICE_TOKEN_PATH = "/api/v1/kya/device/token";
/** RFC 8628 section 3.5: slow_down adds 5 seconds to the polling interval. */
const SLOW_DOWN_STEP_SEC = 5;
const MAX_INTERVAL_SEC = 60;
/** Consecutive transient failures (network, timeout, 5xx) before the login gives up. */
export const MAX_TRANSIENT_FAILURES = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEVICE_CODE_RE = /^[\x21-\x7e]{16,512}$/;
const USER_CODE_RE = /^[A-Za-z0-9-]{4,32}$/;
const KEY_RE = /^[\x21-\x7e]{8,512}$/;

/**
 * Validate the console origin. https only, or loopback http (tests and local dev).
 * No credentials, query or fragment. Returns the parsed URL (origin only is used).
 */
export function validateConsoleUrl(raw: string): URL {
  const bad = (why: string): never => {
    throw new LoginError("LOGIN_BAD_URL", `hosted console URL ${why}`);
  };
  if (!raw || /[^\x21-\x7e]/.test(raw)) bad("must be a non-empty ASCII URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("is not a valid URL");
  }
  if (url.username || url.password) bad("must not carry credentials");
  if (url.search || url.hash) bad("must not carry a query or fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackUrl(raw))) {
    bad("must be https (http is allowed for loopback only)");
  }
  return url;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One JSON POST. Returns the status and parsed body (undefined when not JSON). Throws on network or timeout. */
async function postJson(
  url: string,
  body: unknown,
  deps: DeviceFlowDeps,
): Promise<{ status: number; json: unknown }> {
  const doFetch = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
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

/** Step 1: ask the server for a device and user code. */
export async function requestDeviceCode(base: URL, deps: DeviceFlowDeps): Promise<DeviceCode> {
  let res: { status: number; json: unknown };
  try {
    res = await postJson(new URL(DEVICE_CODE_PATH, base).toString(), { client: "kya-cli", version: deps.clientVersion }, deps);
  } catch {
    throw new LoginError("LOGIN_NETWORK", "could not reach the hosted console; nothing was saved");
  }
  if (res.status === 404) {
    throw new LoginError("LOGIN_UNAVAILABLE", "hosted login is not available on this server; nothing was saved");
  }
  if (res.status === 429) {
    throw new LoginError("LOGIN_RATE_LIMITED", "too many login starts from this network; wait a minute, then run kya login again");
  }
  if (res.status !== 200 || !isObject(res.json)) {
    throw new LoginError("LOGIN_WRONG_STATE", "the hosted console sent an unexpected answer; nothing was saved");
  }
  const o = res.json;
  const deviceCode = typeof o.device_code === "string" ? o.device_code : "";
  const userCode = typeof o.user_code === "string" ? o.user_code : "";
  const uri = typeof o.verification_uri === "string" ? o.verification_uri : "";
  const expires = typeof o.expires_in === "number" && Number.isInteger(o.expires_in) ? o.expires_in : 0;
  const interval =
    o.interval === undefined ? 5 : typeof o.interval === "number" && Number.isInteger(o.interval) ? o.interval : 0;
  let verification: URL | undefined;
  try {
    verification = new URL(uri);
  } catch {
    verification = undefined;
  }
  // The verification page must live on the same origin the user chose: never open a foreign page.
  const sameOrigin = verification !== undefined && verification.origin === base.origin;
  if (
    !DEVICE_CODE_RE.test(deviceCode) ||
    !USER_CODE_RE.test(userCode) ||
    !sameOrigin ||
    expires < 1 ||
    expires > 3600 ||
    interval < 1 ||
    interval > MAX_INTERVAL_SEC
  ) {
    throw new LoginError("LOGIN_WRONG_STATE", "the hosted console sent an unexpected answer; nothing was saved");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: verification!.toString(),
    expiresInSec: expires,
    intervalSec: interval,
  };
}

/**
 * Step 2: poll until the user approves, denies or the code expires.
 * Transient failures (network, timeout, 5xx) are retried up to MAX_TRANSIENT_FAILURES in a row.
 * An unknown answer aborts at once. Only a validated token is returned.
 */
export async function pollForToken(base: URL, code: DeviceCode, deps: DeviceFlowDeps): Promise<IssuedToken> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + code.expiresInSec * 1000;
  const tokenUrl = new URL(DEVICE_TOKEN_PATH, base).toString();
  let interval = code.intervalSec;
  let transient = 0;
  const expired = () =>
    new LoginError("LOGIN_EXPIRED", "the code expired before it was approved; nothing was saved");

  for (;;) {
    if (now() >= deadline) throw expired();
    await sleep(interval * 1000);
    if (now() >= deadline) throw expired();

    let res: { status: number; json: unknown };
    try {
      res = await postJson(tokenUrl, { device_code: code.deviceCode }, deps);
    } catch {
      if (++transient >= MAX_TRANSIENT_FAILURES) {
        throw new LoginError("LOGIN_NETWORK", "lost the hosted console while waiting; nothing was saved");
      }
      continue;
    }
    if (res.status === 404) {
      throw new LoginError("LOGIN_UNAVAILABLE", "hosted login is not available on this server; nothing was saved");
    }
    if (res.status >= 500) {
      if (++transient >= MAX_TRANSIENT_FAILURES) {
        throw new LoginError("LOGIN_NETWORK", "lost the hosted console while waiting; nothing was saved");
      }
      continue;
    }
    transient = 0;
    if (res.status === 200) {
      const o = isObject(res.json) ? res.json : {};
      const apiKey = typeof o.access_token === "string" ? o.access_token : "";
      if (!KEY_RE.test(apiKey)) {
        throw new LoginError("LOGIN_WRONG_STATE", "the hosted console sent an unexpected answer; nothing was saved");
      }
      const keyPrefix = typeof o.key_prefix === "string" && o.key_prefix ? o.key_prefix : apiKey.slice(0, 12);
      return { apiKey, keyPrefix };
    }
    const error = isObject(res.json) && typeof res.json.error === "string" ? res.json.error : "";
    if (res.status === 429 || error === "slow_down") {
      interval = Math.min(MAX_INTERVAL_SEC, interval + SLOW_DOWN_STEP_SEC);
      continue;
    }
    if (error === "authorization_pending") continue;
    if (error === "expired_token") throw expired();
    if (error === "access_denied") {
      throw new LoginError("LOGIN_DENIED", "the request was denied in the hosted console; nothing was saved");
    }
    if (error === "api_key.cap_reached") {
      // Approved on the console, but the workspace is at its key cap. The request stays approved on the server.
      throw new LoginError(
        "LOGIN_CAP_REACHED",
        "this workspace has the maximum number of API keys; revoke an unused key in the console, then run kya login again",
      );
    }
    throw new LoginError("LOGIN_WRONG_STATE", "the hosted console sent an unexpected answer; nothing was saved");
  }
}
