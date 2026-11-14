/**
 * The kya-guard plugin core (plugins/kya-guard). The lean sibling of `kya hook`: Claude Code PreToolUse in, verdict out,
 * one row appended to ~/.kya/trail.jsonl. Bundled into plugins/kya-guard/dist/guard.mjs by scripts/build-guard.mjs.
 *
 * Same rules, same verdicts and same deny and ask text as src/commands/hook.ts, because it calls the same functions
 * (evaluateOffline, guardPackMatch, neverListInputMatch). What it leaves out on purpose: the hosted plane, notify and
 * OTLP, the update check, the IoC scan, usage ping, the dual-hook dedupe markers, the device salt and trail rotation.
 * It imports no network module and no child process module (test/guard-bundle.test.ts enforces that on the bundle).
 * Its only write while it guards is one append to the trail file (`--card`, started by the person, also writes one SVG). Any internal error lets the call through and leaves an `error` row.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { basename } from "node:path";
import { eventIdOf, formatCard, pickNearMiss, recentNearMiss, ruleLabel, writeCardSvg } from "./card.js";
import { computeArgsHash } from "./hash.js";
import { deriveWireChangeFields } from "./diff-preview.js";
import { GUARD_DEFAULTS, GUARD_SHELL_RULES, guardContextFrom, guardHint, guardPackMatch, readGuardConfig } from "./guard-pack.js";
import { isNeverCode } from "./never-code.js";
import { NEVER_LIST_INPUT_RULES, neverListInputMatch } from "./never-list-input.js";
import { evaluateOffline, matchesNeverList } from "./offline-evaluate.js";
import { loadProjectPolicy } from "./project-policy.js";
import { findSampleTool } from "./sample-tools.js";
import { defaultSessionId, globalTrailPath, hostToProduct, readGlobalTrail, type TrailEvent, type TrailOutcome, type TrailProduct } from "./trail.js";

export interface GuardInput {
  readonly stdinText: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Host id from `--host`: claude (default), codex, cursor, copilot or gemini. Sets the payload reading and the deny shape. */
  readonly host?: string;
}

/** Hosts the guard speaks. Any other id gets the Claude-shaped deny and no ask. */
export const GUARD_HOSTS = ["claude", "codex", "cursor", "copilot", "gemini"] as const;
const hostId = (h: string | undefined): string => (h ?? "claude").trim().toLowerCase() || "claude";

export interface GuardResult {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

interface Payload {
  readonly event?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
}

const ALLOW: GuardResult = { exitCode: 0, stdout: "", stderr: "" };
const GUARD_ASK = "GUARD_ASK";
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Hook envelopes of every host: Claude Code, Codex and Cursor (snake_case), Copilot CLI (camelCase, `toolArgs` can be a
 * JSON string), Gemini CLI (`BeforeTool`, MCP tools named in `mcp_context`). Same reading as src/commands/hook.ts.
 * Undefined when the text is not a JSON object with a tool name.
 */
function parsePayload(text: string): Payload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const event = str(p.hook_event_name) ?? str(p.hookEventName);
  const mcp = p.mcp_context && typeof p.mcp_context === "object" && !Array.isArray(p.mcp_context) ? (p.mcp_context as Record<string, unknown>) : undefined;
  const geminiMcp = /^BeforeTool$/i.test(event ?? "") && str(mcp?.server_name) && str(mcp?.tool_name) ? `mcp__${str(mcp?.server_name)}__${str(mcp?.tool_name)}` : undefined;
  const toolName = geminiMcp ?? str(p.tool_name) ?? str(p.toolName);
  if (!toolName) return undefined;
  return { event, sessionId: str(p.session_id) ?? str(p.sessionId), cwd: str(p.cwd), toolName, toolInput: p.tool_input ?? p.toolInput ?? parseToolArgs(p.toolArgs) };
}

/** Copilot sends `toolArgs` as a JSON string. A string that does not parse stays a string, so the input rules fail open on it. */
function parseToolArgs(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Each host reads its own deny body. Exit 2 blocks on all of them; the body carries the reason the agent sees. */
function deny(reason: string, host: string): GuardResult {
  const claude = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason };
  const body =
    host === "gemini" ? { decision: "deny", reason }
    : host === "cursor" ? { permission: "deny", user_message: reason, agent_message: reason }
    : host === "copilot" ? { permissionDecision: "deny", permissionDecisionReason: reason, hookSpecificOutput: claude }
    : { hookSpecificOutput: claude };
  return { exitCode: 2, stdout: `${JSON.stringify(body)}\n`, stderr: `${reason}\n` };
}

function ask(reason: string): GuardResult {
  const body = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } };
  return { exitCode: 0, stdout: `${JSON.stringify(body)}\n`, stderr: "" };
}

