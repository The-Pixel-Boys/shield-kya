/**
 * Gate in front of every posture send. The rules are the hosted validator's rules (shield-agent
 * core DevicePostureValidator: exact key sets, enums, caps, forbidden path and e-mail fragments)
 * plus local checks the hosted side cannot make: the user name, the host name, the home directory,
 * environment names and values, IP addresses and absolute paths of any kind. Pure logic.
 *
 * A violation names the field path only, never the value. The caller sends nothing when the
 * list of violations is not empty (fail closed).
 */

export const MAX_REPORT_BYTES = 64 * 1024;
const MAX_HOSTS = 32;
const MAX_EXTENSIONS = 200;
const MAX_MCP = 100;
const MAX_FINDINGS = 50;

const TOP = ["schema", "reportedAt", "kyaVersion", "deviceId", "deviceLabel", "os", "arch", "hosts", "extensions", "mcpServers", "ioc", "never"];
const HOST_KEYS = ["id", "version", "kyaHook"];
const EXT_KEYS = ["id", "version", "editor"];
const MCP_KEYS = ["name", "transport", "command"];
const IOC_KEYS = ["listVersion", "checkedAt", "skipped", "findings"];
const FINDING_KEYS = ["ioc", "check", "severity", "evidence", "hint"];
const NEVER_KEYS = ["listActive", "mode"];

const OS = ["darwin", "linux", "win32"];
const ARCH = ["arm64", "x64"];
const EDITORS = ["vscode", "cursor", "windsurf", "vscodium"];
const TRANSPORTS = ["stdio", "http"];
const NEVER_MODES = ["advisory", "strict", "hosted"];
const CHECKS = ["extension", "ssh_authorized_keys_comment", "net_indicator", "file_exists"];
const SEVERITIES = ["critical", "high", "medium"];

const DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/;
const HOST_ID = /^[a-z0-9-]{1,40}$/;
const EXT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6 = /::|(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}/;
/** Absolute POSIX path: a slash that starts the value or follows a separator, then a name. */
const POSIX_ABS = /(^|[\s"'=(,:])\/[A-Za-z0-9._~-]/;
const WIN_ABS = /[A-Za-z]:\\|\\\\|\\Users\\/;
/** Fragments the hosted validator refuses (kept in step with it), plus file URLs. */
const HOSTED_FRAGMENTS = ["/Users/", "/home/", "/root/", "/private/", "\\Users\\", "file://"];

/** What the local check must keep out of a report. Built from the live environment. */
export interface ForbiddenContext {
  /** Case-insensitive substrings: user name, host name, home directory, secret-looking env values. */
  readonly substrings: readonly string[];
  /** Short user or host names (under 4 characters), matched as whole words only. */
  readonly words: readonly string[];
  /** Exact tokens: environment variable names. */
  readonly tokens: readonly string[];
}

export function forbiddenContext(env: NodeJS.ProcessEnv, user: string, host: string, home: string): ForbiddenContext {
  const substrings = [user, host, home].filter((s) => s.length >= 4);
  const words = [user, host].filter((s) => s.length > 0 && s.length < 4);
  for (const v of Object.values(env)) {
    // Secret-looking values only (long, with a digit). Short or plain words would block honest reports.
    if (typeof v === "string" && v.length >= 12 && /\d/.test(v)) substrings.push(v);
  }
  const tokens = Object.keys(env).filter((k) => /^[A-Z][A-Z0-9_]{3,}$/.test(k));
  return { substrings, words, tokens };
}

export interface Violation {
  readonly path: string;
  readonly reason: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Every violation found. Empty list = the report may be sent. */
export function checkReport(report: unknown, ctx: ForbiddenContext): Violation[] {
  const out: Violation[] = [];
  const bad = (path: string, reason = "invalid field"): void => {
    out.push({ path, reason });
  };
  if (!isObj(report)) return [{ path: "", reason: "report must be an object" }];
  const top = report;
  for (const k of Object.keys(top)) if (!TOP.includes(k)) bad(k, "unknown field");
  for (const k of TOP) if (!(k in top)) bad(k, "missing field");

  const keysOf = (node: unknown, allowed: string[], path: string): node is Obj => {
    if (!isObj(node)) {
      bad(path, "must be an object");
      return false;
    }
    for (const k of Object.keys(node)) if (!allowed.includes(k)) bad(`${path}.${k}`, "unknown field");
    return true;
  };
  const str = (node: Obj, key: string, min: number, max: number, path: string): string | undefined => {
    const v = node[key];
    if (typeof v !== "string") return bad(path), undefined;
    const len = [...v].length;
    if (len < min || len > max) return bad(path), undefined;
    return v;
  };
  const nullableStr = (node: Obj, key: string, max: number, path: string): void => {
    const v = node[key];
    if (v === null || v === undefined) return;
    if (typeof v !== "string" || v.length > max) bad(path);
  };
  const oneOf = (node: Obj, key: string, allowed: string[], path: string): void => {
    const v = node[key];
    if (typeof v !== "string" || !allowed.includes(v)) bad(path);
  };
  const isoTime = (node: Obj, key: string, path: string): void => {
    const v = node[key];
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v) || Number.isNaN(Date.parse(v))) bad(path);
  };
  const list = (node: Obj, key: string, max: number, path: string): unknown[] => {
    const v = node[key];
    if (!Array.isArray(v) || v.length > max) {
      bad(path);
      return [];
    }
    return v;
  };

  if (top["schema"] !== 1) bad("schema");
  isoTime(top, "reportedAt", "reportedAt");
  str(top, "kyaVersion", 1, 32, "kyaVersion");
  const id = str(top, "deviceId", 8, 64, "deviceId");
  if (id !== undefined && !DEVICE_ID.test(id)) bad("deviceId");
  const label = str(top, "deviceLabel", 1, 64, "deviceLabel");
  if (label !== undefined && /[\u0000-\u001f\u007f]/.test(label)) bad("deviceLabel");
  oneOf(top, "os", OS, "os");
  oneOf(top, "arch", ARCH, "arch");

  for (const [i, h] of list(top, "hosts", MAX_HOSTS, "hosts").entries()) {
    const p = `hosts[${i}]`;
    if (!keysOf(h, HOST_KEYS, p)) continue;
    const hid = str(h, "id", 1, 40, `${p}.id`);
    if (hid !== undefined && !HOST_ID.test(hid)) bad(`${p}.id`);
    nullableStr(h, "version", 32, `${p}.version`);
    if (typeof h["kyaHook"] !== "boolean") bad(`${p}.kyaHook`);
  }
  for (const [i, e] of list(top, "extensions", MAX_EXTENSIONS, "extensions").entries()) {
    const p = `extensions[${i}]`;
    if (!keysOf(e, EXT_KEYS, p)) continue;
    const eid = str(e, "id", 1, 128, `${p}.id`);
    if (eid !== undefined && !EXT_ID.test(eid)) bad(`${p}.id`);
    nullableStr(e, "version", 32, `${p}.version`);
    oneOf(e, "editor", EDITORS, `${p}.editor`);
  }
  for (const [i, m] of list(top, "mcpServers", MAX_MCP, "mcpServers").entries()) {
    const p = `mcpServers[${i}]`;
    if (!keysOf(m, MCP_KEYS, p)) continue;
    str(m, "name", 1, 128, `${p}.name`);
    oneOf(m, "transport", TRANSPORTS, `${p}.transport`);
    const cmd = m["command"];
    if (cmd !== null && cmd !== undefined && (typeof cmd !== "string" || cmd.length > 128 || cmd.includes("/") || cmd.includes("\\"))) {
      bad(`${p}.command`);
    }
  }
  if (keysOf(top["ioc"], IOC_KEYS, "ioc")) {
    const ioc = top["ioc"] as Obj;
    str(ioc, "listVersion", 1, 32, "ioc.listVersion");
    isoTime(ioc, "checkedAt", "ioc.checkedAt");
    const sk = ioc["skipped"];
    if (typeof sk !== "number" || !Number.isInteger(sk) || sk < 0 || sk > 100000) bad("ioc.skipped");
    for (const [i, f] of list(ioc, "findings", MAX_FINDINGS, "ioc.findings").entries()) {
      const p = `ioc.findings[${i}]`;
      if (!keysOf(f, FINDING_KEYS, p)) continue;
      str(f, "ioc", 1, 96, `${p}.ioc`);
      oneOf(f, "check", CHECKS, `${p}.check`);
      oneOf(f, "severity", SEVERITIES, `${p}.severity`);
      str(f, "evidence", 1, 512, `${p}.evidence`);
      str(f, "hint", 1, 300, `${p}.hint`);
    }
  }
  if (keysOf(top["never"], NEVER_KEYS, "never")) {
    const n = top["never"] as Obj;
    if (typeof n["listActive"] !== "boolean") bad("never.listActive");
    oneOf(n, "mode", NEVER_MODES, "never.mode");
  }

  // Forbidden content, every string value at any depth (keys are checked above).
  const scan = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      const reason = forbiddenReason(v, ctx, path);
      if (reason) bad(path, reason);
    } else if (Array.isArray(v)) {
      v.forEach((c, i) => scan(c, `${path}[${i}]`));
    } else if (isObj(v)) {
      for (const [k, c] of Object.entries(v)) scan(c, path ? `${path}.${k}` : k);
    }
  };
  scan(top, "");

  const bytes = new TextEncoder().encode(JSON.stringify(report)).length;
  if (bytes > MAX_REPORT_BYTES) bad("report", "larger than 64 KB");
  return out;
}

/**
 * Why one string is forbidden, or undefined. Never returns the string itself. `path` is the field
 * path, used for one rule: a short user name is matched as a word, except inside the hint text,
 * which comes from the shipped IoC list (a user named "it" must not block "it could read").
 */
export function forbiddenReason(v: string, ctx: ForbiddenContext, path = ""): string | undefined {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return "control character";
  if (HOSTED_FRAGMENTS.some((f) => v.includes(f))) return "forbidden path";
  if (POSIX_ABS.test(v) || WIN_ABS.test(v)) return "absolute path";
  if (EMAIL.test(v)) return "e-mail address";
  if (IPV4.test(v) || IPV6.test(v)) return "IP address";
  const lower = v.toLowerCase();
  for (const s of ctx.substrings) {
    if (lower.includes(s.toLowerCase())) return "user, host, home or environment value";
  }
  for (const w of path.endsWith(".hint") ? [] : ctx.words) {
    if (new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`, "i").test(v)) {
      return "user or host name";
    }
  }
  for (const t of ctx.tokens) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${t}($|[^A-Za-z0-9_])`).test(v)) return "environment variable name";
  }
  return undefined;
}
