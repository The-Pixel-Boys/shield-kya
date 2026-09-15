/**
 * `kya stop` — stop the background live-receipt server started by `kya start`.
 */
import {
  clearDaemonState,
  isReceiptDaemonProcess,
  pidAlive,
  readDaemonState,
} from "../receipt/daemon.js";

export interface StopResult {
  readonly stopped: boolean;
  readonly pid?: number;
  /** State file pointed at a pid that is not our daemon; it was cleared. */
  readonly stale?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runStop(cwd: string): Promise<StopResult> {
  const state = readDaemonState(cwd);
  if (!state) return { stopped: false };
  if (pidAlive(state.pid) && !isReceiptDaemonProcess(state.pid)) {
    // Planted or recycled pid — never signal a foreign process.
    clearDaemonState(cwd);
    return { stopped: false, stale: true, pid: state.pid };
  }
  if (pidAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* raced exit */
    }
    for (let waited = 0; waited < 3_000 && pidAlive(state.pid); waited += 100) {
      await sleep(100);
    }
  }
  clearDaemonState(cwd);
  return { stopped: true, pid: state.pid };
}

export function formatStopHuman(r: StopResult): string {
  if (r.stale) {
    return `state file was stale (pid ${r.pid} is not the report server) — cleared it`;
  }
  return r.stopped
    ? `stopped report server (pid ${r.pid})`
    : "no report server running";
}
