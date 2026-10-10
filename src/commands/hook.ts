/**
 * kya hook - PreToolUse interception for hosts with native hooks
 * (Claude Code, Grok, Kimi Code). Offline local evaluate only: no network,
 * sub-second, fail-open on any internal error unless --fail-closed (hosted).
 * DENY (local never-list) blocks; REQUIRE_APPROVE records advisory unless
 * --strict.
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir, resolveConfig } from "../config.js";
import type { PolicyEvaluateResponse } from "../client.js";
import { runEvalTool } from "./eval-tool.js";
import { appendTrail, defaultSessionId, hostToProduct } from "../trail.js";
import { deriveWireChangeFields } from "../diff-preview.js";
import { matchesNeverList } from "../offline-evaluate.js";
import { maybeSpawnNotifyFlush } from "../notify/dispatch.js";

export interface HookInput {
  readonly host: string;
  readonly strict: boolean;
  /** Hosted mode: any internal error, timeout or bad payload denies (exit 2). Default is fail-open. */
  readonly failClosed?: boolean;
  /** Test seam: evaluate budget in ms in fail-closed mode (default 4000, under the host's 5 s hook timeout). */
  readonly evalTimeoutMs?: number;
  readonly stdinText: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Test seam - defaults to the offline runEvalTool path. */
  readonly evaluate?: (toolId: string, args: unknown) => Promise<PolicyEvaluateResponse>;
}

export interface HookResult {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly stderr: string;
  /** False when another hook copy already recorded this tool_use_id (skip detached pings too). */
  readonly firstSeen?: boolean;
}

interface HookPayload {
  readonly event?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly toolName?: string;
  readonly toolUseId?: string;
  readonly toolInput?: unknown;
  /** Real usage reported by the host, when present. Never fabricated. */
  readonly usage?: HookUsage;
}

interface HookUsage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

function tokenCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : undefined;
}

/** Accept input_tokens/output_tokens (Claude/Kimi) and inputTokens/outputTokens. */
function readUsageShape(raw: unknown): HookUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = raw as Record<string, unknown>;
  const tokensIn = tokenCount(u.input_tokens ?? u.inputTokens);
  const tokensOut = tokenCount(u.output_tokens ?? u.outputTokens);
  if (tokensIn === undefined && tokensOut === undefined) return undefined;
  return {
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
  };
}

/** Accept snake_case (Claude/Kimi) and camelCase (Grok) envelopes. */
function parsePayload(stdinText: string): HookPayload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdinText);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const event =
    (typeof p.hook_event_name === "string" && p.hook_event_name) ||
    (typeof p.hookEventName === "string" && p.hookEventName) ||
    undefined;
  const toolResponse =
    p.tool_response && typeof p.tool_response === "object" && !Array.isArray(p.tool_response)
      ? (p.tool_response as Record<string, unknown>)
      : p.toolResponse && typeof p.toolResponse === "object" && !Array.isArray(p.toolResponse)
        ? (p.toolResponse as Record<string, unknown>)
        : undefined;
  return {
    event,
    sessionId:
      (typeof p.session_id === "string" && p.session_id) ||
      (typeof p.sessionId === "string" && p.sessionId) ||
      undefined,
    cwd: typeof p.cwd === "string" ? p.cwd : undefined,
    toolName:
      (typeof p.tool_name === "string" && p.tool_name) ||
      (typeof p.toolName === "string" && p.toolName) ||
      undefined,
    toolUseId:
      (typeof p.tool_use_id === "string" && p.tool_use_id) ||
      (typeof p.toolUseId === "string" && p.toolUseId) ||
      undefined,
    toolInput: p.tool_input ?? p.toolInput,
    usage: readUsageShape(p.usage) ?? readUsageShape(toolResponse?.usage),
  };
}

const ALLOW: HookResult = { exitCode: 0, stdout: "", stderr: "" };

function deny(reason: string): HookResult {
  return {
    exitCode: 2,
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
    stderr: `${reason}\n`,
  };
}

const SEEN_TTL_MS = 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;
const MARKER_NAME = /^[0-9a-f]{64}$/;

/**
 * Atomic once-per-call claim for side effects (trail, notify, ping), so a
 * user-level hook and a plugin hook for the same call record once. Verdicts are
 * still computed by every copy. Any filesystem problem, or a marker dir that is
 * not a real directory owned by this user, counts as "first seen" (today's
 * behavior: record). Markers older than 24 h are pruned at most hourly, and
 * only regular files named like a marker are ever unlinked.
 * The key includes session_id when present: ids may repeat across sessions/hosts.
 */
