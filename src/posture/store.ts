/**
 * Local state for the developer posture client: the sharing toggle and label (both in
 * ~/.kya/config.json, key `posture`), the random device id (~/.kya/device-id, 0600) and the
 * policy cache (~/.kya/posture-state.json). Reads fail closed: a missing or damaged file means
 * "sharing off", never an error in the caller. Nothing here touches the network.
 */
import { randomUUID, createHash } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { atomicWriteSecretSync, atomicWriteSync } from "../fs-atomic.js";

export interface PostureConfig {
  /** Local toggle. Default false: nothing is sent until `kya posture on`. */
  readonly share?: boolean;
  /** User-chosen label. Absent: the default label is derived from the device id. */
  readonly label?: string;
}

export interface PolicyCache {
  readonly enabled: boolean;
  /** When the hosted policy was last read (ISO). Re-read at most once a day. */
  readonly checkedAt: string;
}

export interface PostureState {
  readonly policy?: PolicyCache;
  readonly lastSentAt?: string;
}

const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const LABEL_MAX = 64;

const configPath = (env: NodeJS.ProcessEnv): string => join(globalConfigDir(env), "config.json");
export const devicePath = (env: NodeJS.ProcessEnv): string => join(globalConfigDir(env), "device-id");
export const postureStatePath = (env: NodeJS.ProcessEnv): string => join(globalConfigDir(env), "posture-state.json");
export const postureStampPath = (env: NodeJS.ProcessEnv): string => join(globalConfigDir(env), "posture-send-stamp");

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readPostureConfig(env: NodeJS.ProcessEnv): PostureConfig {
  const posture = readJsonObject(configPath(env))["posture"];
  if (posture === null || typeof posture !== "object") return {};
  const p = posture as Record<string, unknown>;
  return {
    share: p["share"] === true,
    label: typeof p["label"] === "string" ? p["label"] : undefined,
  };
}

/** Sharing is on only when the file says exactly `true`. */
export function shareOn(env: NodeJS.ProcessEnv): boolean {
  return readPostureConfig(env).share === true;
}

/** Merges into ~/.kya/config.json. Other keys (for example `ioc`) are kept as they are. */
export function writePostureConfig(env: NodeJS.ProcessEnv, patch: PostureConfig): void {
  const dir = globalConfigDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = readJsonObject(configPath(env));
  const merged = { ...readPostureConfig(env), ...patch };
  const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  file["posture"] = clean;
  atomicWriteSync(configPath(env), `${JSON.stringify(file, null, 2)}\n`);
}

/** The random device id. Created on first use with mode 0600. Not hardware based. */
export function deviceId(env: NodeJS.ProcessEnv, create: boolean): string | undefined {
  const path = devicePath(env);
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (DEVICE_ID_RE.test(raw)) return raw;
  } catch {
    /* missing: create below */
  }
  if (!create) return undefined;
  mkdirSync(globalConfigDir(env), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  atomicWriteSecretSync(path, `${id}\n`);
  return id;
}

/** Default label: first 8 hex of sha256(hostname + deviceId). The hostname itself is never sent. */
export function defaultLabel(id: string, host: string = hostname()): string {
  return createHash("sha256").update(host + id).digest("hex").slice(0, 8);
}

export function effectiveLabel(env: NodeJS.ProcessEnv, id: string): string {
  return readPostureConfig(env).label ?? defaultLabel(id);
}

export function readPostureState(env: NodeJS.ProcessEnv): PostureState {
  const raw = readJsonObject(postureStatePath(env));
  const out: { policy?: PolicyCache; lastSentAt?: string } = {};
  const p = raw["policy"];
  if (p && typeof p === "object") {
    const pc = p as Record<string, unknown>;
    if (typeof pc["enabled"] === "boolean" && typeof pc["checkedAt"] === "string") {
      out.policy = { enabled: pc["enabled"], checkedAt: pc["checkedAt"] };
    }
  }
  if (typeof raw["lastSentAt"] === "string") out.lastSentAt = raw["lastSentAt"];
  return out;
}

export function writePostureState(env: NodeJS.ProcessEnv, state: PostureState): void {
  mkdirSync(globalConfigDir(env), { recursive: true, mode: 0o700 });
  atomicWriteSync(postureStatePath(env), `${JSON.stringify(state, null, 2)}\n`);
}

export function hasDeviceFile(env: NodeJS.ProcessEnv): boolean {
  return existsSync(devicePath(env));
}

/** Label rules: 1 to 64 characters, no control characters, and nothing the local check forbids (user, host, paths). */
export function labelProblem(label: string, problemOf: (v: string) => string | undefined): string | undefined {
  if (label.length < 1 || label.length > LABEL_MAX) return `label must be 1 to ${LABEL_MAX} characters`;
  if (/[\u0000-\u001f\u007f]/.test(label)) return "label must not contain control characters";
  const why = problemOf(label);
  return why === undefined ? undefined : `label must not contain: ${why}`;
}
