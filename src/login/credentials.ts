/**
 * Hosted login credentials for `kya login`: one JSON file in the user-level KYA dir
 * (`<KYA_HOME|home>/.kya/hosted-credentials.json`), mode 0600, written crash-safe.
 *
 * The file holds a full-workspace hosted API key (no narrower scope exists yet). It is never printed, never sent to telemetry
 * and never read by the hosted hook path (that path uses its own --plane-config file).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { atomicWriteSecretSync } from "../fs-atomic.js";
import { validateConsoleUrl } from "./device-flow.js";

export interface HostedCredentials {
  /** Validated origin of the hosted console, no path, query or fragment. */
  readonly baseUrl: string;
  /** The hosted API key. Never print it. */
  readonly apiKey: string;
  /** Display prefix only (safe to print). */
  readonly keyPrefix: string;
  readonly createdAt: string;
}

const KEY_RE = /^[\x21-\x7e]{8,512}$/;

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "hosted-credentials.json");
}

/** The saved credentials, or undefined when missing, unreadable or malformed. Never throws. */
export function readCredentials(env: NodeJS.ProcessEnv = process.env): HostedCredentials | undefined {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(env), "utf8")) as Partial<HostedCredentials>;
    if (
      typeof raw.baseUrl === "string" &&
      typeof raw.apiKey === "string" &&
      KEY_RE.test(raw.apiKey) &&
      typeof raw.keyPrefix === "string" &&
      typeof raw.createdAt === "string"
    ) {
      // Re-validated on every read: a file edited to point at a remote http host (or anything else) is not used.
      validateConsoleUrl(raw.baseUrl);
      return { baseUrl: raw.baseUrl, apiKey: raw.apiKey, keyPrefix: raw.keyPrefix, createdAt: raw.createdAt };
    }
  } catch {
    /* missing or corrupt */
  }
  return undefined;
}

/** Write the credentials with mode 0600. Throws on I/O failure; the caller reports it. */
export function writeCredentials(creds: HostedCredentials, env: NodeJS.ProcessEnv = process.env): string {
  const path = credentialsPath(env);
  mkdirSync(globalConfigDir(env), { recursive: true });
  atomicWriteSecretSync(path, `${JSON.stringify(creds, null, 2)}\n`);
  return path;
}

/** Delete the local file. Returns whether a file was removed. Never throws. */
export function deleteCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = credentialsPath(env);
  try {
    if (!existsSync(path) && !isLink(path)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
