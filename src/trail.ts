/**
 * Local session trail (JSONL). Observe path - not a second PEP.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { configDir, globalConfigDir } from "./config.js";

export type TrailProduct =
  | "cursor"
  | "claude"
  | "codex"
  | "gemini"
  | "grok"
  | "kimi"
  | "ide"
  | "runtime"
  | "other";

/** Foreign trace formats the importer accepts (host "import" events). */
export type TrailImportFormat = "langsmith" | "langfuse" | "phoenix" | "otel" | "adr-sensor" | "openshell";

export interface TrailEvent {
  readonly ts: string;
  readonly sessionId: string;
  readonly host?: string;
  /** Coding tool / product that produced the event. */
  readonly product?: TrailProduct;
  /** Project folder basename the event was written from. */
  readonly project?: string;
  readonly toolId: string;
  readonly verdict: string;
  readonly reasonCode: string;
  readonly mode: "observe" | "hold" | "offline";
  readonly neverEvent?: boolean;
  /** Never-list input rule id that denied the call (an id from never-list-input.ts, never command text or a path). */
  readonly neverRule?: string;
  /** Source format on imported (host "import") events. */
  readonly importFormat?: TrailImportFormat;
  readonly packId?: string;
  readonly argsHash?: string;
  /** Short redacted change line for the activity feed (never raw args). */
  readonly summary?: string;
  /** Clipped redacted change preview (never full patch). */
  readonly diffPreview?: string;
  /** Clipped redacted target file path (never raw args). */
  readonly targetPath?: string;
  /** Wall latency of the evaluate call in ms. Observe-only; never a verdict input. */
  readonly latencyMs?: number;
  /** Real input tokens reported by the host. Observe-only showback. */
  readonly tokensIn?: number;
  /** Real output tokens reported by the host. Observe-only showback. */
  readonly tokensOut?: number;
  /** Provenance of an imported row (`kya import --from <source>`); absent for live rows. */
  readonly importedFrom?: string;
  /** Source-record hash used to dedupe re-imports (agt: the AGT audit entry hash). */
  readonly sourceHash?: string;
  /** agt import: false when the source log's hash chain did not verify. */
  readonly chainVerified?: boolean;
  /** Hosted hook with --plane-shadow: the verdict was recorded, never enforced (except the never-list and the guard pack). */
  readonly shadow?: boolean;
  /** Hosted hook: env or repo config tried to steer it and was ignored. */
  readonly configIgnored?: boolean;
  /** Stable hashed id of this install (device-id.ts). Never the host name, user or MAC. */
  readonly deviceId?: string;
  /** Privacy-safe class of the tool target (map/target-class.ts). A class, never a path, URL path, argument or command. */
  readonly targetClass?: string;
}

export function globalTrailPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "trail.jsonl");
}

/** The one archive kept by rotation: the previous trail.jsonl, replaced at each rotation. */
export function archivedTrailPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "trail.1.jsonl");
}

/** Archive first, then the live file: the order a full scan of the record must read. */
export function trailScanPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return [archivedTrailPath(env), globalTrailPath(env)].filter((p) => existsSync(p));
}

/** trail.jsonl is renamed to trail.1.jsonl when it reaches this size: at most about 2 x 8 MiB on disk. */
export const TRAIL_ROTATE_BYTES = 8 * 1024 * 1024;
/** A rotation lock older than this is left over from a killed process. */
const ROTATE_LOCK_STALE_MS = 60_000;

/**
 * Renames the live trail to the archive once it reaches TRAIL_ROTATE_BYTES (the old archive is replaced).
 * rename is atomic and appenders open the file by path, so no event is lost. An O_EXCL lock stops two
 * processes from rotating twice in a row, which would replace the archive with a nearly empty file.
 * Never throws: recording must not fail because rotation did.
 */
