/**
 * kya notify-flush - internal helper spawned detached by hook/wrap (see
 * src/notify/dispatch.ts). Delivers the event handed over in KYA_NOTIFY_EVENT
 * to configured webhooks and the OTLP exporter, then exits. Never prints,
 * never fails hard: it is a best-effort side channel.
 */
import { kyaHome, readFileConfig } from "../config.js";
import type { TrailEvent } from "../trail.js";
import { notifyOnTrailEvent, type NotifyFileConfig } from "../notify/index.js";
import { exportVerdictSpan, resolveOtlpExportConfig } from "../otel/exporter.js";

export async function runNotifyFlush(
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<number> {
  const raw = env.KYA_NOTIFY_EVENT;
  if (!raw) return 0;
  let event: TrailEvent;
  try {
    const parsed = JSON.parse(raw) as TrailEvent;
    if (!parsed || typeof parsed.toolId !== "string" || typeof parsed.verdict !== "string") {
      return 0;
    }
    event = parsed;
  } catch {
    return 0;
  }
  // Project config wins over the global one (same precedence as resolveConfig).
  const fileConfig = {
    ...readFileConfig(kyaHome(env)),
    ...readFileConfig(cwd),
  } as NotifyFileConfig;
  await notifyOnTrailEvent(event, fileConfig, env).catch(() => undefined);
  const otlp = resolveOtlpExportConfig(env, fileConfig);
  if (otlp) {
    await exportVerdictSpan(
      {
        ts: event.ts,
        sessionId: event.sessionId,
        toolId: event.toolId,
        verdict: event.verdict,
        reasonCode: event.reasonCode,
        mode: event.mode,
        ...(event.host ? { host: event.host } : {}),
        ...(event.tokensIn !== undefined ? { tokensIn: event.tokensIn } : {}),
        ...(event.tokensOut !== undefined ? { tokensOut: event.tokensOut } : {}),
      },
      otlp,
    ).catch(() => undefined);
  }
  return 0;
}
