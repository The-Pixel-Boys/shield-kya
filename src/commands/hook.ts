/**
 * kya hook — PreToolUse interception for hosts with native hooks
 * (Claude Code, Grok, Kimi Code). Offline local evaluate only: no network,
 * sub-second, fail-open on any internal error. DENY (local never-list)
 * blocks; REQUIRE_APPROVE records advisory unless --strict.
 */
import { resolveConfig } from "../config.js";
import type { PolicyEvaluateResponse } from "../client.js";
import { runEvalTool } from "./eval-tool.js";
import { appendTrail, defaultSessionId, hostToProduct } from "../trail.js";
import { deriveTrailSummary } from "../trail-summary.js";

export interface HookInput {
  readonly host: string;
  readonly strict: boolean;
  readonly stdinText: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Test seam — defaults to the offline runEvalTool path. */
  readonly evaluate?: (toolId: string, args: unknown) => Promise<PolicyEvaluateResponse>;
}

export interface HookResult {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

interface HookPayload {
  readonly event?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
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
    toolInput: p.tool_input ?? p.toolInput,
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

export async function runHook(input: HookInput): Promise<HookResult> {
  try {
    const payload = parsePayload(input.stdinText);
    if (!payload) return ALLOW;
    if (payload.event && !/^(PreToolUse|pre_tool_use)$/i.test(payload.event)) return ALLOW;
    if (!payload.toolName) return ALLOW;

    const config = resolveConfig({
      cwd: input.cwd,
      env: input.env,
      flags: {},
      allowMissingApiKey: true,
      requireApiKey: false,
      offline: true,
    });
    const evaluate =
      input.evaluate ??
      (async (toolId: string, args: unknown) =>
        (await runEvalTool(config, { toolId, args, offline: true })).response);
    const response = await evaluate(payload.toolName, payload.toolInput ?? {});

    // payload.cwd is host-supplied and only feeds the project-basename stamp;
    // the trail path itself comes from env/KYA_HOME — no traversal risk.
    const trailCwd = payload.cwd?.trim() || input.cwd;
    try {
      appendTrail(trailCwd, {
        ts: new Date().toISOString(),
        sessionId: payload.sessionId ?? defaultSessionId(input.env),
        host: config.host,
        product: hostToProduct(input.host),
        toolId: response.toolId ?? payload.toolName,
        verdict: response.verdict,
        reasonCode: response.reasonCode ?? "",
        mode: "offline",
        neverEvent: response.reasonCode === "NEVER_EVENT",
        argsHash: response.argsHash,
        summary: deriveTrailSummary(payload.toolName, payload.toolInput ?? {}),
      }, input.env);
    } catch {
      /* observe path never breaks the gate */
    }

    if (response.verdict === "DENY") {
      return deny(`KYA denied ${payload.toolName}: ${response.reasonCode}`);
    }
    if (input.strict && response.verdict === "REQUIRE_APPROVE") {
      return deny(`KYA strict mode: ${payload.toolName} requires approval (${response.reasonCode})`);
    }
    return ALLOW;
  } catch {
    return ALLOW; // fail-open: hook errors must never block the user's agent
  }
}
