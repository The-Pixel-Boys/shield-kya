/**
 * In-process governance shim: evaluate a tool call through the same path
 * `kya wrap` uses (offline sample evaluate by default - no network, no hosted
 * plane required), record the trail event, then ALLOW/REQUIRE_APPROVE run the
 * function while DENY throws KyaDeniedError without running it.
 *
 * Importing this module starts nothing: config resolves lazily on first call.
 *
 * Deliberate coupling: the trail write is fail-closed - a governance shim
 * where the audit record cannot be written does not run the action.
 */

import type { ResolvedConfig } from "../config.js";
import { resolveConfig } from "../config.js";
import { KyaError } from "../errors.js";
import { runEvalTool, type EvalToolResult } from "../commands/eval-tool.js";
import { appendTrail, defaultSessionId } from "../trail.js";
import { deriveWireChangeFields } from "../diff-preview.js";

export class KyaDeniedError extends KyaError {
  readonly verdict: string;
  readonly reasonCode: string;
  readonly toolId: string;

  constructor(input: { verdict: string; reasonCode: string; toolId: string }) {
    super(
      `kya ${input.verdict}: ${input.toolId} (${input.reasonCode || "no reason"}) - function not executed`,
      "KYA_DENIED",
      1,
    );
    this.name = "KyaDeniedError";
    this.verdict = input.verdict;
    this.reasonCode = input.reasonCode;
    this.toolId = input.toolId;
  }
}

export interface GovernanceOptions {
  /** MCP server id; toolId becomes `<server>__<toolId>` so the taxonomy lights up. */
  readonly server?: string;
  readonly irreversible?: boolean;
  /** Explicit config (hosted plane honored). Default: lazy offline resolve. */
  readonly config?: ResolvedConfig;
}

export interface GovernedOptions<TArgs, TResult> extends GovernanceOptions {
  readonly toolId: string;
  readonly fn: (args: TArgs) => Promise<TResult> | TResult;
}

/** `<server>__<name>` when a server is given, else the bare name. */
export function deriveSdkToolId(name: string, server?: string): string {
  const n = name.trim();
  const s = server?.trim();
  return s ? `${s}__${n}` : n;
}

export function resolveSdkConfig(config?: ResolvedConfig): ResolvedConfig {
  return config ?? resolveConfig({ offline: true, allowMissingApiKey: true });
}

/** Trail parity with wrap: verdict/mode/reasonCode + change fields when derivable. */
export function recordSdkTrail(
  config: ResolvedConfig,
  evalResult: EvalToolResult,
  args: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const reason = evalResult.response.reasonCode ?? "";
  const toolId = evalResult.response.toolId ?? "";
  const mode = evalResult.offline || config.offline ? "offline" : "observe";
  const fields = deriveWireChangeFields(toolId, args, env);
  appendTrail(
    config.cwd,
    {
      ts: new Date().toISOString(),
      sessionId: defaultSessionId(env),
      host: config.host,
      toolId,
      verdict: evalResult.response.verdict,
      reasonCode: reason,
      mode,
      neverEvent: reason === "NEVER_EVENT",
      argsHash: evalResult.argsHash,
      ...(fields?.summary ? { summary: fields.summary } : {}),
      ...(fields?.diffPreview ? { diffPreview: fields.diffPreview } : {}),
      ...(fields?.targetPath ? { targetPath: fields.targetPath } : {}),
    },
    env,
  );
}

export interface GateCheckOptions extends GovernanceOptions {
  readonly toolId: string;
}

/**
 * The evaluate + trail half of governed(), constructed once per wrapped tool
 * so the lazy config cache hits across calls. Adapters whose execution path
 * closes over per-call context use this directly and invoke the framework
 * callable themselves after the check passes.
 */
export function createGateCheck(
  options: GateCheckOptions,
): (args: unknown) => Promise<void> {
  const toolId = deriveSdkToolId(options.toolId, options.server);
  let cached = options.config;
  return async (args: unknown): Promise<void> => {
    if (!cached) cached = resolveSdkConfig();
    const evalResult = await runEvalTool(cached, {
      toolId,
      args,
      irreversible: options.irreversible,
    });
    recordSdkTrail(cached, evalResult, args);
    const verdict = (evalResult.response.verdict ?? "").toUpperCase();
    if (verdict === "ALLOW" || verdict === "REQUIRE_APPROVE") {
      return;
    }
    throw new KyaDeniedError({
      verdict: verdict || "DENY",
      reasonCode: evalResult.response.reasonCode ?? "",
      toolId: evalResult.response.toolId ?? toolId,
    });
  };
}

export function governed<TArgs, TResult>(
  options: GovernedOptions<TArgs, TResult>,
): (args: TArgs) => Promise<TResult> {
  const check = createGateCheck(options);
  return async (args: TArgs): Promise<TResult> => {
    await check(args);
    return options.fn(args);
  };
}