/** Same text as hook.ts denyReason. Never carries command text, a path or a matched secret. */
function denyReason(toolName: string, reasonCode: string, ruleId?: string): string {
  if (reasonCode === "NEVER_EVENT" && ruleId) {
    return `KYA denied ${toolName}: NEVER_EVENT (rule ${ruleId}; never-list rules cannot be overridden)`;
  }
  if ((isNeverCode(reasonCode) || reasonCode === GUARD_ASK) && reasonCode !== "NEVER_EVENT" && ruleId) {
    const hint = guardHint(ruleId);
    return `KYA denied ${toolName}: ${reasonCode} (${ruleId}).${hint ? ` ${hint}` : ""} Ask the user; see docs/guard-pack.md.`;
  }
  return `KYA denied ${toolName}: ${reasonCode}`;
}

function askReason(toolName: string, ruleId: string | undefined): string {
  const hint = ruleId ? guardHint(ruleId) : "";
  return `KYA asks before ${toolName}: ${GUARD_ASK}${ruleId ? ` (${ruleId})` : ""}.${hint ? ` ${hint}` : ""} See docs/guard-pack.md.`;
}

/** The one write: append a JSON line to ~/.kya/trail.jsonl, same shape as appendTrail. No rotation, no salt file, no lock. */
function record(cwd: string, ev: TrailEvent, env: NodeJS.ProcessEnv): void {
  const path = globalTrailPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ...ev, project: ev.project ?? basename(cwd) })}\n`, "utf8");
}

/** Row for a call the guard did not judge. Returns the fail-open result; a failed write is said once on stderr. */
function failOpen(input: GuardInput, p: Payload | undefined, summary: string): GuardResult {
  const product = hostToProduct(hostId(input.host));
  try {
    record(p?.cwd ?? input.cwd, {
      ts: new Date().toISOString(),
      sessionId: p?.sessionId ?? defaultSessionId(input.env),
      host: "ide",
      product,
      toolId: p?.toolName ?? "unknown",
      verdict: "ALLOW",
      outcome: "error",
      reasonCode: "HOOK_ERROR",
      mode: "offline",
      summary,
    }, input.env);
    return ALLOW;
  } catch {
    return { ...ALLOW, stderr: "KYA guard: error recording a failed hook call (the call was let through)\n" };
  }
}

/** Evaluate one hook call. Synchronous; never throws. */
export function runGuard(input: GuardInput): GuardResult {
  const started = Date.now();
  const host = hostId(input.host);
  const product: TrailProduct = hostToProduct(host);
  let payload: Payload | undefined;
  try {
    payload = parsePayload(input.stdinText);
    if (!payload) return failOpen(input, undefined, "unreadable hook payload; the call was let through (fail-open)");
    // The plugins declare PreToolUse (BeforeTool on Gemini) only; any other event carries no gate decision.
    if (payload.event && !/^(PreToolUse|pre[_-]tool[_-]use|BeforeTool)$/i.test(payload.event)) return ALLOW;
    const toolName = payload.toolName as string;
    const cwd = payload.cwd && isAbsolute(payload.cwd) ? payload.cwd : input.cwd;
    const guard = guardContextFrom(cwd, input.env);

    // Same steps as runEvalTool offline: the sample tool decides irreversible and action class.
    const sample = findSampleTool(toolName);
    const args = payload.toolInput ?? {};
    const argsHash = computeArgsHash(args);
    const response = evaluateOffline(
      {
        toolId: toolName,
        action: toolName,
        argsHash,
        irreversible: sample?.irreversible ?? false,
        sessionRisk: "LOW",
        approvalStatus: "NONE",
        env: { host: "ide" },
        ...(sample?.actionClass !== undefined ? { actionClass: sample.actionClass, dataClass: sample.dataClass } : {}),
      },
      "ide",
      args,
      loadProjectPolicy(cwd, () => undefined),
      guard,
    );

    // Only Claude Code has an ask this guard relies on: on every other host an ask rule is a deny (same as hook.ts askMode).
    const isAsk = response.reasonCode === GUARD_ASK && host === "claude";
    const askAsDeny = response.reasonCode === GUARD_ASK && !isAsk;
    const outcome: TrailOutcome = isAsk ? "held" : response.verdict === "DENY" || askAsDeny ? "blocked" : "ran";
    try {
      // A secret-shaped write is denied because its text is a secret: no preview of that text reaches the trail.
      const change = response.reasonCode === "NEVER_SECRET_WRITE" ? undefined : deriveWireChangeFields(toolName, args, input.env);
      record(cwd, {
        ts: new Date().toISOString(),
        sessionId: payload.sessionId ?? defaultSessionId(input.env),
        host: "ide",
        product,
        toolId: response.toolId ?? toolName,
        verdict: response.verdict,
        outcome,
        reasonCode: response.reasonCode ?? "",
        mode: "offline",
        neverEvent: isNeverCode(response.reasonCode),
        ...(response.ruleId ? { neverRule: response.ruleId } : {}),
        argsHash: response.argsHash,
        latencyMs: Date.now() - started,
        ...(change ?? {}),
      }, input.env);
    } catch {
      /* the trail never decides the verdict */
    }

    if (response.verdict === "DENY" || askAsDeny) return deny(denyReason(toolName, response.reasonCode, response.ruleId), host);
    if (isAsk) return ask(askReason(toolName, response.ruleId));
    return ALLOW;
  } catch {
    // Same stance as hook.ts: the never-list and the guard pack with its defaults still block when the evaluator broke.
    try {
      if (payload?.toolName) {
        const cwd = payload.cwd && isAbsolute(payload.cwd) ? payload.cwd : input.cwd;
        const inputHit = neverListInputMatch(payload.toolName, payload.toolInput, undefined, cwd);
        const hit = inputHit ?? (matchesNeverList(payload.toolName) ? { rule: undefined } : undefined);
        const guardHit = hit ? undefined : guardPackMatch(payload.toolName, payload.toolInput, guardContextFrom(cwd, input.env), GUARD_DEFAULTS);
        if (hit || guardHit) {
          const code = hit ? "NEVER_EVENT" : guardHit!.code;
          const rule = hit ? hit.rule : guardHit!.rule;
          try {
            record(cwd, {
              ts: new Date().toISOString(),
              sessionId: payload.sessionId ?? defaultSessionId(input.env),
              host: "ide",
              product,
              toolId: payload.toolName,
              verdict: "DENY",
              outcome: "blocked",
              reasonCode: code,
              mode: "offline",
              neverEvent: isNeverCode(code),
              ...(rule ? { neverRule: rule } : {}),
            }, input.env);
          } catch { /* audit is best effort */ }
          return deny(denyReason(payload.toolName, code, rule), host);
        }
      }
    } catch { /* fall through */ }
    return failOpen(input, payload, "hook error; the call was let through (fail-open)");
  }
}

const DAY_MS = 24 * 3600_000;

/** Text for /kya-guard:status. Reads the trail only. Never throws. */
export function guardStatus(env: NodeJS.ProcessEnv, now: Date = new Date()): string {
  const ctx = guardContextFrom(process.cwd(), env);
  const { problem } = readGuardConfig(ctx.home);
  let rows: TrailEvent[] = [];
  let readable = true;
  try {
    rows = readGlobalTrail(env);
  } catch {
    readable = false;
  }
  const since = now.getTime() - 7 * DAY_MS;
  const week = rows.filter((e) => Date.parse(e.ts) >= since && e.outcome !== "error");
  const stopped = week.filter((e) => e.outcome === "blocked");
  const held = week.filter((e) => e.outcome === "held");
  const last = [...stopped, ...held]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, 3);
  const lines = [
    "KYA Guard status",
    `Rules loaded: ${NEVER_LIST_INPUT_RULES.length + GUARD_SHELL_RULES.length} (${NEVER_LIST_INPUT_RULES.length} never-list, ${GUARD_SHELL_RULES.length} guard shell), plus the secret-write and exfil checks.`,
    readable ? `Calls seen in 7 days: ${week.length}` : "Calls seen in 7 days: unknown (the trail could not be read)",
    `Calls blocked in 7 days: ${stopped.length} (${held.length} more held for you to answer)`,
    last.length
      ? `Last ${last.length} stopped: ${last.map((e) => { const r = e.neverRule ?? e.reasonCode; const l = ruleLabel(r); return `${l ? `${l} [${r}]` : r} (${e.ts.slice(0, 16).replace("T", " ")} UTC)`; }).join(", ")}`
      : "Last stopped: none",
    // The card is offered here, to the person. Never in the deny text the agent reads.
    ...(recentNearMiss(week, now) ? ["Make a card to post about the last stop (an image with the rule, the host and the date, nothing private): /kya-guard:share"] : []),
    ...(problem ? [`Config problem: ${problem}. The defaults are in force.`] : []),
    "To allow one rule: edit ~/.kya/config.json yourself and add a guardAllow entry (rule id plus an exact path or command). The agent cannot edit that file.",
    "Full report: npx @shield-agent/kya receipt --open",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * `--card [--id <id>]`: write the near-miss card (SVG only: this bundle starts no process, so it makes no PNG) and print the caption.
 * Always exit 0: the slash command shows the text, and its `|| echo` fallback is for a missing node, not for "no card".
 */
export function guardCard(env: NodeJS.ProcessEnv, id?: string): { readonly exitCode: 0; readonly text: string } {
  try {
    const pick = pickNearMiss(readGlobalTrail(env), id);
    if (!pick.ok) return { exitCode: 0, text: `${pick.message}\n` };
    const { svgPath, input } = writeCardSvg(env, pick.event);
    return {
      exitCode: 0,
      text: formatCard({ svgPath, input, id: eventIdOf(pick.event), pngNote: "This plugin makes the SVG only. For a PNG too, run: npx @shield-agent/kya receipt --card" }),
    };
  } catch {
    return { exitCode: 0, text: "KYA Guard could not make the card (the trail or the cards folder could not be read or written). Nothing was sent anywhere.\n" };
  }
}
