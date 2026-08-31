import type { ResolvedConfig } from "../config.js";
import { isMachineApiKey, KyaHttpClient, type ApprovalResponse } from "../client.js";
import { UsageError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagString } from "../parse-args.js";

export async function runDecide(
  config: ResolvedConfig,
  input: { id: string; decision: "approve" | "reject" },
  client?: KyaHttpClient,
): Promise<ApprovalResponse> {
  const id = input.id.trim();
  if (!id) {
    throw new UsageError(`${input.decision} requires --id <approval-id>`);
  }
  const key = config.apiKey ?? "";
  if (isMachineApiKey(key)) {
    throw new UsageError(
      `Machine API keys (sk_*) cannot ${input.decision}. Use a JWT with kya.approve (or console).`,
    );
  }
  const http =
    client ??
    new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      host: config.host,
      agentId: config.agentId,
    });
  return http.decideApproval(id, input.decision);
}

export function decideIdFromArgs(parsed: ParsedArgs, verb: string): string {
  const id = flagString(parsed.flags, "id") ?? parsed.positionals[0];
  if (!id) {
    throw new UsageError(`${verb} requires --id <approval-id>`);
  }
  return id;
}
