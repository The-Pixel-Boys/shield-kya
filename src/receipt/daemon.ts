/**
 * Background live-receipt daemon: `kya start` spawns it detached and returns
 * to the terminal. State (pid, url, token) lives in `.kya/receipt-server.json`
 * (mode 0600 — it carries the loopback auth token); stdout/stderr go to
 * `.kya/receipt-server.log`. The daemon child is the hidden `receipt-serve`
 * command, which writes the state file once it is listening and removes it on
 * shutdown.
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, type ResolvedConfig } from "../config.js";
import { KyaError } from "../errors.js";

export interface ReceiptDaemonState {
  readonly pid: number;
  readonly url: string;
  readonly token: string;
  readonly port: number;
  readonly startedAt: string;
}

export interface ReceiptDaemonHandle {
  readonly url: string;
  readonly pid: number;
  readonly reused: boolean;
}

export function daemonStatePath(cwd: string): string {
  return join(configDir(cwd), "receipt-server.json");
}

export function daemonLogPath(cwd: string): string {
  return join(configDir(cwd), "receipt-server.log");
}

export function readDaemonState(cwd: string): ReceiptDaemonState | undefined {
  const path = daemonStatePath(cwd);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ReceiptDaemonState>;
    if (
      typeof raw.pid === "number" &&
      typeof raw.url === "string" &&
      typeof raw.token === "string" &&
      typeof raw.port === "number"
    ) {
      return raw as ReceiptDaemonState;
    }
  } catch {
    /* corrupt state — treat as absent */
  }
  return undefined;
}

export function writeDaemonState(cwd: string, state: ReceiptDaemonState): void {
  mkdirSync(configDir(cwd), { recursive: true });
  writeFileSync(daemonStatePath(cwd), `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearDaemonState(cwd: string): void {
  rmSync(daemonStatePath(cwd), { force: true });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but owned by someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cliJsPath(): string {
  // dist/receipt/daemon.js → dist/cli.js
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

/**
 * Reuse the running daemon when its pid is alive; otherwise spawn a fresh
 * detached one and wait for it to publish its state file.
 */
export async function ensureReceiptDaemon(
  config: ResolvedConfig,
  input: { days: number; sessionId?: string; env?: NodeJS.ProcessEnv },
): Promise<ReceiptDaemonHandle> {
  const existing = readDaemonState(config.cwd);
  if (existing && pidAlive(existing.pid)) {
    return { url: existing.url, pid: existing.pid, reused: true };
  }
  clearDaemonState(config.cwd);

  mkdirSync(configDir(config.cwd), { recursive: true });
  const logFd = openSync(daemonLogPath(config.cwd), "a");
  const args = [cliJsPath(), "receipt-serve", "--days", String(input.days)];
  if (input.sessionId) args.push("--session", input.sessionId);
  const child = spawn(process.execPath, args, {
    cwd: config.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      ...input.env,
      KYA_NO_BROWSER: "1",
      KYA_NODE_CHECKED: "1",
    },
  });
  child.unref();
  const pid = child.pid ?? -1;

  for (let waited = 0; waited < 10_000; waited += 100) {
    const state = readDaemonState(config.cwd);
    if (state && state.pid === pid && pidAlive(pid)) {
      return { url: state.url, pid, reused: false };
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  throw new KyaError(
    `receipt server failed to start — see ${daemonLogPath(config.cwd)}`,
    "RECEIPT_DAEMON_FAILED",
  );
}
