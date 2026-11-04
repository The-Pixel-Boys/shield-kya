import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { neverListInputMatch } from "../never-list-input.js";
import { factoryWorkItemId } from "../hash.js";
import type { ResolvedConfig } from "../config.js";
import {
  KyaHttpClient,
  type ApprovalResponse,
} from "../client.js";
import { UsageError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagString } from "../parse-args.js";
import {
  evalToolInputFromArgs,
  runEvalTool,
  type EvalToolResult,
} from "./eval-tool.js";
import { appendTrail, defaultSessionId } from "../trail.js";
import { assertNoSecrets } from "../dash/render.js";
import { deriveDiffPreview } from "../diff-preview.js";
import { deriveTargetPath, deriveTrailSummary } from "../trail-summary.js";
import { trailMapFields } from "../trail-map-fields.js";
import { maybeSpawnNotifyFlush } from "../notify/dispatch.js";
import { isNeverCode } from "../never-code.js";

export interface WrapResult {
  readonly eval: EvalToolResult;
  /** "executed" only on the `wrap -- <cmd>` form, after an allowing verdict. */
  readonly sideEffect: "blocked" | "executed";
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
  const targetPath = deriveTargetPath(args);
  let diffPreview = deriveDiffPreview(toolId, args);
  if (diffPreview) {
    try {
      assertNoSecrets(diffPreview);
    } catch {
      diffPreview = "[redacted]";
    }
  }
  const trailEvent = {
    ts: new Date().toISOString(),
    sessionId: defaultSessionId(),
    host: config.host,
    toolId,
    verdict: evalResult.response.verdict,
    reasonCode: reason,
    mode,
    neverEvent: isNeverCode(reason),
    argsHash: evalResult.argsHash,
    ...trailMapFields(toolId, args, config.cwd, process.env),
    // A secret-shaped write is denied because its text is a secret: no summary or preview of it is stored.
    ...(summary && reason !== "NEVER_SECRET_WRITE" ? { summary } : {}),
    ...(diffPreview && reason !== "NEVER_SECRET_WRITE" ? { diffPreview } : {}),
    ...(targetPath ? { targetPath } : {}),
  };
  appendTrail(config.cwd, trailEvent);
  // Webhooks + OTLP export ride a detached helper; wrap never waits on the
  // network. No-op unless a sink is configured.
  maybeSpawnNotifyFlush({ env: process.env, cwd: config.cwd, event: trailEvent, projectDir: config.cwd });
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
      next: "denied - do not execute; wrap never retries around the PEP",
    };
  }

  if (verdict !== "REQUIRE_APPROVE") {
    recordTrail(config, evalResult, offline ? "offline" : "observe", input.args);
    return {
      eval: evalResult,
      sideEffect: "blocked",
      next:
        verdict === "ALLOW"
          ? "evaluate ALLOW - wrap still does not execute the side effect"
          : "unknown verdict - treat as blocked",
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
        "observed REQUIRE_APPROVE - recorded on trail, no Hold ticket (host still owns OK?). Use --hold or KYA_HOLD=1 for org Hold path",
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
    next: `pending ${approval.id} - kya approve --id ${approval.id} (human). wrap does not execute`,
  };
}

export function wrapInputFromArgs(parsed: ParsedArgs) {
  const evalInput = evalToolInputFromArgs(parsed);
  return {
    ...evalInput,
    workItemId: flagString(parsed.flags, "work-item", "workItem"),
  };
}

/** `kya wrap [flags] -- <cmd...>`: the command to gate and run, or undefined for the --tool-id form. */
export function wrapCommandFromArgs(parsed: ParsedArgs): readonly string[] | undefined {
  const rest = parsed.rest;
  if (rest === undefined) return undefined;
  if (rest.length === 0 || !rest[0]) throw new UsageError("wrap -- needs a command: kya wrap [--offline] -- <cmd> [args...]");
  return rest;
}

/** Flags of the command form: the tool is always the host shell tool, so no --tool-id. */
export function wrapCommandInputFromArgs(parsed: ParsedArgs) {
  return {
    offline: flagBool(parsed.flags, "offline"),
    irreversible: flagBool(parsed.flags, "irreversible"),
    sessionRisk: flagString(parsed.flags, "session-risk", "risk"),
    approvalStatus: flagString(parsed.flags, "approval-status"),
    workItemId: flagString(parsed.flags, "work-item", "workItem"),
  };
}

/** POSIX single-quote every token that needs it, so the joined text re-parses to the same argv. */
export function shellJoin(argv: readonly string[]): string {
  return argv
    .map((a) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

/** Run argv with inherited stdio. Exit code: the child's, 126 not executable, 127 not found, 128+n by signal. */
export function spawnWrapped(argv: readonly string[], error: (m: string) => void): number {
  const r = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit" });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    error(`kya wrap: cannot run ${argv[0]}: ${code ?? "spawn failed"}`);
    return code === "EACCES" ? 126 : 127;
  }
  if (r.status === null) return 128 + (osConstants.signals[r.signal as NodeJS.Signals] ?? 0);
  return r.status;
}

export interface WrapCommandResult {
  readonly wrap: WrapResult;
  readonly exitCode: number;
  readonly ran: boolean;
}

/**
 * Gate one command, then run it only when the verdict allows (exit code 0: ALLOW, or an
 * observed REQUIRE_APPROVE). The local input rules run on the online path too, so a
 * command the hook would deny is never run from here. `onEvaluated` reports before the
 * command starts, so the verdict lines come first.
 */
export async function runWrapCommand(
  config: ResolvedConfig,
  argv: readonly string[],
  input: {
    irreversible?: boolean;
    sessionRisk?: string;
    approvalStatus?: string;
    offline?: boolean;
    workItemId?: string;
  },
  opts: {
    client?: KyaHttpClient;
    onEvaluated?: (w: WrapResult) => Promise<void> | void;
    run?: (argv: readonly string[]) => number;
  } = {},
): Promise<WrapCommandResult> {
  const args = { command: shellJoin(argv) };
  const localHit = neverListInputMatch("Bash", args, undefined, config.cwd);
  let wrap: WrapResult;
  if (localHit) {
    const offline = Boolean(input.offline || config.offline);
    const evalResult: EvalToolResult = {
      response: { verdict: "DENY", reasonCode: "NEVER_EVENT", toolId: "Bash", ruleId: localHit.rule },
      toolId: "Bash",
      argsHash: undefined,
      offline,
    };
    recordTrail(config, evalResult, offline ? "offline" : "observe", args);
    wrap = { eval: evalResult, sideEffect: "blocked", next: "denied - the command was not run" };
  } else {
    wrap = await runWrap(config, { ...input, toolId: "Bash", args }, opts.client);
  }
  const code = wrapExitCode(wrap);
  const ran = code === 0;
  if (ran) wrap = { ...wrap, sideEffect: "executed", next: "evaluated ok - running the command" };
  await opts.onEvaluated?.(wrap);
  if (!ran) return { wrap, exitCode: code, ran };
  return { wrap, exitCode: (opts.run ?? ((a) => spawnWrapped(a, (m) => process.stderr.write(`${m}\n`))))(argv), ran };
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
  ]
    .filter(Boolean)
    .join("\n");
}
