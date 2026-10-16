// Pure logic for the Shield KYA editor extension: no `vscode` import, so node:test covers it
// directly. The extension wires these into views, commands and the status bar.
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync, accessSync, constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

// ---------- trail rows ----------

export type Verdict = "ALLOW" | "REVIEW" | "HOLD" | "DENY" | "OTHER";

export interface FeedRow {
  readonly ts: string;
  readonly toolId: string;
  readonly verdict: Verdict;
  readonly rawVerdict: string;
  readonly reasonCode: string;
  readonly mode: string;
  readonly neverEvent: boolean;
  readonly shadow: boolean;
  readonly product?: string;
  readonly project?: string;
  readonly importedFrom?: string;
  /** Re-redacted and clipped here, whatever the trail holds. */
  readonly summary?: string;
  readonly targetPath?: string;
  readonly diffPreview?: string;
}

const MODES = new Set(["observe", "hold", "offline"]);
const FIELD_MAX = 200;
const PREVIEW_LINES = 8;
const PREVIEW_MAX = 480;

/**
 * Display text: cut first (redaction regexes are not linear on long input), drop control and
 * bidi/format code points, redact, then clip to the display length. When the cut happened, the
 * token it split is dropped whole: earlier redactions can shrink the text enough to pull that cut
 * token into view, too short for its shape to match.
 */
export function display(v: string, max: number, keepNewlines = false): string {
  const head = v.length > max * 4 ? v.slice(0, max * 4).replace(/[A-Za-z0-9_+/=.~-]*$/, "") : v;
  const cleaned = head.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (keepNewlines && c === "\n" ? c : " "));
  return clip(redact(cleaned), max);
}

const str = (v: unknown, max = FIELD_MAX): string | undefined =>
  typeof v === "string" && v.length > 0 ? display(v, max) : undefined;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One JSONL line -> a row, or undefined. Same required fields as kya's parseTrailEvent. */
export function parseTrailLine(line: string): FeedRow | undefined {
  if (line.length > 64 * 1024) return undefined; // kya rows are small; a giant line is not one of them
  let e: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(line);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    e = raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (
    typeof e.ts !== "string" || typeof e.sessionId !== "string" || typeof e.toolId !== "string" ||
    typeof e.verdict !== "string" || typeof e.reasonCode !== "string" ||
    typeof e.mode !== "string" || !MODES.has(e.mode)
  ) {
    return undefined;
  }
  const v = e.verdict;
  // mode "hold" = a Hold/strict path was armed (hosted --strict hook, kya wrap --hold): not an advisory pass.
  const verdict: Verdict = v === "ALLOW" ? "ALLOW" : v === "DENY" ? "DENY"
    : v === "REQUIRE_APPROVE" ? (e.mode === "hold" ? "HOLD" : "REVIEW") : "OTHER";
  const preview = typeof e.diffPreview === "string"
    ? display(e.diffPreview, PREVIEW_MAX, true).split("\n").slice(0, PREVIEW_LINES).join("\n")
    : undefined;
  return {
    ts: display(e.ts, 40),
    toolId: display(e.toolId, 120),
    verdict,
    rawVerdict: display(v, 40),
    reasonCode: display(e.reasonCode, 80),
    mode: e.mode,
    neverEvent: e.neverEvent === true,
    shadow: e.shadow === true,
    product: str(e.product, 40),
    project: str(e.project, 80),
    importedFrom: str(e.importedFrom, 40),
    summary: str(e.summary),
    targetPath: str(e.targetPath),
    ...(preview ? { diffPreview: preview } : {}),
  };
}

// ---------- redaction (second pass; kya already redacts at write time) ----------

