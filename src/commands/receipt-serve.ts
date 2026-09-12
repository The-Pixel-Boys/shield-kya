/**
 * Hidden daemon entry: runs the live receipt server in the foreground and
 * publishes `.kya/receipt-server.json` (pid, url, token) once listening.
 * Spawned detached by `ensureReceiptDaemon` — never invoked by users directly.
 */
import type { ResolvedConfig } from "../config.js";
import { startLiveReceiptServer } from "../receipt/live-server.js";
import { clearDaemonState, writeDaemonState } from "../receipt/daemon.js";

export async function runReceiptServe(
  config: ResolvedConfig,
  input: { days: number; sessionId?: string },
): Promise<void> {
  const live = await startLiveReceiptServer({
    config,
    sessionId: input.sessionId,
    days: input.days,
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
    clearDaemonState(config.cwd);
  }
}