export function rotateTrailIfNeeded(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = globalTrailPath(env);
  try {
    if (statSync(path).size < TRAIL_ROTATE_BYTES) return false;
  } catch {
    return false;
  }
  const lock = join(globalConfigDir(env), "trail.rotate.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs < ROTATE_LOCK_STALE_MS) return false;
      unlinkSync(lock);
      fd = openSync(lock, "wx");
    } catch {
      return false;
    }
  }
  try {
    // Another process may have rotated between our stat and the lock.
    if (statSync(path).size < TRAIL_ROTATE_BYTES) return false;
    renameSync(path, archivedTrailPath(env));
    return true;
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
      unlinkSync(lock);
    } catch {
      /* a stale lock expires after ROTATE_LOCK_STALE_MS */
    }
  }
}

/** Pre-0.3.0 per-project trail location, still merged on read. */
export function legacyTrailPath(cwd: string): string {
  return join(configDir(cwd), "trail.jsonl");
}

/** The trail is global since 0.3.0 - one file for all projects. */
export function trailPath(_cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return globalTrailPath(env);
}

export function receiptsDir(cwd: string): string {
  return join(configDir(cwd), "receipts");
}

/** Detect Cursor / Claude Code / Codex / Grok / host from env. */
export function detectProduct(
  env: NodeJS.ProcessEnv = process.env,
  host?: string,
): TrailProduct {
  if (env.CURSOR_SESSION_ID || env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return "cursor";
  if (
    env.CLAUDECODE ||
    env.CLAUDE_CODE_ENTRYPOINT ||
    env.CLAUDE_SESSION_ID ||
    (env.TERM_PROGRAM && /claude/i.test(env.TERM_PROGRAM))
  ) {
    return "claude";
  }
  if (env.CODEX_HOME || env.CODEX_SESSION || env.OPENAI_CODEX) return "codex";
  if (env.GROK_SESSION || env.GROK_BUILD || env.XAI_GROK) return "grok";
  if (host === "ide") return "ide";
  if (host === "runtime") return "runtime";
  return "other";
}

export function productLabel(p: TrailProduct | undefined): string {
  switch (p) {
    case "cursor":
      return "Cursor";
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini CLI";
    case "grok":
      return "Grok";
    case "kimi":
      return "Kimi Code";
    case "ide":
      return "IDE";
    case "runtime":
      return "Runtime";
    default:
      return "Other";
  }
}

/** Map a hook --host id to the trail product (explicit beats env sniffing). */
export function hostToProduct(host: string): TrailProduct {
  switch (host) {
    case "claude":
      return "claude";
    case "grok":
      return "grok";
    case "kimi":
      return "kimi";
    case "cursor":
      return "cursor";
    case "codex":
      return "codex";
    case "gemini":
      return "gemini";
    default:
      return "other";
  }
}

export function appendTrail(
  cwd: string,
  event: TrailEvent,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(globalConfigDir(env), { recursive: true });
  rotateTrailIfNeeded(env);
  const enriched: TrailEvent = {
    ...event,
    product: event.product ?? detectProduct(env, event.host),
    project: event.project ?? basename(cwd),
  };
  appendFileSync(globalTrailPath(env), `${JSON.stringify(enriched)}\n`, "utf8");
}

const TRAIL_MODES = new Set<string>(["observe", "hold", "offline"]);
const TRAIL_PRODUCTS = new Set<string>([
  "cursor",
  "claude",
  "codex",
  "gemini",
  "grok",
  "kimi",
  "ide",
  "runtime",
  "other",
]);
const TRAIL_IMPORT_FORMATS = new Set<string>(["langsmith", "langfuse", "phoenix", "otel", "adr-sensor", "openshell"]);

/**
 * Validate one parsed JSONL line against the TrailEvent shape. Untrusted
 * fields (wrong type, unknown mode/product) drop the line or the field -
 * a single malformed line must never brick the report render.
 */
function parseTrailEvent(raw: unknown): TrailEvent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.ts !== "string" ||
    typeof e.sessionId !== "string" ||
    typeof e.toolId !== "string" ||
    typeof e.verdict !== "string" ||
    typeof e.reasonCode !== "string" ||
    typeof e.mode !== "string" ||
    !TRAIL_MODES.has(e.mode)
  ) {
    return undefined;
  }
  return {
    ts: e.ts,
    sessionId: e.sessionId,
    toolId: e.toolId,
    verdict: e.verdict,
    reasonCode: e.reasonCode,
    mode: e.mode as TrailEvent["mode"],
    ...(typeof e.host === "string" ? { host: e.host } : {}),
    ...(typeof e.product === "string" && TRAIL_PRODUCTS.has(e.product)
      ? { product: e.product as TrailProduct }
      : {}),
    ...(typeof e.project === "string" ? { project: e.project } : {}),
    ...(typeof e.neverEvent === "boolean" ? { neverEvent: e.neverEvent } : {}),
    ...(typeof e.neverRule === "string" && /^[a-z0-9-]{1,64}$/.test(e.neverRule) ? { neverRule: e.neverRule } : {}),
    ...(typeof e.importFormat === "string" && TRAIL_IMPORT_FORMATS.has(e.importFormat)
      ? { importFormat: e.importFormat as TrailImportFormat }
      : {}),
    ...(typeof e.packId === "string" ? { packId: e.packId } : {}),
    ...(typeof e.argsHash === "string" ? { argsHash: e.argsHash } : {}),
    ...(typeof e.summary === "string" ? { summary: e.summary } : {}),
    ...(typeof e.diffPreview === "string" ? { diffPreview: e.diffPreview } : {}),
    ...(typeof e.targetPath === "string" ? { targetPath: e.targetPath } : {}),
    ...(nonNegNumber(e.latencyMs) !== undefined
      ? { latencyMs: nonNegNumber(e.latencyMs) }
      : {}),
    ...(nonNegNumber(e.tokensIn) !== undefined
      ? { tokensIn: nonNegNumber(e.tokensIn) }
      : {}),
    ...(nonNegNumber(e.tokensOut) !== undefined
      ? { tokensOut: nonNegNumber(e.tokensOut) }
      : {}),
    ...(typeof e.importedFrom === "string" ? { importedFrom: e.importedFrom } : {}),
    ...(typeof e.sourceHash === "string" ? { sourceHash: e.sourceHash } : {}),
    ...(typeof e.chainVerified === "boolean" ? { chainVerified: e.chainVerified } : {}),
    ...(typeof e.shadow === "boolean" ? { shadow: e.shadow } : {}),
    ...(typeof e.configIgnored === "boolean" ? { configIgnored: e.configIgnored } : {}),
    ...(typeof e.deviceId === "string" && /^[0-9a-f]{16}$/.test(e.deviceId) ? { deviceId: e.deviceId } : {}),
    ...(typeof e.targetClass === "string" && e.targetClass.length <= 128 ? { targetClass: e.targetClass } : {}),
  };
}

