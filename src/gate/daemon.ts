/**
 * Gate supervisor lifecycle. `kya gate run` spawns a detached
 * `cli.js gate-serve` supervisor (global state in `<global .kya>/gate-server.json`,
 * logs in `<global .kya>/logs/gate.log`), which owns the OTLP receiver and
 * the gateway binary child. `kya gate stop` signals the supervisor; the
 * supervisor takes the binary down with it.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { pidAlive, type DaemonProc } from "../receipt/daemon.js";

export interface GateDaemonState {
  readonly pid: number;
  /** Gateway binary child pid. */
  readonly childPid?: number;
  readonly url: string;
  readonly port: number;
  readonly otlpPort: number;
  /** Uptime anchor; dropped when the state file carries a non-string value. */
  readonly startedAt?: string;
}

export function gateStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "gate-server.json");
}

export function gateLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "logs", "gate.log");
}

export function gateYamlPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "gate.yaml");
}

export function readGateState(
  env: NodeJS.ProcessEnv = process.env,
): GateDaemonState | undefined {
  const path = gateStatePath(env);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GateDaemonState>;
    if (
      typeof raw.pid === "number" &&
      typeof raw.url === "string" &&
      typeof raw.port === "number" &&
      typeof raw.otlpPort === "number"
    ) {
      return {
        pid: raw.pid,
        ...(typeof raw.childPid === "number" ? { childPid: raw.childPid } : {}),
        url: raw.url,
        port: raw.port,
        otlpPort: raw.otlpPort,
        ...(typeof raw.startedAt === "string" ? { startedAt: raw.startedAt } : {}),
      };
    }
  } catch {
    /* corrupt state — treat as absent */
  }
  return undefined;
}

function removeIfSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
  } catch {
    /* absent */
  }
}

export function writeGateState(state: GateDaemonState, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(globalConfigDir(env), { recursive: true });
  const path = gateStatePath(env);
  removeIfSymlink(path);
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** A dying supervisor must not delete a successor's state file. */
export function clearGateState(env: NodeJS.ProcessEnv = process.env, expectedPid?: number): void {
  if (expectedPid !== undefined) {
    const state = readGateState(env);
    if (state && state.pid !== expectedPid) return;
  }
  rmSync(gateStatePath(env), { force: true });
}

/**
 * Pids of running `cli.js gate-serve` supervisors, for orphan sweeps. Same
 * discipline as findReceiptDaemonPids: standalone argv token, never this
 * process, SIGTERM only.
 */
export function findGateDaemonPids(procs: readonly DaemonProc[]): number[] {
  const token = /(^|\s|\/)gate-serve(\s|$)/;
  return procs
    .filter((p) => p.pid !== process.pid && p.args.includes("cli.js") && token.test(p.args))
    .map((p) => p.pid);
}

/**
 * Pids of stray gateway binaries (`<…>/.kya/bin/kya-gate -f …`) whose
 * supervisor died without reaping them. The binary path must contain the
 * kya bin dir so a foreign binary that happens to share the name is never
 * signaled.
 */
export function findGateBinaryPids(procs: readonly DaemonProc[]): number[] {
  const token = /(^|\s|\/)kya-gate(\.exe)?(\s|$)/;
  return procs
    .filter(
      (p) =>
        p.pid !== process.pid &&
        token.test(p.args) &&
        p.args.includes(`${join(".kya", "bin")}`),
    )
    .map((p) => p.pid);
}

/**
 * Verify a pid is really our gate supervisor before signaling it (mirrors
 * isReceiptDaemonProcess): on non-win32 inspect argv; win32 falls back to
 * alive-only. A recycled or planted pid must never be signaled.
 */
export function isGateDaemonProcess(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  if (process.platform === "win32") return true;
  try {
    const args = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return args.includes("gate-serve") && args.includes("cli.js");
  } catch {
    return false;
  }
}

export { pidAlive };
