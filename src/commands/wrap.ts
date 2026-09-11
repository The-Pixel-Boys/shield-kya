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
import { appendTrail, defaultSessionId } from "../trail.js";
import { assertNoSecrets } from "../dash/render.js";
import { deriveDiffPreview } from "../diff-preview.js";
import { deriveTrailSummary } from "../trail-summary.js";

export interface WrapResult {
  readonly eval: EvalToolResult;
  readonly sideEffect: "blocked";
  readonly approval?: ApprovalResponse;
  readonly workItemId?: string;
  readonly next?: string;
  /** Observe mode: REQUIRE_APPROVE recorded without opening a Hold ticket. */
  readonly observed?: boolean;
}

/** Shell-safe: DENY → 1, Hold ticket pending → 4, ALLOW or observe → 0. Never means a write ran. */
export function verdictExitCode(verdict: string | undefined, observed?: boolean): number {
  const v = (verdict ?? "").toUpperCase();
  if (v === "ALLOW") return 0;
  if (v === "REQUIRE_APPROVE") return observed ? 0 : 4;
  return 1;
}

export function wrapExitCode(result: WrapResult): number {
  return verdictExitCode(result.eval.response.verdict, result.observed);
}

function recordTrail(
  config: ResolvedConfig,
  evalResult: EvalToolResult,
  mode: "observe" | "hold" | "offline",
  args?: unknown,
): void {
  const reason = evalResult.response.reasonCode ?? "";
  const toolId = evalResult.response.toolId ?? "";
  const summary = deriveTrailSummary(toolId, args);
  let diffPreview = deriveDiffPreview(toolId, args);
  if (diffPreview) {
    try {
      assertNoSecrets(diffPreview);
    } catch {
      diffPreview = "[redacted]";
    }
  }
  appendTrail(config.cwd, {
    ts: new Date().toISOString(),
    sessionId: defaultSessionId(),
    host: config.host,
    toolId,
    verdict: evalResult.response.verdict,
    reasonCode: reason,
    mode,
    neverEvent: reason === "NEVER_EVENT",
    argsHash: evalResult.argsHash,
    ...(summary ? { summary } : {}),
    ...(diffPreview ? { diffPreview } : {}),
  });
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
  const offline = Boolean(input.offline || config.offline || evalResult.offline);

  if (verdict === "DENY") {
    recordTrail(config, evalResult, offline ? "offline" : "observe", input.args);
    return {
      eval: evalResult,
      sideEffect: "blocked",
      next: "denied — do not execute; wrap never retries around the PEP",
    };
  }

  if (verdict !== "REQUIRE_APPROVE") {
    recordTrail(config, evalResult, offline ? "offline" : "observe", input.args);
    return {
      eval: evalResult,
      sideEffect: "blocked",
      next:
        verdict === "ALLOW"
          ? "evaluate ALLOW — wrap still does not execute the side effect"
          : "unknown verdict — treat as blocked",
    };
  }

  // REQUIRE_APPROVE: default observe (no second human prompt / no ticket)
  if (!config.holdEnabled) {
    recordTrail(config, evalResult, offline ? "offline" : "observe", input.args);
    return {
      eval: evalResult,
      sideEffect: "blocked",
      observed: true,
      next:
        "observed REQUIRE_APPROVE — recorded on trail, no Hold ticket (host still owns OK?). Use --hold or KYA_HOLD=1 for org Hold path",
    };
  }

  if (offline) {
    recordTrail(config, evalResult, "offline", input.args);
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
  recordTrail(config, evalResult, "hold", input.args);
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
    result.observed ? "mode: observe (no Hold ticket)" : undefined,
    result.approval
      ? `approval: ${result.approval.id} ${result.approval.status}`
      : undefined,
    result.workItemId ? `workItem: ${result.workItemId}` : undefined,
    result.next ? `next: ${result.next}` : undefined,
    result.eval.offline
      ? "mode: offline-sample (not production PEP)"
      : undefined,
    "View activity: kya receipt --open",
  ]
    .filter(Boolean)
    .join("\n");
}
