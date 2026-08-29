import type { ResolvedConfig } from "../config.js";
import { KyaHttpClient, type InvokeToolResponse } from "../client.js";
import { UsageError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagString } from "../parse-args.js";
import { computeArgsHash } from "../hash.js";
import { findSampleTool } from "../sample-tools.js";

export async function runInvoke(
  config: ResolvedConfig,
  input: {
    toolId: string;
    argsHash?: string;
    irreversible?: boolean;
    actionClass?: string;
    risk?: string;
    offline?: boolean;
  },
  client?: KyaHttpClient,
): Promise<InvokeToolResponse> {
  if (input.offline || config.offline) {
    throw new UsageError(
      "invoke has no offline sample. It talks to a live plane and never runs the write on this machine",
    );
  }
  const toolId = input.toolId?.trim();
  if (!toolId) {
    throw new UsageError("invoke requires --tool-id");
  }
  const sample = findSampleTool(toolId);
  const http =
    client ??
    new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      host: config.host,
      agentId: config.agentId,
    });
  return http.invokeTool({
    toolId,
    agentId: config.agentId,
    argsHash: input.argsHash ?? computeArgsHash({}),
    actionClass: input.actionClass ?? sample?.actionClass,
    irreversible: input.irreversible ?? sample?.irreversible ?? true,
    risk: input.risk,
    host: config.host,
  });
}

export function invokeInputFromArgs(parsed: ParsedArgs) {
  const toolId = flagString(parsed.flags, "tool-id", "toolId") ?? "";
  return {
    toolId,
    argsHash: flagString(parsed.flags, "args-hash", "argsHash"),
    irreversible: flagBool(parsed.flags, "irreversible") || undefined,
    actionClass: flagString(parsed.flags, "action-class", "actionClass"),
    risk: flagString(parsed.flags, "risk"),
    offline: flagBool(parsed.flags, "offline"),
  };
}

export function formatInvokeHuman(res: InvokeToolResponse): string {
  return [
    `verdict: ${res.verdict}`,
    `reasonCode: ${res.reasonCode}`,
    `dispatched: ${res.dispatched}`,
    `sideEffect: ${res.sideEffect}`,
    res.approvalRequestId ? `approval: ${res.approvalRequestId}` : undefined,
    "invoke authorizes on the plane. It does not run the write here.",
  ]
    .filter(Boolean)
    .join("\n");
}
