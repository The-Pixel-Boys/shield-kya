/**
 * Stable, hashed id of this install for trail rows (`deviceId`). The id is sha256 of a random per-install salt
 * and a constant. It never contains the host name, user name, MAC address or any path.
 */
import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "./config.js";

const SALT_FILE = "device-salt";
const CONSTANT = "kya-device-id-v1";
const SALT_HEX = /^[0-9a-f]{64}$/;
/** Per global config dir, so one process can serve more than one KYA_HOME. */
const cache = new Map<string, string | undefined>();

function readSalt(path: string): string | undefined {
  try {
    // A salt that other users can read (or that another user owns) cannot keep session ids private: no id.
    const st = lstatSync(path);
    if (!st.isFile()) return undefined;
    if (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid()))) return undefined;
    const value = readFileSync(path, "utf8").trim();
    return SALT_HEX.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Read the salt, or create it once. Creation is a no-overwrite link, so a lost race keeps the winner's salt. */
function loadSalt(dir: string): string | undefined {
  const path = join(dir, SALT_FILE);
  const existing = readSalt(path);
  if (existing !== undefined) return existing;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    linkSync(tmp, path);
  } catch {
    /* lost the race, or the dir is not writable: read whatever is there */
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file already gone */
    }
  }
  return readSalt(path);
}

/** The per-install salt (64 hex) that `deviceId` hashes, or undefined when it cannot be read or written. Never throws. */
export function installSalt(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return loadSalt(globalConfigDir(env));
  } catch {
    return undefined;
  }
}

/** First 16 hex chars of sha256(salt|constant). Undefined when the salt cannot be read or written. Never throws. */
export function deviceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const dir = globalConfigDir(env);
    if (cache.has(dir)) return cache.get(dir);
    const salt = loadSalt(dir);
    const id = salt === undefined ? undefined : createHash("sha256").update(`${salt}|${CONSTANT}`, "utf8").digest("hex").slice(0, 16);
    cache.set(dir, id);
    return id;
  } catch {
    return undefined;
  }
}
