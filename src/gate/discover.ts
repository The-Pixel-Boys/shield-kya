/**
 * Gateway auto-discovery: scan detected host MCP configs for third-party MCP
 * servers (any entry not prefixed shield-kya/kya), normalize them into gateway
 * target candidates, and merge them into gateways.json with provenance
 * (`importedFrom`). Used by `kya start`'s gate bootstrap. Discovery never
 * invents servers; a host config that cannot be parsed is skipped silently.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { globalConfigDir } from "../config.js";
import { UsageError } from "../errors.js";
import { atomicWriteSync } from "../fs-atomic.js";
import { CONNECT_REGISTRY, connectableHosts, writeTarget } from "../commands/connect.js";
import { gatewaysPath, type GatewayServer } from "./config.js";

export interface GateCandidate {
  readonly id: string;
  readonly transport: "stdio" | "http";
  readonly cmd?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Host ids whose config carried this server. */
  readonly foundIn: readonly string[];
}

const KYA_PREFIX_RE = /^(shield-kya|kya)(-|$)/i;
const TARGET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Normalize a host's server key to the gateway target-id shape. Returns
 * undefined for keys that sanitize to nothing usable or that resolve to a
 * kya-owned id (kya/shield-kya prefixes are never third-party servers).
 */
export function sanitizeServerId(raw: string): string | undefined {
  const key = raw.trim();
  if (KYA_PREFIX_RE.test(key)) return undefined;
  const id = key
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!TARGET_ID_RE.test(id) || KYA_PREFIX_RE.test(id)) return undefined;
  return id;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

type CandidateCore = Omit<GateCandidate, "id" | "foundIn">;

/** One JSON host entry → candidate core. Unknown shapes yield undefined. */
function candidateFromJsonEntry(entry: unknown): CandidateCore | undefined {
  if (!isPlainObject(entry)) return undefined;
  const command = entry["command"];
  if (typeof command === "string" && command.trim()) {
    const args = Array.isArray(entry["args"])
      ? entry["args"].filter((a): a is string => typeof a === "string")
      : [];
    const env = stringMap(entry["env"] ?? entry["environment"]);
    return { transport: "stdio", cmd: [command, ...args], ...(env ? { env } : {}) };
  }
  // opencode local shape: command is the full argv array.
  if (Array.isArray(command) && command.length > 0 && command.every((c) => typeof c === "string")) {
    const env = stringMap(entry["environment"] ?? entry["env"]);
    return { transport: "stdio", cmd: command as readonly string[], ...(env ? { env } : {}) };
  }
  const url =
    typeof entry["url"] === "string"
      ? entry["url"]
      : typeof entry["httpUrl"] === "string"
        ? entry["httpUrl"]
        : undefined;
  if (url && /^https?:\/\//.test(url)) {
    const headers = stringMap(entry["headers"]);
    return { transport: "http", url, ...(headers ? { headers } : {}) };
  }
  return undefined;
}

function candidatesFromJson(text: string, rootKey: string): Map<string, CandidateCore> {
  const raw = JSON.parse(text) as unknown;
  const out = new Map<string, CandidateCore>();
  if (!isPlainObject(raw)) return out;
  const servers = raw[rootKey];
  if (!isPlainObject(servers)) return out;
  for (const [key, entry] of Object.entries(servers)) {
    const core = candidateFromJsonEntry(entry);
    if (core) out.set(key, core);
  }
  return out;
}

