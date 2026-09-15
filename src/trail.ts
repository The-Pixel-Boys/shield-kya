/**
 * Local session trail (JSONL). Observe path — not a second PEP.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { configDir, globalConfigDir } from "./config.js";

export type TrailProduct =
  | "cursor"
  | "claude"
  | "codex"
  | "grok"
  | "ide"
  | "runtime"
  | "other";

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
  readonly packId?: string;
  readonly argsHash?: string;
  /** Short redacted change line for the activity feed (never raw args). */
  readonly summary?: string;
  /** Clipped redacted change preview (never full patch). */
  readonly diffPreview?: string;
}

export function globalTrailPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "trail.jsonl");
}

/** Pre-0.3.0 per-project trail location, still merged on read. */
export function legacyTrailPath(cwd: string): string {
  return join(configDir(cwd), "trail.jsonl");
}

/** The trail is global since 0.3.0 — one file for all projects. */
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
    case "grok":
      return "Grok";
    case "ide":
      return "IDE";
    case "runtime":
      return "Runtime";
    default:
      return "Other";
  }
}

export function appendTrail(
  cwd: string,
  event: TrailEvent,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(globalConfigDir(env), { recursive: true });
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
  "grok",
  "ide",
  "runtime",
  "other",
]);

/**
 * Validate one parsed JSONL line against the TrailEvent shape. Untrusted
 * fields (wrong type, unknown mode/product) drop the line or the field —
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
    ...(typeof e.packId === "string" ? { packId: e.packId } : {}),
    ...(typeof e.argsHash === "string" ? { argsHash: e.argsHash } : {}),
    ...(typeof e.summary === "string" ? { summary: e.summary } : {}),
    ...(typeof e.diffPreview === "string" ? { diffPreview: e.diffPreview } : {}),
  };
}

/** trail.jsonl read cap — oversized files are tail-read (recent events win). */
export const MAX_TRAIL_BYTES = 1024 * 1024;

function readTrailText(path: string): string {
  const size = statSync(path).size;
  if (size <= MAX_TRAIL_BYTES) {
    return readFileSync(path, "utf8");
  }
  const fd = openSync(path, "r");
  let tail: string;
  try {
    const buf = Buffer.alloc(MAX_TRAIL_BYTES);
    const position = Math.max(0, size - MAX_TRAIL_BYTES);
    const read = readSync(fd, buf, 0, MAX_TRAIL_BYTES, position);
    tail = buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  // First line is partial (possibly mid-multibyte) — drop it.
  const nl = tail.indexOf("\n");
  return nl === -1 ? "" : tail.slice(nl + 1);
}

function readTrailFile(path: string): TrailEvent[] {
  if (!existsSync(path)) return [];
  const lines = readTrailText(path).split("\n").filter(Boolean);
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
  const events = readTrailFile(globalPath);
  if (legacy !== globalPath) events.push(...readTrailFile(legacy));
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
  const sinceMs = since.getTime();
  return readTrail(cwd, env).filter((e) => {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) return true;
    return t >= sinceMs;
  });
}

export function defaultSessionId(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.KYA_SESSION_ID?.trim() ||
    env.CURSOR_SESSION_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    `local-${new Date().toISOString().slice(0, 10)}`
  );
}