const TOKEN_SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, "[redacted-pem]"],
  [/(?<![A-Za-z0-9])(sk|rk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_[redacted]"],
  [/(?<![A-Za-z0-9])sk-(ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{8,}/g, "gh*_[redacted]"],
  [/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]+/g, "github_pat_[redacted]"],
  [/(?<![A-Za-z0-9])(AKIA|ASIA)[0-9A-Z]{8,}/g, "$1[redacted]"],
  [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]+/g, "xox*-[redacted]"],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{10,}/g, "AIza[redacted]"],
  [/(?<![A-Za-z0-9])(npm|hf|whsec|glpat|dckr_pat|xai)[_-][A-Za-z0-9_-]{8,}/g, "$1_[redacted]"],
  [/(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{4,}/gi, "$1 [redacted]"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, "$1$2[redacted]"],
  // Unanchored so the tail of a very long name still matches; bounded so it stays cheap (input <= 4*max).
  [/([A-Z0-9_]{0,64}(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]{0,256})=\S+/g, "$1=[redacted]"],
  [/(\s|^)(-p|--password|--token|--secret|--api-key)(\s+|=)\S+/g, "$1$2=[redacted]"],
  [/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[redacted]@"],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of TOKEN_SHAPES) out = out.replace(re, rep);
  return out;
}

// ---------- trail tailer ----------

export const TAIL_BYTES = 1024 * 1024;
export const MAX_ROWS = 200;

/**
 * Incremental reader for an append-only JSONL file. `poll()` returns the rows added since the
 * last call. First call and any shrink (truncate / rotate) re-read the last TAIL_BYTES. A partial
 * last line is held until its newline arrives.
 */
export class TrailTailer {
  private offset = -1;
  /** Bytes after the last newline. Lines are split on byte 0x0A before decoding, so a multibyte
   * character split across two writes is never decoded half (0x0A never occurs inside UTF-8). */
  private pending: Buffer = Buffer.alloc(0);
  constructor(readonly path: string, private readonly tailBytes = TAIL_BYTES) {}

  /** Bytes held for an unfinished line (bounded by tailBytes). */
  get pendingBytes(): number {
    return this.pending.length;
  }

  /** Never throws: an unreadable trail (EACCES, removed mid-read) comes back as `error`. */
  poll(): { rows: FeedRow[]; reset: boolean; error?: string } {
    let size: number;
    try {
      const st = statSync(this.path);
      if (!st.isFile()) return { rows: [], reset: false, error: "not a file" };
      size = st.size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const reset = this.offset > 0;
      this.offset = -1;
      this.pending = Buffer.alloc(0);
      return { rows: [], reset, ...(code === "ENOENT" ? {} : { error: code ?? "unreadable" }) };
    }
    let reset = false;
    let start = this.offset;
    if (start < 0 || size < start || size - start > this.tailBytes) {
      reset = true;
      start = Math.max(0, size - this.tailBytes);
      this.pending = Buffer.alloc(0);
    }
    if (size === start) {
      this.offset = size;
      return { rows: [], reset };
    }
    let bytes: Buffer;
    try {
      bytes = readRange(this.path, start, size - start);
    } catch (e) {
      return { rows: [], reset, error: (e as NodeJS.ErrnoException).code ?? "unreadable" };
    }
    this.offset = size;
    let chunk = Buffer.concat([this.pending, bytes]);
    if (reset && start > 0) {
      // Mid-file start: the first line is partial.
      const nl = chunk.indexOf(0x0a);
      chunk = nl === -1 ? Buffer.alloc(0) : chunk.subarray(nl + 1);
    }
    const last = chunk.lastIndexOf(0x0a);
    const complete = last === -1 ? "" : chunk.subarray(0, last).toString("utf8");
    this.pending = Buffer.from(chunk.subarray(last + 1));
    if (this.pending.length > this.tailBytes) this.pending = Buffer.alloc(0); // runaway line without newline
    const rows: FeedRow[] = [];
    for (const line of complete ? complete.split("\n") : []) {
      const row = line ? parseTrailLine(line) : undefined;
      if (row) rows.push(row);
    }
    return { rows, reset };
  }
}

function readRange(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export interface Counts { allow: number; review: number; hold: number; deny: number; never: number }

/** Counts over rows newer than `sinceMs`. The status bar passes the rows it holds (the last MAX_ROWS). */
export function countRows(rows: readonly FeedRow[], sinceMs: number): Counts {
  const c: Counts = { allow: 0, review: 0, hold: 0, deny: 0, never: 0 };
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t) || t < sinceMs) continue;
    if (r.verdict === "ALLOW") c.allow++;
    else if (r.verdict === "REVIEW") c.review++;
    else if (r.verdict === "HOLD") c.hold++;
    else if (r.verdict === "DENY") c.deny++;
    if (r.neverEvent) c.never++;
  }
  return c;
}

// ---------- gate mode (from the wired hook commands, never from trail rows) ----------

export type GateMode = "advisory" | "strict" | "mixed" | "none";
// "none" = nothing wired that we can see. The extension shows "unknown" instead when the trail still
// has recent rows (Codex/Gemini plugins and project-level wiring are not inspected).

