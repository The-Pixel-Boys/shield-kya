/**
 * `kya stop` — stop the background live-receipt server started by `kya start`.
 * `--all` additionally sweeps orphaned `receipt-serve` daemons from other
 * cwds or older installs that the cwd state file does not know about.
 */
import {
  clearDaemonState,
  findReceiptDaemonPids,
  isReceiptDaemonProcess,
  listOwnedProcesses,
  pidAlive,
  readDaemonState,
  type DaemonProc,
} from "../receipt/daemon.js";

export interface StopResult {
  readonly stopped: boolean;
  readonly pid?: number;
  /** State file pointed at a pid that is not our daemon; it was cleared. */
  readonly stale?: boolean;
  /** Pids of daemons beyond the cwd state file stopped by --all. */
  readonly extraStopped?: readonly number[];
  /** --all was requested but the orphan sweep is unsupported here (win32). */
  readonly sweepUnsupported?: boolean;
}

export interface StopOptions {
  /** Also stop any running `cli.js receipt-serve` daemon owned by this user. */
  readonly all?: boolean;
  /** Injectable process snapshot (tests); defaults to a live ps listing. */
  readonly procs?: readonly DaemonProc[];
  /** Injectable signaler (tests); defaults to SIGTERM. */
  readonly kill?: (pid: number) => void;
  /** Injectable platform (tests); defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultKill(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* raced exit */
  }
}

export async function runStop(cwd: string, options: StopOptions = {}): Promise<StopResult> {
  const state = readDaemonState(cwd);
  let stopped = false;
  let stale = false;
  if (state) {
    if (pidAlive(state.pid) && !isReceiptDaemonProcess(state.pid)) {
      // Planted or recycled pid — never signal a foreign process.
      clearDaemonState(cwd);
      stale = true;
    } else {
      if (pidAlive(state.pid)) {
        defaultKill(state.pid);
        for (let waited = 0; waited < 3_000 && pidAlive(state.pid); waited += 100) {
          await sleep(100);
        }
      }
      clearDaemonState(cwd);
      stopped = true;
    }
  }

  let extraStopped: readonly number[] | undefined;
  let sweepUnsupported = false;
  if (options.all) {
    const platform = options.platform ?? process.platform;
    if (platform === "win32") {
      // tasklist exposes no command lines, so orphans cannot be identified —
      // report the limitation instead of claiming none are running.
      sweepUnsupported = true;
      extraStopped = [];
    } else {
      const kill = options.kill ?? defaultKill;
      const procs = options.procs ?? listOwnedProcesses(platform);
      const extra: number[] = [];
      for (const pid of findReceiptDaemonPids(procs)) {
        if (stopped && pid === state?.pid) continue; // already handled above
        kill(pid);
        for (let waited = 0; waited < 3_000 && pidAlive(pid); waited += 100) {
          await sleep(100);
        }
        extra.push(pid);
      }
      extraStopped = extra;
    }
  }

  return {
    stopped,
    pid: state?.pid,
    stale: stale || undefined,
    extraStopped,
    sweepUnsupported: sweepUnsupported || undefined,
  };
}

export function formatStopHuman(r: StopResult): string {
  const lines: string[] = [];
  if (r.stale) {
    lines.push(`state file was stale (pid ${r.pid} is not the report server) — cleared it`);
  } else {
    lines.push(
      r.stopped ? `stopped report server (pid ${r.pid})` : "no report server running",
    );
  }
  if (r.sweepUnsupported) {
    lines.push(
      "sweep of other receipt daemons is not supported on this platform (win32) — any orphans must be stopped manually",
    );
  } else if (r.extraStopped) {
    lines.push(
      r.extraStopped.length > 0
        ? `stopped ${r.extraStopped.length} other receipt daemon(s): ${r.extraStopped
            .map((pid) => `pid ${pid}`)
            .join(", ")}`
        : "no other receipt daemons running",
    );
  }
  return lines.join("\n");
}
