/**
 * Hosted-plane mode for `kya hook` (beta): `--plane-config <absolute path>`.
 *
 * The API key, base URL and agent id come ONLY from that one user-owned file.
 * Env (KYA_OFFLINE, KYA_BASE_URL, KYA_API_KEY, SHIELD_API_KEY, KYA_AGENT_ID,
 * KYA_HOME) and the repo's .kya/config.json are never read on this path, so
 * neither can downgrade it. Every plane failure is a reason code, never an
 * exception message (which could echo config bytes or the key).
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, sep } from "node:path";
import { applyPlaneAuth, type PolicyEvaluateResponse } from "../client.js";
import { computeArgsHash } from "../hash.js";
import { deriveWireChangeFields } from "../diff-preview.js";
import { findSampleTool } from "../sample-tools.js";
import { CLI_VERSION } from "../version.js";

export type PlaneCode =
  | "PLANE_CONFIG"
  | "PLANE_ENV_REFUSED"
  | "PLANE_UNREACHABLE"
  | "PLANE_AUTH_REJECTED"
  | "PLANE_TIMEOUT"
  | "PLANE_RATE_LIMITED";

/** A plane failure. `message` is fixed text chosen here: never upstream or parser output. */
export class PlaneError extends Error {
  constructor(readonly code: PlaneCode, message: string) {
    super(message);
    this.name = "PlaneError";
  }
}

/** Keys loaded in this process; the hosted output guard redacts them from stdout and stderr. */
export const loadedSecrets = new Set<string>();

/** Every form of a loaded key the guard redacts: exact, URL-encoded and base64. */
function secretForms(): string[] {
  const out = new Set<string>();
  for (const k of loadedSecrets) {
    out.add(k);
    out.add(encodeURIComponent(k));
    out.add(Buffer.from(k, "utf8").toString("base64"));
  }
  return [...out].filter((f) => f.length >= 8);
}

/**
 * Best-effort output guard for hosted mode: the exact key (and its URL-encoded
 * and base64 forms) is replaced by [redacted] in anything written to the
 * stream, including a key split across two writes (a trailing partial match
 * is held back until the next write or process exit). kya itself never
 * prints the key; this covers anything else that might.
 */
export function guardStream(stream: NodeJS.WriteStream): void {
  const orig = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  let pending = "";
  (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    const forms = secretForms();
    if (forms.length === 0 || (typeof chunk !== "string" && !Buffer.isBuffer(chunk))) {
      return orig(chunk, ...rest);
    }
    let text = pending + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    for (const f of forms) text = text.split(f).join("[redacted]");
    // Hold back a tail that could be the start of a key completed by the next write.
    let hold = 0;
    for (const f of forms) {
      for (let n = Math.min(f.length - 1, text.length); n > hold; n--) {
        if (text.endsWith(f.slice(0, n))) { hold = n; break; }
      }
    }
    pending = hold ? text.slice(-hold) : "";
    return orig(hold ? text.slice(0, -hold) : text, ...rest);
  };
  process.once("exit", () => {
    // A held tail that never became a key is ordinary output: release it.
    if (pending) { try { writeSync((stream as unknown as { fd: number }).fd, pending); } catch { /* exiting */ } }
  });
}

/** What the hook knows before any plane code runs; the crash path never lowers it. */
export const hostedDecision: { neverList: "deny" | "clear" | "unknown" } = { neverList: "unknown" };

/**
 * Crash decision. The local never-list (evaluated before any plane code) wins
 * everywhere, shadow included; an unparsed payload is not provably harmless,
 * so it also denies in shadow. Only a payload known to be off the never-list
 * may exit 0, and only in shadow.
 */
export function crashDecision(shadow: boolean): { code: 0 | 2; reason: string } {
  if (hostedDecision.neverList === "deny") {
    return { code: 2, reason: "KYA denied: NEVER_EVENT (internal error after the local never-list matched)" };
  }
  if (shadow && hostedDecision.neverList === "clear") {
    return { code: 0, reason: "KYA shadow: internal error; allowed because --plane-shadow is set" };
  }
  return { code: 2, reason: "KYA hosted: internal error (FAIL_CLOSED); tool call denied (fails closed)" };
}