/** User-level hook files `kya connect <host> --hooks` writes (sdks/kya/src/commands/wire-hooks.ts). */
export function hookFiles(home: string): string[] {
  return [
    join(home, ".claude", "settings.json"),
    join(home, ".grok", "hooks", "shield-kya.json"),
    join(home, ".kimi-code", "config.toml"),
  ];
}

/**
 * Classify each `hook --host <id> ...` command found in the given texts, plus Claude Code plugins
 * enabled in ~/.claude/settings.json: `kya@<marketplace>` is the advisory plugin (sdks/kya/plugins/kya);
 * a `kya-hosted@<marketplace>` plugin would be the fail-closed one.
 */
export function gateModeFromTexts(texts: readonly string[]): { mode: GateMode; hooks: number } {
  let strict = 0;
  let advisory = 0;
  for (const text of texts) {
    for (const cmd of hookCommands(text)) {
      // Exact shape kya writes: `"<node>" "<.../cli.js>" hook --host <id> [flags]` (or a `kya` bin).
      const m = /^(?:"[^"]*"\s+"[^"]*cli\.js"|\S*\bkya)\s+hook --host [a-z0-9-]+((?:\s.*)?)$/.exec(cmd.trim());
      if (!m) continue;
      // --plane-shadow records hosted verdicts and never blocks (kya hook.ts: enforce needs !shadow).
      if (/\s--plane-shadow\b/.test(m[1] ?? "")) advisory++;
      else if (/\s--(strict|fail-closed|plane-config)\b/.test(m[1] ?? "")) strict++;
      else advisory++;
    }
    for (const [id, on] of Object.entries(enabledPlugins(text))) {
      const p = /^kya(-hosted)?@[^@]+$/.exec(id);
      if (!p || on !== true) continue;
      if (p[1]) strict++;
      else advisory++;
    }
  }
  const hooks = strict + advisory;
  const mode: GateMode = hooks === 0 ? "none" : strict === 0 ? "advisory" : advisory === 0 ? "strict" : "mixed";
  return { mode, hooks };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const j: unknown = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hook command strings: every `command` string under the top-level `hooks` object of a JSON hook
 * file (Claude settings, Grok), none when `disableAllHooks` is true; or the `command = '...'` lines
 * of a TOML file (Kimi). Strings elsewhere (permissions, comments) are never read as hooks.
 */
export function hookCommands(text: string): string[] {
  const j = parseJson(text);
  if (!j) return [...text.matchAll(/^\s*command\s*=\s*(?:'([^'\n]*)'|"((?:[^"\\\n]|\\.)*)")\s*$/gm)].map((m) => m[1] ?? (m[2] ?? "").replace(/\\(.)/g, "$1"));
  if (j.disableAllHooks === true) return [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "command" && typeof x === "string") out.push(x);
        else walk(x);
      }
    }
  };
  walk(j.hooks);
  return out;
}

function enabledPlugins(text: string): Record<string, unknown> {
  const p = parseJson(text)?.enabledPlugins;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

export function detectGateMode(home: string): { mode: GateMode; hooks: number } {
  const texts: string[] = [];
  for (const f of hookFiles(home)) {
    try {
      if (statSync(f).size <= TAIL_BYTES) texts.push(readFileSync(f, "utf8"));
    } catch { /* not wired for that host */ }
  }
  return gateModeFromTexts(texts);
}

// ---------- executable resolution (never from the workspace) ----------

export function isInside(child: string, parents: readonly string[], caseInsensitive: boolean): boolean {
  const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  return parents.some((parent) => {
    const rel = relative(norm(parent), norm(child));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  });
}

function realOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** PATH with relative entries and entries inside a workspace folder removed. */
export function safePath(envPath: string | undefined, workspaces: readonly string[], ci: boolean): string[] {
  const roots = workspaces.map(realOr);
  return (envPath ?? "").split(delimiter).filter((d) => d && isAbsolute(d) && !isInside(realOr(d), roots, ci));
}

/** First executable named `name` on the safe PATH, realpathed and outside every workspace folder. */
export function findExecutable(
  name: string,
  dirs: readonly string[],
  workspaces: readonly string[],
  opts: { win: boolean; ci: boolean; pathext?: string },
): string | undefined {
  const exts = opts.win ? (opts.pathext ?? ".EXE;.CMD").split(";").filter(Boolean) : [""];
  const roots = workspaces.map(realOr);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!opts.win) accessSync(candidate, constants.X_OK);
        const real = realpathSync(candidate);
        if (!isInside(real, roots, opts.ci)) return real;
      } catch { /* not here */ }
    }
  }
  return undefined;
}

