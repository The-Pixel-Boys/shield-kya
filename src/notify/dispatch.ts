/**
 * Detached dispatch for verdict notifications + OTLP export from short-lived
 * CLI spawns (hook, wrap): the parent never waits on the network, the child
 * (`kya notify-flush`) does the delivery. Mirrors the telemetry hook-ping
 * pattern (detached, stdio ignored, unref'd). Long-lived processes (MCP gate,
 * gateway) call notifyOnTrailEvent/exportVerdictSpan directly instead, so the
 * in-process rate limiter and circuit breaker keep working there.
 */
import { spawn } from "node:child_process";
import { kyaHome, readFileConfig } from "../config.js";
import { NOTIFYABLE_VERDICTS, ENV_WEBHOOK_VAR } from "./index.js";
import type { TrailEvent } from "../trail.js";

/** Cheap pre-spawn check: is any sink configured at all? */
export function notifyDispatchEnabled(env: NodeJS.ProcessEnv, cwd: string): boolean {
  try {
    if (env[ENV_WEBHOOK_VAR]?.trim() || env.KYA_OTLP_EXPORT_ENDPOINT?.trim()) return true;
    const merged = { ...readFileConfig(kyaHome(env)), ...readFileConfig(cwd) } as Record<
      string,
      unknown
    >;
    const notify = merged.notify as { webhooks?: unknown } | undefined;
    if (Array.isArray(notify?.webhooks) && notify.webhooks.length > 0) return true;
    const otlp = merged.otlpExport as { endpoint?: unknown } | undefined;
    return typeof otlp?.endpoint === "string" && otlp.endpoint.trim() !== "";
  } catch {
    return false;
  }
}

export function maybeSpawnNotifyFlush(deps: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly event: TrailEvent;
  readonly entry?: string;
  readonly spawnImpl?: typeof spawn;
}): boolean {
  try {
    if (!NOTIFYABLE_VERDICTS.includes(deps.event.verdict)) return false;
    if (!notifyDispatchEnabled(deps.env, deps.cwd)) return false;
    const entry = deps.entry ?? process.argv[1];
    if (entry === undefined) return false;
    const child = (deps.spawnImpl ?? spawn)(
      process.execPath,
      [entry, "notify-flush"],
      {
        detached: true,
        stdio: "ignore",
        env: { ...deps.env, KYA_NOTIFY_EVENT: JSON.stringify(deps.event) },
        cwd: deps.cwd,
        windowsHide: true,
      },
    );
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
