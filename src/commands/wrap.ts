import { randomUUID } from "node:crypto";
import { factoryWorkItemId } from "../hash.js";
import type { ResolvedConfig } from "../config.js";
import {
  KyaHttpClient,
  type ApprovalResponse,
} from "../client.js";
import { UsageError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagString } from "../parse-args.js";
import {
  evalToolInputFromArgs,
  runEvalTool,
  type EvalToolResult,
} from "./eval-tool.js";

export interface WrapResult {
  readonly eval: EvalToolResult;
  readonly sideEffect: "blocked";
  readonly approval?: ApprovalResponse;
  readonly workItemId?: string;
  readonly next?: string;
}

/** Shell-safe: DENY/unknown → 1, pending REQUIRE_APPROVE → 4, ALLOW → 0. Never means a write ran. */
export function verdictExitCode(verdict: string | undefined): number {
  const v = (verdict ?? "").toUpperCase();
  if (v === "ALLOW") return 0;
  if (v === "REQUIRE_APPROVE") return 4;
  return 1;
}

export function wrapExitCode(result: WrapResult): number {
  return verdictExitCode(result.eval.response.verdict);
}

export async function runWrap(
  config: ResolvedConfig,
  input: {
    toolId: string;
    args?: unknown;
    irreversible?: boolean;
    sessionRisk?: string;
    approvalStatus?: string;
    offline?: boolean;
    workItemId?: string;
  },
  client?: KyaHttpClient,
): Promise<WrapResult> {
  const evalResult = await runEvalTool(config, input, client);
  const verdict = evalResult.response.verdict.toUpperCase();

  if (verdict === "DENY") {
    return {
      eval: evalResult,
      sideEffect: "blocked",
      next: "denied — do not execute; wrap never retries around the PEP",
    };
  }

  if (verdict !== "REQUIRE_APPROVE") {
    return {
      eval: evalResult,
      sideEffect: "blocked",
      next:
        verdict === "ALLOW"
          ? "evaluate ALLOW — wrap still does not execute the side effect"
          : "unknown verdict — treat as blocked",
    };
  }

  if (input.offline || config.offline || evalResult.offline) {
    return {
      eval: evalResult,
      sideEffect: "blocked",
      next: "request approval on a live plane; wrap never executes",
    };
  }

  const agentId = config.agentId?.trim();
  if (!agentId) {
    throw new UsageError(
      "wrap on REQUIRE_APPROVE needs --agent-id or .kya/config.json agentId",
    );
  }

  const http =
    client ??
    new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      host: config.host,
      agentId,
    });
  const boundHash = evalResult.argsHash?.trim();
  const workItemId =
    input.workItemId?.trim() ||
    (boundHash ? factoryWorkItemId(boundHash) : randomUUID());
  const approval = await http.requestApproval({
    agentId,
    disputeId: workItemId,
    toolId: input.toolId,
    action: input.toolId,
    argsHash: evalResult.argsHash,
    host: config.host,
    irreversible: input.irreversible,
    reasonCode: evalResult.response.reasonCode,
  });
  return {
    eval: evalResult,
    sideEffect: "blocked",
    approval,
    workItemId,
    next: `pending ${approval.id} — kya approve --id ${approval.id} (human). wrap does not execute`,
  };
}

export function wrapInputFromArgs(parsed: ParsedArgs) {
  const evalInput = evalToolInputFromArgs(parsed);
  return {
    ...evalInput,
    workItemId: flagString(parsed.flags, "work-item", "workItem"),
  };
}

export function formatWrapHuman(result: WrapResult): string {
  const r = result.eval.response;
  return [
    `verdict: ${r.verdict}`,
    `reasonCode: ${r.reasonCode}`,
    `sideEffect: ${result.sideEffect}`,
    result.approval
      ? `approval: ${result.approval.id} ${result.approval.status}`
      : undefined,
    result.workItemId ? `workItem: ${result.workItemId}` : undefined,
    result.next ? `next: ${result.next}` : undefined,
    result.eval.offline
      ? "mode: offline-sample (not production PEP)"
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}


