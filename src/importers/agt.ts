/**
 * `kya import --from agt`: ingest the audit log written by Microsoft Agent
 * Governance Toolkit's Claude Code plugin (default ~/.claude/agt/audit-log.json)
 * so KYA is the report-and-proof layer on top of AGT enforcement.
 *
 * AGT entries are `{timestamp, agentId, action, decision, previousHash, hash}`
 * with NO tool arguments, so imported events carry no args, argsHash, diff or
 * target path - only the decision, tool name and session. The log is either a
 * bare array (anchored to a zero genesis hash) or `{seamHash, entries}` after
 * AGT rolled over its 10,000-entry cap.
 *
 * The chain is verified like AGT's own verifier (unkeyed SHA-256 over
 * `{timestamp, agentId, action, decision, previousHash}`). A broken chain is a
 * warning with the first bad index; every event from that file is imported with
 * `chainVerified: false`. A file that is not valid JSON or has the wrong shape
 * imports nothing. Re-imports are idempotent: rows already in the trail with
 * the same AGT entry hash are skipped.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendTrail, globalTrailPath, type TrailEvent } from "../trail.js";
import { redactTrailText } from "../trail-summary.js";
import type { ImportResult } from "./index.js";

const GENESIS_HASH = "0".repeat(64);
const MAX_TOOL_ID_LEN = 160;
const MAX_SESSION_ID_LEN = 160;
/** AGT names agents `claude-code:<session_id>`. */
const AGENT_PREFIX = "claude-code:";

/** Override AGT itself honours for its audit path. */
export const AGT_AUDIT_PATH_ENV = "AGT_CLAUDE_AUDIT_PATH";

export function defaultAgtAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[AGT_AUDIT_PATH_ENV] || join(homedir(), ".claude", "agt", "audit-log.json");
}

type KyaVerdict = "ALLOW" | "DENY" | "REQUIRE_APPROVE";

/** AGT writes allow|deny|review (lib/audit.mjs); "ask" is the hook-side name for review. */
const DECISIONS: ReadonlyMap<string, KyaVerdict> = new Map<string, KyaVerdict>([
  ["allow", "ALLOW"],
  ["deny", "DENY"],
  ["review", "REQUIRE_APPROVE"],
  ["ask", "REQUIRE_APPROVE"],
]);

/** Entries dated outside [2000-01-01, now + 1 day] are rejected as malformed. */
const MIN_TS_MS = Date.UTC(2000, 0, 1);
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
/** AGT writes Date#toISOString(); anything else is not an AGT timestamp. */
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Control chars (incl. ESC, NUL, newlines) become spaces; whitespace collapses. */
function cleanText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

export type ChainResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly index: number; readonly reason: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function entryHash(e: Record<string, unknown>): string {
  // Key order is part of the hash input: it must match AGT's computeHash exactly.
  return createHash("sha256")
    .update(
      JSON.stringify({
        timestamp: e.timestamp,
        agentId: e.agentId,
        action: e.action,
        decision: e.decision,
        previousHash: e.previousHash,
      }),
    )
    .digest("hex");
}

/** Mirror of AGT's verifyAuditEntries, but reports the first bad index instead of a boolean. */
export function verifyAgtChain(entries: readonly unknown[], seamHash: string | null): ChainResult {
  let prev = seamHash ?? GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isObj(e)) return { ok: false, index: i, reason: "entry is not an object" };
    if (e.previousHash !== prev) {
      return { ok: false, index: i, reason: "previousHash does not match the preceding entry" };
    }
    if (typeof e.hash !== "string" || e.hash !== entryHash(e)) {
      return { ok: false, index: i, reason: "hash does not match the entry content" };
    }
    prev = e.hash;
  }
  return { ok: true };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Seen {
  /** Keys with at least one imported row. */
  readonly any: Set<string>;
  /** Keys with a row imported as chainVerified=true. */
  readonly verified: Set<string>;
}

/** Imported AGT rows by key (full scan: readTrail is tail-capped at 1MB). */
function importedAgtHashes(env: NodeJS.ProcessEnv): Seen {
  const seen: Seen = { any: new Set(), verified: new Set() };
  const path = globalTrailPath(env);
  if (!existsSync(path)) return seen;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"importedFrom":"agt"')) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e.importedFrom !== "agt" || typeof e.sourceHash !== "string") continue;
      seen.any.add(e.sourceHash);
      if (e.chainVerified === true) seen.verified.add(e.sourceHash);
    } catch {
      /* skip bad lines */
    }
  }
  return seen;
}

