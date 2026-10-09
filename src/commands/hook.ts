/**
 * kya hook - PreToolUse interception for hosts with native hooks
 * (Claude Code, Grok, Kimi Code). Offline local evaluate only: no network,
 * sub-second, fail-open on any internal error. DENY (local never-list)
 * blocks; REQUIRE_APPROVE records advisory unless --strict.
 */
import { resolveConfig } from "../config.js";
import type { PolicyEvaluateResponse } from "../client.js";
import { runEvalTool } from "./eval-tool.js";
import { appendTrail, defaultSessionId, hostToProduct } from "../trail.js";
import { deriveWireChangeFields } from "../diff-preview.js";
import { maybeSpawnNotifyFlush } from "../notify/dispatch.js";

export interface HookInput {
  readonly host: string;
  readonly strict: boolean;
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
}

interface HookPayload {
  readonly event?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly toolName?: string;
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
    // the trail path itself comes from env/KYA_HOME - no traversal risk.
    const trailCwd = payload.cwd?.trim() || input.cwd;
    // Wire change fields (summary, diffPreview, targetPath) feed the receipt's
    // Changes tab; redaction + opt-out live inside deriveWireChangeFields.
    const changeFields = deriveWireChangeFields(
      payload.toolName,
      payload.toolInput ?? {},
      input.env,
    );
    const trailEvent = {
      ts: new Date().toISOString(),
      sessionId: payload.sessionId ?? defaultSessionId(input.env),
      host: config.host,
      product: hostToProduct(input.host),
      toolId: response.toolId ?? payload.toolName,
      verdict: response.verdict,
      reasonCode: response.reasonCode ?? "",
      mode: "offline" as const,
      neverEvent: response.reasonCode === "NEVER_EVENT",
      argsHash: response.argsHash,
      ...(changeFields ?? {}),
      ...(payload.usage?.tokensIn !== undefined
        ? { tokensIn: payload.usage.tokensIn }
        : {}),
      ...(payload.usage?.tokensOut !== undefined
        ? { tokensOut: payload.usage.tokensOut }
        : {}),
    };
    try {
      appendTrail(trailCwd, trailEvent, input.env);
    } catch {
      /* observe path never breaks the gate */
    }
    // Webhooks + OTLP export ride a detached helper; the hook never waits on
    // the network. No-op unless a sink is configured.
    maybeSpawnNotifyFlush({ env: input.env, cwd: trailCwd, event: trailEvent });

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