const TOML_TABLE_RE = /^[ \t]*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\][ \t]*(?:#.*)?$/;
const TOML_ANY_HEADER_RE = /^[ \t]*\[/;

function tomlString(body: string, key: string): string | undefined {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*("(?:[^"\\\\]|\\\\.)*")`, "m");
  const m = re.exec(body);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[1]!) as unknown;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function tomlStringArray(body: string, key: string): readonly string[] | undefined {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(\\[[^\\]]*\\])`, "m");
  const m = re.exec(body);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[1]!) as unknown;
    if (Array.isArray(v) && v.every((s) => typeof s === "string")) return v as readonly string[];
  } catch {
    /* single-quoted TOML strings etc. — no args */
  }
  return undefined;
}

function tomlInlineMap(body: string, key: string): Record<string, string> | undefined {
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(\\{[^}]*\\})`, "m");
  const m = re.exec(body);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  const pair = /([A-Za-z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*")/g;
  for (let p = pair.exec(m[1]!); p; p = pair.exec(m[1]!)) {
    try {
      const v = JSON.parse(p[2]!) as unknown;
      if (typeof v === "string") out[p[1]!] = v;
    } catch {
      /* skip the pair */
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Minimal [mcp_servers.<id>] table reader for grok/codex TOML configs. */
function candidatesFromToml(text: string): Map<string, CandidateCore> {
  const out = new Map<string, CandidateCore>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = TOML_TABLE_RE.exec(lines[i]!);
    if (!header) continue;
    const key = header[1] ?? header[2] ?? header[3]!;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (TOML_ANY_HEADER_RE.test(lines[j]!)) {
        end = j;
        break;
      }
    }
    const body = lines.slice(i + 1, end).join("\n");
    const command = tomlString(body, "command");
    const url = tomlString(body, "url");
    if (command) {
      const args = tomlStringArray(body, "args") ?? [];
      const env = tomlInlineMap(body, "env");
      out.set(key, { transport: "stdio", cmd: [command, ...args], ...(env ? { env } : {}) });
    } else if (url && /^https?:\/\//.test(url)) {
      out.set(key, { transport: "http", url });
    }
    i = end - 1;
  }
  return out;
}

/**
 * Scan every connectable host's user-level MCP config for third-party
 * servers. Deduped across hosts by sanitized id (first-seen shape wins;
 * `foundIn` accumulates every host carrying the id).
 */
export function discoverGateServers(home: string): GateCandidate[] {
  const byId = new Map<string, { core: CandidateCore; foundIn: string[] }>();
  for (const hostId of connectableHosts()) {
    const spec = CONNECT_REGISTRY[hostId]!;
    if (!spec.globalPath) continue;
    const path = spec.globalPath(home);
    if (!existsSync(path)) continue;
    let entries: Map<string, CandidateCore>;
    try {
      const text = readFileSync(path, "utf8");
      entries =
        spec.shape === "grok-toml" || spec.shape === "codex-toml"
          ? candidatesFromToml(text)
          : candidatesFromJson(text, spec.rootKey);
    } catch {
      continue; // unparseable host config — skip the host, keep the rest
    }
    for (const [rawKey, core] of entries) {
      const id = sanitizeServerId(rawKey);
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) {
        if (!existing.foundIn.includes(hostId)) existing.foundIn.push(hostId);
      } else {
        byId.set(id, { core, foundIn: [hostId] });
      }
    }
  }
  return [...byId.entries()].map(([id, v]) => ({ id, ...v.core, foundIn: v.foundIn }));
}

export interface GateImportResult {
  /** Entries appended to gateways.json this call. */
  readonly imported: readonly GatewayServer[];
  readonly path: string;
}

/**
 * Merge discovered candidates into gateways.json `servers`. Hand-configured
 * entries and other top-level keys (recipes) are preserved; ids already
 * present are skipped — an already-imported entry only unions new source
 * hosts into its `importedFrom`, a hand-configured entry is left byte-identical.
 */
export function importGateCandidates(
  candidates: readonly GateCandidate[],
  env: NodeJS.ProcessEnv = process.env,
): GateImportResult {
  const path = gatewaysPath(env);
  if (candidates.length === 0) return { imported: [], path };
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new UsageError(`${path} is not valid JSON — fix it by hand, then re-run kya start`);
    }
    if (!isPlainObject(parsed)) {
      throw new UsageError(`${path} must be a JSON object — fix it by hand, then re-run kya start`);
    }
    raw = parsed;
  }
  if (raw["servers"] !== undefined && !Array.isArray(raw["servers"])) {
    throw new UsageError(`${path}: "servers" must be an array — fix it by hand, then re-run kya start`);
  }
  const servers = Array.isArray(raw["servers"]) ? [...raw["servers"]] : [];
  const imported: GatewayServer[] = [];
  let changed = false;
  for (const c of candidates) {
    const idx = servers.findIndex((s) => isPlainObject(s) && s["id"] === c.id);
    if (idx !== -1) {
      const entry = servers[idx] as Record<string, unknown>;
      if (Array.isArray(entry["importedFrom"])) {
        const have = new Set(entry["importedFrom"].filter((h): h is string => typeof h === "string"));
        const merged = [...have];
        for (const h of c.foundIn) if (!have.has(h)) merged.push(h);
        if (merged.length !== have.size) {
          servers[idx] = { ...entry, importedFrom: merged };
          changed = true;
        }
      }
      continue;
    }
    const entry: Record<string, unknown> = { id: c.id, transport: c.transport };
    if (c.transport === "stdio" && c.cmd) entry["cmd"] = [...c.cmd];
    if (c.transport === "stdio" && c.env) entry["env"] = { ...c.env };
    if (c.transport === "http" && c.url) entry["url"] = c.url;
    if (c.transport === "http" && c.headers) entry["headers"] = { ...c.headers };
    entry["importedFrom"] = [...c.foundIn];
    servers.push(entry);
    imported.push(entry as unknown as GatewayServer);
    changed = true;
  }
  if (changed) {
    mkdirSync(globalConfigDir(env), { recursive: true });
    atomicWriteSync(path, `${JSON.stringify({ ...raw, servers }, null, 2)}\n`);
  }
  return { imported, path };
}