type Mapped =
  | { readonly ok: true; readonly event: TrailEvent; readonly fallback: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Map one entry. The dedupe key / sourceHash is the hash RECOMPUTED from the
 * entry content with AGT's formula, never the stored `hash` field: a stored
 * hash that does not match its content marks the entry tampered
 * (chainVerified=false) and cannot squat the key of the genuine entry.
 */
function mapEntry(raw: unknown, chainOk: boolean, nowMs: number): Mapped {
  if (!isObj(raw)) return { ok: false, error: "not an object" };
  const { timestamp, agentId, action, decision, hash } = raw;
  if (typeof action !== "string" || !cleanText(action)) return { ok: false, error: "missing action" };
  if (typeof agentId !== "string" || !cleanText(agentId)) return { ok: false, error: "missing agentId" };
  if (typeof hash !== "string" || !HEX64.test(hash)) {
    return { ok: false, error: "hash is not 64 lowercase hex characters" };
  }
  const verdict = typeof decision === "string" ? DECISIONS.get(decision.toLowerCase()) : undefined;
  if (!verdict) return { ok: false, error: `unknown decision ${JSON.stringify(String(decision).slice(0, 40))}` };
  const t = typeof timestamp === "string" && ISO_TS.test(timestamp) ? Date.parse(timestamp) : NaN;
  if (Number.isNaN(t)) return { ok: false, error: "missing or invalid timestamp" };
  if (t < MIN_TS_MS || t > nowMs + FUTURE_SLACK_MS) {
    return { ok: false, error: "timestamp outside 2000-01-01 .. now+1d" };
  }

  const act = cleanText(action);
  const toolId = (act.startsWith("tool.") ? act.slice("tool.".length) : act).trim().slice(0, MAX_TOOL_ID_LEN);
  const agent = cleanText(agentId);
  const session = (agent.startsWith(AGENT_PREFIX) ? agent.slice(AGENT_PREFIX.length) : agent)
    .trim()
    .slice(0, MAX_SESSION_ID_LEN);
  // Genuine AGT entries can have an empty tool ("tool.") or session ("claude-code:"
  // with an empty session_id): keep the decision, label the gap, and count it.
  const recomputed = entryHash(raw);
  return {
    ok: true,
    fallback: !toolId || !session,
    event: {
      ts: new Date(t).toISOString(),
      sessionId: session || "unknown-session",
      host: "import",
      toolId: toolId || "unknown-tool",
      verdict,
      reasonCode: `IMPORTED_AGT_${verdict === "REQUIRE_APPROVE" ? "REVIEW" : verdict}`,
      mode: "observe",
      summary: cleanText(redactTrailText(`AGT decision for ${toolId || "unknown-tool"}`)),
      importedFrom: "agt",
      sourceHash: recomputed,
      chainVerified: chainOk && recomputed === hash,
    },
  };
}

export interface AgtImportOptions {
  /** Path, for messages only. */
  readonly file: string;
  /** File content, already read under the shared size cap and file-type rules. */
  readonly text: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Import one AGT audit log. Returns errors (never throws) on a bad or unreadable file. */
export function importAgt(opts: AgtImportOptions): ImportResult {
  const { file, text, cwd } = opts;
  const env = opts.env ?? process.env;
  const fail = (msg: string): ImportResult => ({ imported: 0, skipped: 0, errors: [msg] });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return fail(`${file} is not valid JSON - ${errMsg(e)}; nothing imported`);
  }

  let entries: unknown[];
  let seam: string | null = null;
  if (Array.isArray(json)) {
    entries = json;
  } else if (isObj(json) && Array.isArray(json.entries)) {
    entries = json.entries;
    seam = typeof json.seamHash === "string" ? json.seamHash : null;
  } else {
    return fail(
      `${file} is not an AGT audit log (expected an array or {seamHash, entries}); nothing imported`,
    );
  }

  const warnings: string[] = [];
  const chain = verifyAgtChain(entries, seam);
  if (!chain.ok) {
    warnings.push(
      `hash chain broken at entry index ${chain.index} (0-based): ${chain.reason}; ` +
        `imported events are flagged chainVerified=false`,
    );
  }

  let seen: Seen;
  try {
    seen = importedAgtHashes(env);
  } catch (e) {
    return fail(`cannot read the existing trail - ${errMsg(e)}; nothing imported`);
  }
  const nowMs = Date.now();
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;
  let duplicates = 0;
  let fallbacks = 0;
  for (let i = 0; i < entries.length; i++) {
    const mapped = mapEntry(entries[i], chain.ok, nowMs);
    if (!mapped.ok) {
      skipped++;
      errors.push(`record ${i + 1}: ${mapped.error}`);
      continue;
    }
    const hash = mapped.event.sourceHash!;
    // A verified row is never blocked by an earlier unverified one (forged-first import).
    const dup =
      seen.verified.has(hash) || (mapped.event.chainVerified !== true && seen.any.has(hash));
    if (dup) {
      skipped++;
      duplicates++;
      continue;
    }
    try {
      appendTrail(cwd, mapped.event, env);
      seen.any.add(hash);
      if (mapped.event.chainVerified === true) seen.verified.add(hash);
      imported++;
      if (mapped.fallback) fallbacks++;
    } catch (e) {
      skipped++;
      errors.push(`record ${i + 1}: trail append failed - ${errMsg(e)}`);
    }
  }

  if (fallbacks > 0) {
    warnings.push(
      `${fallbacks} imported entr${fallbacks === 1 ? "y has" : "ies have"} an empty tool name or session id ` +
        `(labelled unknown-tool / unknown-session)`,
    );
  }
  return { imported, skipped, errors, warnings, duplicates };
}