/** Trusted for spawns, MCP and network: VS Code trusts the workspace and every folder is local. */
export function trustedFor(isTrusted: boolean, folderSchemes: readonly string[]): boolean {
  return isTrusted && folderSchemes.every((s) => s === "file");
}

/** Env for the kya child: every PATH-like key (Windows also has `Path`) replaced by the sanitized dirs. */
export function childEnv(dirs: readonly string[], base: NodeJS.ProcessEnv = process.env, win = process.platform === "win32"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^path$/i.test(k)) env[k] = v;
  env.PATH = dirs.join(win ? ";" : ":");
  return env;
}

/** A user-configured absolute path, realpathed; undefined when relative, missing or inside a workspace. */
export function userPath(p: string, workspaces: readonly string[], ci: boolean): string | undefined {
  if (!isAbsolute(p)) return undefined;
  try {
    const real = realpathSync(p);
    return isInside(real, workspaces.map(realOr), ci) ? undefined : real;
  } catch {
    return undefined;
  }
}

/**
 * The kya entry script (`dist/cli.js`) behind a resolved `kya` bin or a user-set path. The npm bin
 * symlink realpaths to cli.js on macOS/Linux; on Windows the .cmd shim sits next to node_modules.
 */
export function kyaCliJs(resolved: string): string | undefined {
  if (/\.(c|m)?js$/.test(resolved) && existsSync(resolved)) return resolved;
  const npmLayout = join(dirname(resolved), "node_modules", "@shield-agent", "kya", "dist", "cli.js");
  return existsSync(npmLayout) ? npmLayout : undefined;
}

// ---------- hosted approvals (network only when the user enabled hosted) ----------

export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; redirect: "error"; signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface Approval { id: string; status: string; action?: string; priority?: string; createdAt?: string }

/** https anywhere, http only on loopback; no userinfo. Returns the origin+path without a trailing slash. */
export function validateBaseUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error("hosted base URL is not a URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error("hosted base URL must be https (http only for 127.0.0.1/localhost)");
  }
  if (u.username || u.password || u.search || u.hash) throw new Error("hosted base URL must not carry credentials, query or fragment");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Machine keys (sk_*) can list but never decide (same rule as kya `decide`). */
export const isMachineKey = (key: string): boolean => key.startsWith("sk_");

export class HostedClient {
  constructor(private readonly baseUrl: string, private readonly key: string, private readonly fetchImpl: FetchLike) {}

  private async call(path: string, method: "GET" | "POST"): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (isMachineKey(this.key)) headers["X-API-Key"] = this.key;
    else headers.Authorization = `Bearer ${this.key}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method, headers, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(res.status === 401 || res.status === 403
        ? `hosted plane rejected the key (HTTP ${res.status})`
        : `hosted plane returned HTTP ${res.status}`);
    }
    const text = await res.text();
    try { return text ? JSON.parse(text) : undefined; } catch { throw new Error("hosted plane returned non-JSON"); }
  }

  async list(): Promise<Approval[]> {
    const rows = await this.call("/api/v1/kya/approvals", "GET");
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r) => {
      if (!r || typeof r !== "object") return [];
      const o = r as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.status !== "string") return [];
      return [{
        id: clip(o.id, 64), status: clip(o.status, 32),
        ...(typeof o.action === "string" ? { action: display(o.action, 120) } : {}),
        ...(typeof o.priority === "string" ? { priority: clip(o.priority, 16) } : {}),
        ...(typeof o.createdAt === "string" ? { createdAt: clip(o.createdAt, 40) } : {}),
      }];
    });
  }

  async decide(id: string, decision: "approve" | "reject"): Promise<Approval> {
    if (isMachineKey(this.key)) throw new Error(`machine keys (sk_*) cannot ${decision}; use the console`);
    if (!/^[0-9a-fA-F-]{1,64}$/.test(id)) throw new Error("approval id is not a UUID");
    const r = await this.call(`/api/v1/kya/approvals/${encodeURIComponent(id)}/${decision}`, "POST");
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.status !== "string") throw new Error("approval decide returned no id/status");
    return { id: o.id, status: o.status };
  }
}
