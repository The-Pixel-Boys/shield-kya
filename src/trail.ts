/**
 * Local session trail (JSONL). Observe path — not a second PEP.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";

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

export function trailPath(cwd: string): string {
  return join(configDir(cwd), "trail.jsonl");
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

export function appendTrail(cwd: string, event: TrailEvent): void {
  const dir = configDir(cwd);
  mkdirSync(dir, { recursive: true });
  const enriched: TrailEvent = {
    ...event,
    product: event.product ?? detectProduct(process.env, event.host),
  };
  appendFileSync(trailPath(cwd), `${JSON.stringify(enriched)}\n`, "utf8");
}

export function readTrail(cwd: string): TrailEvent[] {
  const path = trailPath(cwd);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const out: TrailEvent[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as TrailEvent);
    } catch {
      /* skip bad lines */
    }
  }
  return out;
}

/** Events with ts >= since (ISO or Date). Invalid ts kept if unparseable. */
export function readTrailSince(cwd: string, since: Date): TrailEvent[] {
  const sinceMs = since.getTime();
  return readTrail(cwd).filter((e) => {
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