export interface HostEntryRemoval {
  readonly path: string;
  /** Full pre-edit copy under <global .kya>/backups. */
  readonly backup: string;
  readonly removed: readonly string[];
}

function backupHostConfig(target: string, host: string, env: NodeJS.ProcessEnv, ts?: string): string {
  const dir = join(globalConfigDir(env), "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = (ts ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const ext = extname(target) || ".conf";
  let candidate = join(dir, `${host}-${stamp}${ext}`);
  for (let n = 2; existsSync(candidate); n++) {
    candidate = join(dir, `${host}-${stamp}-${n}${ext}`);
  }
  copyFileSync(target, candidate);
  return candidate;
}

function removeTomlTables(text: string, ids: readonly string[]): { text: string; removed: string[] } {
  const lines = text.split("\n");
  const drop = new Set(ids);
  const removed: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = TOML_TABLE_RE.exec(lines[i]!);
    const key = header ? (header[1] ?? header[2] ?? header[3]!) : undefined;
    if (key && !drop.has(sanitizeServerId(key) ?? "")) {
      kept.push(lines[i]!);
      continue;
    }
    if (key) {
      if (!removed.includes(key)) removed.push(key);
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (TOML_ANY_HEADER_RE.test(lines[j]!)) {
          end = j;
          break;
        }
      }
      i = end - 1;
      continue;
    }
    kept.push(lines[i]!);
  }
  return { text: kept.join("\n"), removed };
}

/**
 * Remove the given server ids from a host's user-level config, after copying
 * the full original under <global .kya>/backups. Only the listed ids are
 * touched — shield-kya entries and every other setting survive. Returns
 * undefined (and writes nothing) when the file is missing, unparseable, or
 * carries none of the ids.
 */
export function removeHostServerEntries(input: {
  readonly host: string;
  readonly ids: readonly string[];
  readonly home: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test hook: backup timestamp label. */
  readonly ts?: string;
}): HostEntryRemoval | undefined {
  const env = input.env ?? process.env;
  const spec = CONNECT_REGISTRY[input.host];
  if (!spec?.globalPath) return undefined;
  const path = spec.globalPath(input.home);
  if (!existsSync(path)) return undefined;
  let target: string;
  try {
    target = writeTarget(path);
  } catch {
    return undefined;
  }
  const toml = spec.shape === "grok-toml" || spec.shape === "codex-toml";
  const text = readFileSync(target, "utf8");
  let next: string;
  let removed: string[];
  if (toml) {
    const r = removeTomlTables(text, input.ids);
    next = r.text;
    removed = r.removed;
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!isPlainObject(raw)) return undefined;
    const servers: unknown = raw[spec.rootKey];
    if (!isPlainObject(servers)) return undefined;
    const drop = new Set(input.ids);
    removed = Object.keys(servers).filter((key) => drop.has(sanitizeServerId(key) ?? ""));
    if (removed.length === 0) return undefined;
    const rest = { ...servers };
    for (const key of removed) delete rest[key];
    raw[spec.rootKey] = rest;
    next = `${JSON.stringify(raw, null, 2)}\n`;
  }
  if (removed.length === 0) return undefined;
  const backup = backupHostConfig(target, input.host, env, input.ts);
  atomicWriteSync(target, next);
  return { path: target, backup, removed };
}