/** Usage/latency fields pass only as finite non-negative numbers. */
function nonNegNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** trail.jsonl read cap - oversized files are tail-read (recent events win). */
export const MAX_TRAIL_BYTES = 1024 * 1024;

/** The last `max` bytes of a file, whole lines only. */
function readTailText(path: string, max: number): string {
  const size = statSync(path).size;
  if (size <= max) {
    return readFileSync(path, "utf8");
  }
  const fd = openSync(path, "r");
  let tail: string;
  try {
    const buf = Buffer.alloc(max);
    const position = Math.max(0, size - max);
    const read = readSync(fd, buf, 0, max, position);
    tail = buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  // First line is partial (possibly mid-multibyte) - drop it.
  const nl = tail.indexOf("\n");
  return nl === -1 ? "" : tail.slice(nl + 1);
}

/**
 * Newest MAX_TRAIL_BYTES of the record. Just after a rotation the live file is small, so the rest of
 * the budget comes from the end of the archive: the view does not empty out at each rotation.
 */
function readTrailText(path: string, archive?: string): string {
  const text = existsSync(path) ? readTailText(path, MAX_TRAIL_BYTES) : "";
  const room = MAX_TRAIL_BYTES - Buffer.byteLength(text, "utf8");
  if (!archive || room <= 0 || !existsSync(archive)) return text;
  const older = readTailText(archive, room);
  return older && !older.endsWith("\n") ? `${older}\n${text}` : older + text;
}

/** True when the global or legacy trail file is over the read cap, so a report shows only its newest part. */
export function trailTruncated(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // An archive exists only after the live file reached TRAIL_ROTATE_BYTES, so its events are past the cap.
  if (existsSync(archivedTrailPath(env))) return true;
  for (const path of [globalTrailPath(env), legacyTrailPath(cwd)]) {
    try {
      if (statSync(path).size > MAX_TRAIL_BYTES) return true;
    } catch {
      /* missing file: not truncated */
    }
  }
  return false;
}

function readTrailFile(path: string, archive?: string): TrailEvent[] {
  if (!existsSync(path) && !(archive && existsSync(archive))) return [];
  const lines = readTrailText(path, archive).split("\n").filter(Boolean);
  const out: TrailEvent[] = [];
  for (const line of lines) {
    try {
      const event = parseTrailEvent(JSON.parse(line));
      if (event) out.push(event);
    } catch {
      /* skip bad lines */
    }
  }
  return out;
}

/**
 * Global trail + legacy per-cwd trail (pre-0.3.0 installs), merged and sorted
 * by ts. Unparseable ts sorts last; sort is stable.
 */
export function readTrail(cwd: string, env: NodeJS.ProcessEnv = process.env): TrailEvent[] {
  const globalPath = globalTrailPath(env);
  const legacy = legacyTrailPath(cwd);
  const events = readTrailFile(globalPath, archivedTrailPath(env));
  if (legacy !== globalPath) events.push(...readTrailFile(legacy));
  return sortByTs(events);
}

/**
 * Only the user-level trail (live file + archive, tail-capped like readTrail). Never the per-project
 * legacy trail: a cloned repo can ship its own <project>/.kya/trail.jsonl, so anything that sends
 * data out on the strength of trail rows (incident alerts) must not read it.
 */
export function readGlobalTrail(env: NodeJS.ProcessEnv = process.env): TrailEvent[] {
  return sortByTs(readTrailFile(globalTrailPath(env), archivedTrailPath(env)));
}

function sortByTs(events: TrailEvent[]): TrailEvent[] {
  return events
    .map((event, i) => ({ event, i, t: Date.parse(event.ts) }))
    .sort((a, b) => {
      const ta = Number.isNaN(a.t) ? Number.POSITIVE_INFINITY : a.t;
      const tb = Number.isNaN(b.t) ? Number.POSITIVE_INFINITY : b.t;
      return ta === tb ? a.i - b.i : ta - tb;
    })
    .map(({ event }) => event);
}

/** Events with ts >= since (ISO or Date). Invalid ts kept if unparseable. */
export function readTrailSince(
  cwd: string,
  since: Date,
  env: NodeJS.ProcessEnv = process.env,
): TrailEvent[] {
  return eventsSince(readTrail(cwd, env), since);
}

/** Same filter as readTrailSince, for events already read. */
export function eventsSince(events: readonly TrailEvent[], since: Date): TrailEvent[] {
  const sinceMs = since.getTime();
  return events.filter((e) => {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) return true;
    return t >= sinceMs;
  });
}

/** Changes when either trail file readTrail reads is written, replaced or removed. */
export function trailVersion(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const globalPath = globalTrailPath(env);
  const legacy = legacyTrailPath(cwd);
  const paths = legacy === globalPath ? [globalPath] : [globalPath, legacy];
  return paths
    .map((p) => {
      try {
        const st = statSync(p);
        return `${st.ino}:${st.size}:${st.mtimeMs}`;
      } catch {
        return "-";
      }
    })
    .join("|");
}

export function defaultSessionId(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.KYA_SESSION_ID?.trim() ||
    env.CURSOR_SESSION_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    `local-${new Date().toISOString().slice(0, 10)}`
  );
}