function claimToolUse(toolUseId: string, sessionId: string | undefined, env: NodeJS.ProcessEnv): boolean {
  const dir = join(globalConfigDir(env), "hook-seen");
  try {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return true; }
    const st = lstatSync(dir);
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) return true;
    // JSON array so ("a:b","c") and ("a","b:c") cannot collide.
    const key = sessionId ? JSON.stringify([sessionId, toolUseId]) : toolUseId;
    try {
      closeSync(openSync(join(dir, createHash("sha256").update(key).digest("hex")), "wx"));
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "EEXIST";
    }
    const stamp = join(dir, ".pruned");
    let last = 0;
    let stampOk = true;
    try {
      const ss = lstatSync(stamp);
      stampOk = ss.isFile();
      last = ss.mtimeMs;
    } catch { /* first run */ }
    if (stampOk && Date.now() - last > PRUNE_EVERY_MS) {
      writeFileSync(stamp, "");
      utimesSync(stamp, new Date(), new Date());
      for (const f of readdirSync(dir)) {
        if (!MARKER_NAME.test(f)) continue;
        try {
          const fs = lstatSync(join(dir, f));
          if (fs.isFile() && Date.now() - fs.mtimeMs > SEEN_TTL_MS) unlinkSync(join(dir, f));
        } catch { /* raced with another pruner */ }
      }
    }
  } catch { /* marker trouble never fails the hook; record as before */ }
  return true;
}

// ponytail: this timer cannot preempt the synchronous offline evaluate, config
// read or trail write. The host's own 5 s limit is only enforced as a block when
// the hosted plugin hook sets "onFailure": "block"; this timer covers async
// (injected or future HTTP) evaluators only.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("KYA evaluate timed out")), ms); }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Deny with a best-effort audit row and notify, so a block caused by an internal
 * error is not invisible. Never throws. FAIL_CLOSED rows are deliberately NOT
 * deduped by the tool_use_id claim: the other hook copy may have recorded an
 * ALLOW, and the trail must also show that this copy blocked the call.
 */
function auditedDeny(
  reason: string,
  reasonCode: "FAIL_CLOSED" | "NEVER_EVENT",
  input: HookInput,
  payload?: HookPayload,
  dedupe = false,
): HookResult {
  try {
    // Only for NEVER_EVENT: every hook copy reaches the same never-list verdict,
    // so the claim only collapses duplicate rows/notifies and never the verdict.
    if (dedupe && payload?.toolUseId && !claimToolUse(payload.toolUseId, payload.sessionId, input.env)) {
      return deny(reason);
    }
    const trailCwd = payload?.cwd?.trim() || input.cwd;
    const ev = {
      ts: new Date().toISOString(),
      sessionId: payload?.sessionId ?? defaultSessionId(input.env),
      host: "ide",
      product: hostToProduct(input.host),
      toolId: payload?.toolName ?? "unknown",
      verdict: "DENY",
      reasonCode,
      mode: "offline" as const,
      neverEvent: reasonCode === "NEVER_EVENT",
    };
    try { appendTrail(trailCwd, ev, input.env); } catch { /* audit is best effort */ }
    maybeSpawnNotifyFlush({ env: input.env, cwd: trailCwd, event: ev });
  } catch { /* never block the deny itself */ }
  return deny(reason);
}

// Non-PreToolUse hook events that legitimately carry no gate decision.
const OTHER_EVENT = /^(post[_-]?tool[_-]?use.*|stop|subagent[_-]?(start|stop)|permission[_-]?request|elicitation.*|session[_-]?(start|end)|user[_-]?prompt[_-]?submit|notification|pre[_-]?compact)$/i;

