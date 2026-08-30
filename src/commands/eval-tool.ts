import type { ResolvedConfig } from "../config.js";
import {
  buildEvaluateFromToolArgs,
  KyaHttpClient,
  type PolicyEvaluateResponse,
} from "../client.js";
import { UsageError } from "../errors.js";
import { evaluateOffline } from "../offline-evaluate.js";
import { findSampleTool } from "../sample-tools.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagString } from "../parse-args.js";

export interface EvalToolResult {
  readonly response: PolicyEvaluateResponse;
  readonly toolId: string;
  readonly argsHash: string | undefined;
  readonly offline: boolean;
}

export async function runEvalTool(
  config: ResolvedConfig,
  input: {
    toolId: string;
    args?: unknown;
    irreversible?: boolean;
    sessionRisk?: string;
    approvalStatus?: string;
    sandboxId?: string;
    offline?: boolean;
  },
  client?: KyaHttpClient,
): Promise<EvalToolResult> {
  if (!input.toolId?.trim()) {
    throw new UsageError("eval-tool requires --tool-id");
  }

  const toolId = input.toolId.trim();
  const sample = findSampleTool(toolId);
  const irreversible =
    input.irreversible ?? sample?.irreversible ?? false;
  const actionClass = sample?.actionClass;

  const req = buildEvaluateFromToolArgs({
    toolId,
    args: input.args ?? {},
    irreversible,
    host: config.host,
    agentId: config.agentId,
    sessionRisk: input.sessionRisk,
    approvalStatus: input.approvalStatus,
    sandboxId: input.sandboxId,
  });
  // Prefer sample actionClass for offline + HTTP when known
  const request =
    actionClass !== undefined
      ? { ...req, actionClass, dataClass: sample?.dataClass }
      : req;

  if (input.offline || config.offline) {
    const response = evaluateOffline(request, config.host);
    return {
      response,
      toolId,
      argsHash: response.argsHash ?? request.argsHash,
      offline: true,
    };
  }

  const http =
    client ??
    new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      host: config.host,
      agentId: config.agentId,
    });

  const response = await http.evaluatePolicy(request);
  return {
    response,
    toolId,
    argsHash: response.argsHash ?? request.argsHash,
    offline: false,
  };
}

export function evalToolInputFromArgs(parsed: ParsedArgs): {
  toolId: string;
  args: unknown;
  irreversible: boolean;
  sessionRisk?: string;
  approvalStatus?: string;
  sandboxId?: string;
  offline: boolean;
} {
  const toolId = flagString(parsed.flags, "tool-id", "toolId");
  if (!toolId) {
    throw new UsageError(
      "eval-tool requires --tool-id <id> [--args '{}'] [--irreversible] [--sandbox-id] [--offline]",
    );
  }
  const argsRaw = flagString(parsed.flags, "args");
  let args: unknown = {};
  if (argsRaw) {
    try {
      args = JSON.parse(argsRaw);
    } catch {
      throw new UsageError("--args must be valid JSON");
    }
  }
  const irreversible = flagBool(parsed.flags, "irreversible");
  const sessionRisk = flagString(parsed.flags, "session-risk", "risk");
  const approvalStatus = flagString(parsed.flags, "approval-status");
  const sandboxId = flagString(parsed.flags, "sandbox-id", "sandboxId");
  const offline = flagBool(parsed.flags, "offline");
  return {
    toolId,
    args,
    irreversible,
    sessionRisk,
    approvalStatus,
    sandboxId,
    offline,
  };
}

export function formatEvalHuman(result: EvalToolResult): string {
  const r = result.response;
  return [
    `verdict: ${r.verdict}`,
    `reasonCode: ${r.reasonCode}`,
    r.toolId ? `toolId: ${r.toolId}` : `toolId: ${result.toolId}`,
    result.argsHash ? `argsHash: ${result.argsHash}` : undefined,
    r.localVerdict ? `localVerdict: ${r.localVerdict}` : undefined,
    r.sessionRisk ? `sessionRisk: ${r.sessionRisk}` : undefined,
    r.host ? `host: ${r.host}` : undefined,
    result.offline ? `mode: offline-sample (not production PEP)` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
