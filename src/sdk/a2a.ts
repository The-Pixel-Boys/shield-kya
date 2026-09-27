/**
 * In-process boundary check for agent-to-agent sends (ADK / BeeAI / CrewAI
 * style frameworks): evaluate `a2a__<peerId>__<action>` before the caller
 * performs the send. `a2a` is a registry-unknown server, so offline evaluate
 * lands on the safe REQUIRE_APPROVE/UNKNOWN path unless the action is
 * declared irreversible. Fleet-level A2A governance (mTLS identity, org
 * policy between runtimes) is the kya gateway's job — this is the
 * single-process complement.
 */

import type { ResolvedConfig } from "../config.js";
import { runEvalTool } from "../commands/eval-tool.js";
import { recordSdkTrail, resolveSdkConfig } from "./govern.js";

export interface GovernA2aSendOptions {
  readonly peerId: string;
  readonly peerUrl?: string;
  readonly action: string;
  /** Short human description of the payload — trail summary only, never the body. */
  readonly payloadSummary?: string;
  readonly irreversible?: boolean;
  readonly config?: ResolvedConfig;
}

export interface A2aGateResult {
  /** true for ALLOW and observed REQUIRE_APPROVE; false for DENY/unknown. */
  readonly allow: boolean;
  readonly verdict: string;
  readonly reasonCode: string;
}

export async function governA2aSend(
  options: GovernA2aSendOptions,
): Promise<A2aGateResult> {
  const toolId = `a2a__${options.peerId.trim()}__${options.action.trim()}`;
  const config = resolveSdkConfig(options.config);
  const args = {
    peer: options.peerId,
    ...(options.peerUrl ? { url: options.peerUrl } : {}),
    ...(options.payloadSummary ? { note: options.payloadSummary } : {}),
  };
  const evalResult = await runEvalTool(config, {
    toolId,
    args,
    irreversible: options.irreversible,
  });
  recordSdkTrail(config, evalResult, args);
  const verdict = (evalResult.response.verdict ?? "").toUpperCase();
  return {
    allow: verdict === "ALLOW" || verdict === "REQUIRE_APPROVE",
    verdict: verdict || "DENY",
    reasonCode: evalResult.response.reasonCode ?? "",
  };
}