/**
 * Hosted mode crash path: an uncaught exception or rejection must not become
 * exit 1 (which a host without onFailure "block" treats as allow). Uses
 * crashDecision (never the error text): stderr first, then the deny JSON.
 */
export function hostedCrashHandler(opts: {
  shadow: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
  exit: (code: number) => void;
}): () => void {
  return () => {
    const d = crashDecision(opts.shadow);
    try {
      opts.err(`${d.reason}\n`);
      if (d.code === 2) {
        opts.out(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } })}\n`);
      }
    } catch { /* still exit below */ } finally {
      opts.exit(d.code);
    }
  };
}

export interface PlaneConfig {
  /** Display form of the validated origin (console links). Requests use `url`. */
  readonly baseUrl: string;
  /** The one parsed, validated URL object every request is built from. */
  readonly url: URL;
  readonly apiKey: string;
  readonly agentId: string;
}

export const DEFAULT_PLANE_BUDGET_MS = 3000;
/** Node start (~0.2 s) plus trail work must stay under the host's 5 s hook timeout. */
export const MAX_PLANE_BUDGET_MS = 4000;
const MIN_PLANE_BUDGET_MS = 100;
const MAX_CONFIG_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Flag-only test mode admits exactly these literal hosts. */
const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);

/** Clamp a --plane-budget-ms value; anything unparseable is the default. */
export function planeBudgetMs(raw: string | boolean | undefined): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_PLANE_BUDGET_MS;
  return Math.min(MAX_PLANE_BUDGET_MS, Math.max(MIN_PLANE_BUDGET_MS, n));
}

/**
 * NODE_OPTIONS tokens hosted mode accepts; anything else is refused (allowlist).
 * Matched after unquoting and with underscores in the flag name read as dashes,
 * the way node does.
 */
const SAFE_NODE_OPTION = /^--(max-old-space-size|max-semi-space-size|stack-trace-limit)=\d+$|^--(no-warnings|no-deprecation|enable-source-maps)$|^--disable-warning=[A-Za-z0-9-]+$/;

/**
 * Split NODE_OPTIONS for the allowlist check. Close to node's own rules
 * (whitespace separates tokens, double quotes group, a backslash escapes the
 * next character inside quotes) but stricter: undefined for anything it does
 * not understand (an unterminated quote or a trailing escape), which refuses.
 */
export function parseNodeOptions(raw: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted && c === "\\") {
      if (i + 1 >= raw.length) return undefined;
      cur += raw[++i];
    } else if (c === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
    }
  }
  if (quoted) return undefined;
  if (has || cur) out.push(cur);
  return out;
}

function safeNodeOption(token: string): boolean {
  const eq = token.indexOf("=");
  const name = (eq === -1 ? token : token.slice(0, eq)).replace(/_/g, "-");
  return SAFE_NODE_OPTION.test(eq === -1 ? name : name + token.slice(eq));
}

/** Read by node or OpenSSL at process start, so they cannot be undone at runtime: refuse. */
const REFUSED_TLS_ENV = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "NODE_PATH", "OPENSSL_CONF"] as const;

/** Proxy and TLS-override variables: deleted in hosted mode (the transport never uses a proxy anyway). */
export const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED"] as const;

/** Namespaces that steer node, libuv or OpenSSL; only the names below are allowed in hosted mode. */
const CONTROLLED_ENV = /^(NODE_|SSL_|OPENSSL_|UV_|DYLD_|LD_)/i;
const ALLOWED_CONTROLLED_ENV = new Set(["NODE_ENV", "NODE_OPTIONS", "NODE_NO_WARNINGS", "NODE_DISABLE_COLORS", "NODE_VERSION"]);

/**
 * Env that can load code into node, weaken TLS, add trust anchors, print
 * request headers (NODE_DEBUG) or route the plane call through a proxy (N15
 * lessons, reviews of #388). Positive allowlist: any NODE_*, SSL_*, OPENSSL_*
 * or UV_* variable outside ALLOWED_CONTROLLED_ENV is refused, and NODE_OPTIONS
 * must pass the token allowlist above. Returns the variable NAME only, never
 * its value.
 */
export function hostedEnvProblem(env: NodeJS.ProcessEnv): string | undefined {
  for (const k of REFUSED_TLS_ENV) {
    if (env[k] !== undefined && env[k] !== "") return `${k} is set`;
  }
  for (const k of Object.keys(env).sort()) {
    if (CONTROLLED_ENV.test(k) && !ALLOWED_CONTROLLED_ENV.has(k) && env[k] !== undefined && env[k] !== "") {
      return `${k} is set`;
    }
  }
  const tokens = parseNodeOptions(env.NODE_OPTIONS ?? "");
  if (!tokens || !tokens.every(safeNodeOption)) {
    return "NODE_OPTIONS has a flag outside the hosted-mode allowlist";
  }
  return undefined;
}

/** Hosted mode start: strip proxy and TLS-override variables before any network code. */
export function scrubNetworkEnv(...envs: NodeJS.ProcessEnv[]): void {
  for (const e of envs) for (const k of PROXY_ENV) delete e[k];
}

function insideDir(child: string, dir: string): boolean {
  return child === dir || child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Nearest ancestor holding a .git entry (dir or worktree file); no git process spawned. */
export function gitRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    try {
      lstatSync(join(d, ".git"));
      return d;
    } catch { /* keep walking */ }
    if (dirname(d) === d) return undefined;
  }
}

function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Load and validate the plane config file. Refuses: relative paths, symlinks
 * (O_NOFOLLOW + fstat on the opened fd, no check-then-read race), non-regular
 * files, another owner, group/world bits, files inside the agent's working
 * directory (unless that directory is the home dir itself), bad JSON, a
 * non-https base URL (loopback http only with the explicit argv flag), URL
 * credentials, and a non-UUID agent id. Throws PlaneError("PLANE_CONFIG").
 */
export function loadPlaneConfig(
  path: string,
  opts: { readonly cwds: readonly string[]; readonly home: string; readonly allowHttpLoopback?: boolean },
): PlaneConfig {
  const bad = (why: string): never => {
    throw new PlaneError("PLANE_CONFIG", `plane config ${why}`);
  };
  if (process.platform === "win32") bad("is not supported on Windows in this beta (no POSIX owner and mode check)");
  if (!path || !isAbsolute(path)) bad("path must be absolute");
  // lstat first: a FIFO or device would block or misbehave on open.
  let pre;
  try {
    pre = lstatSync(path);
  } catch {
    return bad("cannot be opened");
  }
  if (pre.isSymbolicLink()) bad("must not be a symlink");
  if (!pre.isFile()) bad("must be a regular file");
  if (pre.size > MAX_CONFIG_BYTES) bad("is too large");
  let fd: number | undefined;
  let text = "";
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      bad(code === "ELOOP" ? "must not be a symlink" : "cannot be opened");
    }
    const st = fstatSync(fd!);
    if (!st.isFile() || st.ino !== pre.ino || st.dev !== pre.dev) bad("must be a regular file");
    // A hard link elsewhere (for example inside a repo) would dodge the location check.
    if (st.nlink > 1) bad("must not have other hard links");
    if (process.getuid && st.uid !== process.getuid()) bad("must be owned by the current user");
    if ((st.mode & 0o077) !== 0) bad("must not be group or world accessible (chmod 600)");
    if (st.size > MAX_CONFIG_BYTES) bad("is too large");
    const buf = Buffer.alloc(Math.min(st.size, MAX_CONFIG_BYTES));
    const n = readSync(fd!, buf, 0, buf.length, 0);
    text = buf.subarray(0, n).toString("utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const file = real(path) ?? path;
  const home = real(opts.home) ?? opts.home;
  for (const cwd of opts.cwds) {
    const dir = cwd && real(cwd);
    if (!dir) continue;
    for (const d of [dir, gitRoot(dir)]) {
      if (d && d !== home && insideDir(file, d)) bad("must not live inside the project directory or its git work tree");
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Never echo the parser message: newer V8 quotes the input, which holds the key.
    bad("is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("must be a JSON object");
  const o = raw as Record<string, unknown>;
  const apiKey = typeof o.apiKey === "string" ? o.apiKey.trim() : "";
  // Printable ASCII only: anything else cannot be a header value (node throws) and is not a real key.
  if (!/^[\x21-\x7e]{8,512}$/.test(apiKey)) bad("needs an apiKey of 8 to 512 printable ASCII characters");
  const agentId = typeof o.agentId === "string" ? o.agentId.trim() : "";
  if (!UUID_RE.test(agentId)) bad("needs agentId (the registered agent's UUID)");
  const url = validatePlaneUrl(typeof o.baseUrl === "string" ? o.baseUrl.trim() : "", opts.allowHttpLoopback === true);
  loadedSecrets.add(apiKey);
  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, ""), url, apiKey, agentId };
}

/**
 * Strict base-URL check, one parse. https only; no userinfo, query or
 * fragment; ASCII only (no punycode); the host as written must equal the
 * parsed host (refuses 0x7f.1, 2130706433 and other non-canonical forms); no
 * IP literal and no `localhost`. The argv-only loopback test mode admits
 * exactly 127.0.0.1 and [::1], over http or https.
 */
export function validatePlaneUrl(raw: string, allowLoopback: boolean): URL {
  const bad = (why: string): never => {
    throw new PlaneError("PLANE_CONFIG", `plane config baseUrl ${why}`);
  };
  if (!raw || /[^\x21-\x7e]/.test(raw)) bad("must be a non-empty ASCII URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("is not a valid URL");
  }
  if (url.username || url.password || /^[a-z]+:\/\/[^/?#]*@/i.test(raw)) bad("must not carry credentials");
  if (url.search || url.hash || /[?#]/.test(raw)) bad("must not carry a query or fragment");
  if (/^[a-z]+:\/\/(\[[^\]]*\]|[^/:]+):0*(\/|$)/i.test(raw)) bad("must not use port 0");
  const rawHost = /^[a-z]+:\/\/(\[[^\]]*\]|[^/:]+)/i.exec(raw)?.[1]?.toLowerCase().replace(/\.+$/, "");
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.replace(/\.+$/, "");
  if (!rawHost || rawHost !== url.hostname) bad("host must be written in canonical form");
  if (url.hostname.split(".").some((l) => l.startsWith("xn--"))) bad("host must not be punycode");
  const loopback = allowLoopback && LOOPBACK.has(url.hostname);
  if (!loopback) {
    if (url.protocol !== "https:") bad("must be https");
    if (/(^|\.)localhost$|^localhost\./.test(url.hostname)) bad("must not be localhost");
    if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) bad("must not be an IP address");
  } else if (url.protocol !== "https:" && url.protocol !== "http:") {
    bad("must be https or loopback http");
  }
  return url;
}

/** Cap on the plane's answer: a verdict is a few hundred bytes. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** Printable ASCII, at most 128 chars: plane text reaches the model and the trail. */
export function cleanPlaneText(v: unknown): string {
  return typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, 128) : "";
}

/** Reason codes are short upper-case identifiers; anything else becomes PLANE_BAD_RESPONSE. */
export function planeReasonCode(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return typeof v === "string" && /^[A-Z0-9_]{1,64}$/.test(v) ? v : "PLANE_BAD_RESPONSE";
}

/** Minimal response shape the retry loop needs (a WHATWG Response satisfies it). */
export interface PlaneResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type PlaneTransport = (
  url: URL,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<PlaneResponse>;

/**
 * The hosted-mode transport: node:https with its own agent (verify certs, no
 * keep-alive, no proxy), SNI from the validated host, no redirect following.
 * The global fetch is never used, so env proxy switches and undici defaults
 * cannot reach this call. Plain http only for the argv-only loopback mode.
 */
export const httpsTransport: PlaneTransport = (url, init) =>
  new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const common = {
      method: "POST",
      host,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      headers: { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) },
      signal: init.signal,
    };
    const agent = new HttpsAgent({ rejectUnauthorized: true, keepAlive: false });
    const done = () => agent.destroy();
    let req: ReturnType<typeof httpsRequest>;
    try {
      req = url.protocol === "https:"
        ? httpsRequest({
            ...common,
            agent,
            rejectUnauthorized: true,
            ...(isIP(host) ? {} : { servername: host }),
          })
        : httpRequest({ ...common, agent: false });
    } catch (e) {
      // A request that cannot even be built (bad header value, ...) is a plane failure, not a crash.
      done();
      reject(e);
      return;
    }
    // Registered only once req exists: no temporal-dead-zone window.
    init.signal.addEventListener("abort", () => { req.destroy(); done(); reject(init.signal.reason); }, { once: true });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          // Stop reading at once; an endless or huge body is a plane failure, not a crash.
          req.destroy();
          done();
          reject(new PlaneError("PLANE_UNREACHABLE", "hosted plane response is too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("error", (e) => { done(); reject(e); });
      res.on("end", () => {
        done();
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: { get: (n: string) => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] ?? null : v ?? null; } },
          text: async () => text,
        });
      });
    });
    req.on("error", (e) => { done(); reject(e); });
    req.end(init.body);
  });

export interface HostedEvaluateInput {
  readonly config: PlaneConfig;
  readonly toolName: string;
  readonly args: unknown;
  readonly product: string;
  readonly strict: boolean;
  readonly sessionId?: string;
  readonly toolUseId?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly budgetMs: number;
  /** Test seams: wire, clock and jitter. */
  readonly fetch?: PlaneTransport;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export const BACKOFF_BASE_MS = 200;
export const BACKOFF_CAP_MS = 1600;

/** Exponential backoff with equal jitter: attempt n waits in [d/2, d], d = min(cap, base * 2^n). */
export function backoffMs(attempt: number, random: () => number): number {
  const d = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(d / 2 + random() * (d / 2));
}

/** Retry-After as delta seconds or an HTTP date; undefined when absent or garbage. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const v = header.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** sha256 over the same key shape as the hook's tool_use_id marker. */
export function correlationId(sessionId: string | undefined, toolUseId: string | undefined): string | undefined {
  if (!toolUseId) return undefined;
  const key = sessionId ? JSON.stringify([sessionId, toolUseId]) : toolUseId;
  return createHash("sha256").update(key).digest("hex");
}

const VERDICTS = new Set(["ALLOW", "DENY", "REQUIRE_APPROVE"]);

/**
 * The evaluate body: what connected mode sends (toolId, argsHash, sample risk
 * fields, redacted change fields unless KYA_SEND_PREVIEWS=0), plus the hook
 * fields the design adds: env.correlationId, mode, product, and
 * requireRegisteredAgent so the hosted kill switch applies. Raw args never leave.
 */
export function hostedEvaluateBody(input: HostedEvaluateInput): Record<string, unknown> {
  const sample = findSampleTool(input.toolName);
  const change = deriveWireChangeFields(input.toolName, input.args, input.env);
  return {
    toolId: input.toolName,
    action: input.toolName,
    argsHash: computeArgsHash(input.args),
    irreversible: sample?.irreversible ?? false,
    actionClass: sample?.actionClass,
    dataClass: sample?.dataClass,
    sessionRisk: "LOW",
    approvalStatus: "NONE",
    packId: "generic",
    ...(change ?? {}),
    env: {
      host: "ide",
      agentId: input.config.agentId,
      // No env.sessionId: kya_tool_event.session_id references kya_session, so an
      // un-ingested host session id makes the plane drop the trail row (fail soft).
      correlationId: correlationId(input.sessionId, input.toolUseId),
    },
    mode: input.strict ? "hold" : "observe",
    product: input.product,
    requireRegisteredAgent: true,
  };
}

/**
 * One deadline for the whole call. Retries 429, 5xx and network errors with
 * exponential backoff plus jitter, honours Retry-After, and never sleeps past
 * the deadline: if the next wait does not fit, it fails now with the code of
 * the last failure. 401/403 and other 4xx are not retried. Each attempt is
 * capped at half the budget, so a single stalled attempt is retried once.
 */
export async function evaluateHosted(input: HostedEvaluateInput): Promise<PolicyEvaluateResponse> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = input.random ?? Math.random;
  const fetchImpl = input.fetch ?? httpsTransport;
  const deadline = now() + input.budgetMs;
  const body = JSON.stringify(hostedEvaluateBody(input));
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": `shield-agent-kya-cli/${CLI_VERSION}`,
  };
  applyPlaneAuth(headers, input.config.apiKey);
  // Built from the same validated URL object, never from a second string.
  const url = new URL(input.config.url);
  url.pathname = `${input.config.url.pathname.replace(/\/+$/, "")}/api/v1/kya/policy/evaluate`;

  let last: PlaneError = new PlaneError("PLANE_TIMEOUT", "hosted plane did not answer within the budget");
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) return Promise.reject(last);
    let wait: number;
    try {
      const res = await fetchImpl(url, {
        headers,
        body,
        // Per-attempt cap: one stalled attempt must leave room for a retry (timeouts are transient too).
        signal: AbortSignal.timeout(Math.min(remaining, Math.ceil(input.budgetMs / 2))),
      });
      if (res.status === 401 || res.status === 403) {
        throw new PlaneError("PLANE_AUTH_REJECTED", `hosted plane rejected the API key (HTTP ${res.status})`);
      }
      if (res.status >= 300 && res.status < 400) {
        // Never follow: the key header must not reach a second URL.
        throw new PlaneError("PLANE_UNREACHABLE", `hosted plane answered with a redirect (HTTP ${res.status}); not followed`);
      }
      if (res.status >= 200 && res.status < 300) {
        let parsed: PolicyEvaluateResponse | undefined;
        try {
          parsed = JSON.parse(await res.text()) as PolicyEvaluateResponse;
        } catch { /* no verdict below */ }
        const verdict = typeof parsed?.verdict === "string" ? parsed.verdict.toUpperCase() : "";
        if (!parsed || !VERDICTS.has(verdict)) {
          throw new PlaneError("PLANE_UNREACHABLE", "hosted plane returned no verdict");
        }
        return {
          verdict,
          reasonCode: planeReasonCode(parsed.reasonCode),
          ...(typeof parsed.toolId === "string" ? { toolId: cleanPlaneText(parsed.toolId) } : {}),
          ...(typeof parsed.argsHash === "string" && /^[0-9a-f]{64}$/.test(parsed.argsHash) ? { argsHash: parsed.argsHash } : {}),
        };
      }
      // Do not await: a stuck body must not eat the budget.
      if (res.status === 429) {
        last = new PlaneError("PLANE_RATE_LIMITED", "hosted plane rate limit reached (HTTP 429)");
        const ra = retryAfterMs(res.headers.get("retry-after"), now());
        // Floor: Retry-After 0 or a past date must not turn into a zero-wait retry loop.
        wait = Math.max(ra ?? 0, backoffMs(attempt, random));
        // Retry-After that does not fit the budget: fail now instead of sleeping.
        if (ra !== undefined && ra >= deadline - now()) return Promise.reject(last);
      } else if (res.status >= 500) {
        last = new PlaneError("PLANE_UNREACHABLE", `hosted plane error (HTTP ${res.status})`);
        wait = backoffMs(attempt, random);
      } else {
        throw new PlaneError("PLANE_UNREACHABLE", `hosted plane refused the request (HTTP ${res.status})`);
      }
    } catch (e) {
      if (e instanceof PlaneError) throw e;
      last = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError" || deadline - now() <= 0
        ? new PlaneError("PLANE_TIMEOUT", "hosted plane did not answer within the budget")
        : new PlaneError("PLANE_UNREACHABLE", "hosted plane unreachable");
      wait = backoffMs(attempt, random);
    }
    const left = deadline - now();
    if (wait >= left) return Promise.reject(last);
    await sleep(wait);
  }
}