export async function runHook(input: HookInput): Promise<HookResult> {
  let payload: HookPayload | undefined;
  try {
    payload = parsePayload(input.stdinText);
    if (!payload) {
      return input.failClosed ? auditedDeny("KYA fail-closed: unreadable hook payload", "FAIL_CLOSED", input) : ALLOW;
    }
    const isPre = !payload.event || /^(PreToolUse|pre[_-]tool[_-]use)$/i.test(payload.event);
    // Fail-closed: an event name we do not recognize is evaluated, not waved through.
    if (!isPre && (!input.failClosed || OTHER_EVENT.test(payload.event ?? ""))) return ALLOW;
    if (!payload.toolName) {
      return input.failClosed ? auditedDeny("KYA fail-closed: hook payload has no tool_name", "FAIL_CLOSED", input, payload) : ALLOW;
    }
    const toolName = payload.toolName;

    // A bad host in env or .kya/config.json must not swallow a never-list match:
    // retry with the default host forced, so DENY blocks in both modes.
    const resolve = (flags: Record<string, string>) =>
      resolveConfig({
        cwd: input.cwd,
        env: input.env,
        flags,
        allowMissingApiKey: true,
        requireApiKey: false,
        offline: true,
      });
    let config;
    try {
      config = resolve({});
    } catch (e) {
      if (input.failClosed) throw e;
      config = resolve({ host: "ide" });
    }
    const cfg = config;
    const evaluate =
      input.evaluate ??
      (async (toolId: string, args: unknown) =>
        (await runEvalTool(cfg, { toolId, args, offline: true })).response);
    const evaluating = Promise.resolve().then(() => evaluate(toolName, payload?.toolInput ?? {}));
    const response = input.failClosed
      ? await withTimeout(evaluating, input.evalTimeoutMs ?? 4000)
      : await evaluating;

    // The verdict exists: nothing below may lose a DENY, so side-effect errors
    // are contained here and never reach the outer catch.
    let firstSeen = true;
    try {
      // payload.cwd is host-supplied and only feeds the project-basename stamp;
      // the trail path itself comes from env/KYA_HOME - no traversal risk.
      const trailCwd = payload.cwd?.trim() || input.cwd;
      // Wire change fields (summary, diffPreview, targetPath) feed the receipt's
      // Changes tab; redaction + opt-out live inside deriveWireChangeFields.
      const changeFields = deriveWireChangeFields(toolName, payload.toolInput ?? {}, input.env);
      const trailEvent = {
        ts: new Date().toISOString(),
        sessionId: payload.sessionId ?? defaultSessionId(input.env),
        host: cfg.host,
        product: hostToProduct(input.host),
        toolId: response.toolId ?? toolName,
        verdict: response.verdict,
        reasonCode: response.reasonCode ?? "",
        mode: "offline" as const,
        neverEvent: response.reasonCode === "NEVER_EVENT",
        argsHash: response.argsHash,
        ...(changeFields ?? {}),
        ...(payload.usage?.tokensIn !== undefined ? { tokensIn: payload.usage.tokensIn } : {}),
        ...(payload.usage?.tokensOut !== undefined ? { tokensOut: payload.usage.tokensOut } : {}),
      };
      firstSeen = payload.toolUseId ? claimToolUse(payload.toolUseId, payload.sessionId, input.env) : true;
      if (firstSeen) {
        try {
          appendTrail(trailCwd, trailEvent, input.env);
        } catch {
          /* observe path never breaks the gate */
        }
        // Webhooks + OTLP export ride a detached helper; the hook never waits on
        // the network. No-op unless a sink is configured.
        maybeSpawnNotifyFlush({ env: input.env, cwd: trailCwd, event: trailEvent });
      }
    } catch {
      /* observe path never breaks the gate */
    }

    if (response.verdict === "DENY") {
      return { ...deny(`KYA denied ${toolName}: ${response.reasonCode}`), firstSeen };
    }
    if (input.strict && response.verdict === "REQUIRE_APPROVE") {
      return { ...deny(`KYA strict mode: ${toolName} requires approval (${response.reasonCode})`), firstSeen };
    }
    return { ...ALLOW, firstSeen };
  } catch {
    // Default fail-open: hook errors must never block the user's agent, with one
    // exception: the never-list depends on the tool name only, so it still blocks
    // when config parsing, arg hashing or anything else threw (a repo-shipped
    // .kya/config.json or a deeply nested tool_input must not disable it).
    // --fail-closed (hosted): enforcement must not silently lapse.
    try {
      // A never-list tool is logged as such in both modes (hosted counts stay right).
      if (payload?.toolName && matchesNeverList(payload.toolName)) {
        return auditedDeny(`KYA denied ${payload.toolName}: NEVER_EVENT`, "NEVER_EVENT", input, payload, true);
      }
    } catch { /* fall through */ }
    if (input.failClosed) {
      return auditedDeny("KYA fail-closed: internal error, tool call denied", "FAIL_CLOSED", input, payload);
    }
    return ALLOW;
  }
}
