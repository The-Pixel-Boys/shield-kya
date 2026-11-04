/**
 * Hidden daemon entry: runs the live receipt server in the foreground and
 * publishes `.kya/receipt-server.json` (pid, url, token) once listening.
 * Spawned detached by `ensureReceiptDaemon` - never invoked by users directly.
 */
import type { ResolvedConfig } from "../config.js";
import { startLiveReceiptServer } from "../receipt/live-server.js";
import { clearDaemonState, writeDaemonState } from "../receipt/daemon.js";
import { semanticRuntimeInstalled } from "../receipt/semantic-status.js";

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_CWD_POLL_MS = 60_000;
const DEFAULT_MAX_RSS_MB = 512;
// The first plain-language search loads the model and measured about 1.2 GB; a lower limit would restart the daemon after every search.
const DEFAULT_MAX_RSS_MB_SEMANTIC = 2048;
const DEFAULT_MEM_POLL_MS = 30_000;
// setTimeout fires at once for delays above this (32-bit signed ms).
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Idle close delay in ms. KYA_RECEIPT_IDLE_MINUTES: "0" or "off" never closes,
 * an empty, invalid or negative value means the default, fractions are allowed.
 */
export function receiptIdleMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.KYA_RECEIPT_IDLE_MINUTES?.trim().toLowerCase() ?? "";
  if (raw === "off") return undefined;
  const minutes = raw === "" ? DEFAULT_IDLE_MINUTES : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_IDLE_MINUTES * 60_000;
  if (minutes === 0) return undefined;
  return Math.min(minutes * 60_000, MAX_TIMER_MS);
}

function cwdPollMs(env: NodeJS.ProcessEnv): number {
  const ms = Number(env.KYA_RECEIPT_CWD_POLL_MS);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMER_MS) : DEFAULT_CWD_POLL_MS;
}

/*
 * The memory ceiling and its poll come from env on purpose: they only decide when this
 * convenience daemon restarts. They never change a hook decision, so a weak value
 * (for example from a repo's settings) cannot weaken a safety property.
 */

/** RSS ceiling in MB. KYA_RECEIPT_MAX_RSS_MB: "0" turns it off; empty or invalid means 512 (2048 when the search runtime is installed). */
export function receiptMaxRssMb(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.KYA_RECEIPT_MAX_RSS_MB?.trim() ?? "";
  const mb = Number(raw);
  if (raw === "" || !Number.isFinite(mb) || mb < 0) return semanticRuntimeInstalled(env) ? DEFAULT_MAX_RSS_MB_SEMANTIC : DEFAULT_MAX_RSS_MB;
  return mb === 0 ? undefined : mb;
}

/** Test-only: KYA_RECEIPT_MEM_POLL_MS shortens the 30 s memory poll. */
function memPollMs(env: NodeJS.ProcessEnv): number {
  const ms = Number(env.KYA_RECEIPT_MEM_POLL_MS);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMER_MS) : DEFAULT_MEM_POLL_MS;
}

export async function runReceiptServe(
  config: ResolvedConfig,
  input: { days: number; sessionId?: string },
): Promise<void> {
  const live = await startLiveReceiptServer({
    config,
    sessionId: input.sessionId,
    days: input.days,
    idleMs: receiptIdleMs(process.env),
    cwdPollMs: cwdPollMs(process.env),
    maxRssMb: receiptMaxRssMb(process.env),
    memPollMs: memPollMs(process.env),
  });
  writeDaemonState(config.cwd, {
    pid: process.pid,
    url: live.url,
    token: live.token,
    port: live.port,
    startedAt: new Date().toISOString(),
  });
  try {
    await live.waitUntilClosed;
  } finally {
    // Only remove the state file if it is still ours - a successor daemon
    // spawned during our slow shutdown must not lose its state.
    clearDaemonState(config.cwd, process.pid);
  }
}
