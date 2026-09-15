/**
 * Background live-receipt daemon: `kya start` spawns it detached and returns
 * to the terminal. State (pid, url, token) lives in `.kya/receipt-server.json`
 * (mode 0600 — it carries the loopback auth token); stdout/stderr go to
 * `.kya/receipt-server.log`. The daemon child is the hidden `receipt-serve`
 * command, which writes the state file once it is listening and removes it on
 * shutdown.
 */
import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, isLoopbackUrl, type ResolvedConfig } from "../config.js";
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
  const path = daemonStatePath(cwd);
  // Never write through a planted symlink; force 0600 on pre-existing files
  // (the mode argument only applies at creation).
  removeIfSymlink(path);
  const fd = openSync(path, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function removeIfSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
  } catch {
    /* absent — nothing to remove */
  }
}

/**
 * Remove the state file. With expectedPid set (daemon shutdown), removal is
 * skipped when the file was already replaced by a newer daemon (pid mismatch)
 * — a dying daemon must not delete its successor's state. Read errors /
 * missing / corrupt state still remove (we own the normal case).
 */
export function clearDaemonState(cwd: string, expectedPid?: number): void {
  if (expectedPid !== undefined) {
    const state = readDaemonState(cwd);
    if (state && state.pid !== expectedPid) return;
  }
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
  const built = fileURLToPath(new URL("../cli.js", import.meta.url));
  if (existsSync(built)) return built;
  // Running from src/ (vitest) — spawn the built CLI.
  return fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
}

/**
 * Verify a pid is really our receipt daemon before signaling it.
 * On non-win32 inspect the process args; on win32 fall back to alive-only.
 */
export function isReceiptDaemonProcess(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  if (process.platform === "win32") return true;
  try {
    const args = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return args.includes("receipt-serve") && args.includes(cliJsPath());
  } catch {
    return false;
  }
}

/**
 * A stored state file is only trustworthy if its url is loopback and the
 * server behind it answers a token-authenticated handshake with 200.
 * Uses /healthz: O(1) and decoupled from render failures of the full page.
 */
async function verifyStoredDaemon(state: ReceiptDaemonState): Promise<boolean> {
  if (!isLoopbackUrl(state.url)) return false;
  try {
    const target = new URL("/healthz", new URL(state.url));
    const res = await fetch(target, {
      headers: { authorization: `Bearer ${state.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    });
    res.body?.cancel().catch(() => undefined);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** SIGTERM our own wedged daemon and wait for it to exit (past the live
 * server's 2s force-close, so its shutdown runs before we respawn). */
async function stopOwnedDaemon(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let waited = 0; waited < 2_500 && pidAlive(pid); waited += 100) {
    await sleep(100);
  }
}

/**
 * Reuse the running daemon only when its pid is alive AND the stored loopback
 * url answers the token handshake; otherwise spawn a fresh detached one and
 * wait for it to publish its state file. A wedged daemon that IS ours is
 * stopped first so failed handshakes cannot leak orphans; a foreign pid is
 * never signaled.
 */
export async function ensureReceiptDaemon(
  config: ResolvedConfig,
  input: { days: number; sessionId?: string; env?: NodeJS.ProcessEnv },
): Promise<ReceiptDaemonHandle> {
  const existing = readDaemonState(config.cwd);
  if (existing && pidAlive(existing.pid)) {
    if (await verifyStoredDaemon(existing)) {
      return { url: existing.url, pid: existing.pid, reused: true };
    }
    if (isReceiptDaemonProcess(existing.pid)) {
      await stopOwnedDaemon(existing.pid);
    }
  }
  clearDaemonState(config.cwd);

  mkdirSync(configDir(config.cwd), { recursive: true });
  const logPath = daemonLogPath(config.cwd);
  removeIfSymlink(logPath);
  const logFd = openSync(logPath, "a");
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
