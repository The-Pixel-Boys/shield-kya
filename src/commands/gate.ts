/**
 * `kya gate` — local MCP gateway: govern + audit tool calls to any MCP server.
 *
 *   init    scaffold .kya/gateways.json (recipes for the well-known servers)
 *   setup   install the pinned gateway binary to .kya/bin (only downloader)
 *   doctor  binary presence/version + listener health
 *   run     generate the gateway config, start supervisor + binary detached
 *   stop    stop the supervisor (takes the binary down with it)
 */
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { ResolvedConfig } from "../config.js";
import { KyaError, UsageError } from "../errors.js";
import { pidAlive } from "../receipt/daemon.js";
import { writeFileSync } from "node:fs";
import { scaffoldGateways, readGateways, gatewaysPath } from "../gate/config.js";
import { generateGatewayYaml } from "../gate/config-gen.js";
import { ensureGateBinary, inspectGateBinary, gateBinaryPath } from "../gate/binary.js";
import {
  clearGateState,
  gateLogPath,
  gateYamlPath,
  isGateDaemonProcess,
  readGateState,
  type GateDaemonState,
} from "../gate/daemon.js";
import { globalConfigDir } from "../config.js";

function cliJsPath(): string {
  const built = fileURLToPath(new URL("../cli.js", import.meta.url));
  if (existsSync(built)) return built;
  return fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GateInitResult {
  readonly path: string;
  readonly created: boolean;
  readonly next: string;
}

export function runGateInit(env: NodeJS.ProcessEnv = process.env): GateInitResult {
  const r = scaffoldGateways(env);
  return {
    path: r.path,
    created: r.created,
    next: r.created
      ? "move a recipe into \"servers\" and fill its placeholders, then `kya gate setup && kya gate run`"
      : "gateways.json already exists — edit it, then `kya gate run`",
  };
}

export interface GateSetupResult {
  readonly path: string;
  readonly installed: boolean;
  readonly version: string;
}

export async function runGateSetup(env: NodeJS.ProcessEnv = process.env): Promise<GateSetupResult> {
  return ensureGateBinary({ env });
}

export interface GateDoctorResult {
  readonly binary: { readonly present: boolean; readonly path: string; readonly version?: string };
  readonly config: { readonly path: string; readonly servers: number };
  readonly listener: { readonly running: boolean; readonly url?: string; readonly healthy?: boolean };
  /** Loopback-only posture of the generated config (verified from gate.yaml on disk). */
  readonly bindScope: { readonly loopbackOnly: boolean; readonly detail: string };
}

/**
 * The gateway binary binds UNSPECIFIED with no config knob; loopback-only is
 * enforced by the generated networkAuthorization L4 allowlist (plus the
 * stats/readiness/admin listeners being off). Doctor verifies that posture
 * from the generated YAML, not from a claim.
 */
export function bindScopeFromYaml(env: NodeJS.ProcessEnv): { loopbackOnly: boolean; detail: string } {
  let yaml = "";
  try {
    yaml = readFileSync(gateYamlPath(env), "utf8");
  } catch {
    return { loopbackOnly: false, detail: "no generated config yet — `kya gate run` generates one" };
  }
  const hasRule =
    yaml.includes("networkAuthorization:") && yaml.includes("127.0.0.0/8") && yaml.includes("::1");
  const listenersOff =
    yaml.includes('statsAddr: "off"') && yaml.includes('readinessAddr: "off"');
  const loopbackOnly = hasRule && listenersOff;
  return {
    loopbackOnly,
    detail: loopbackOnly
      ? "loopback-only (L4 allowlist 127.0.0.0/8 + ::1; stats/readiness/admin listeners off)"
      : "WARNING: generated config is missing the loopback allowlist or listener offs — re-run `kya gate run`",
  };
}

async function probeListener(state: GateDaemonState): Promise<boolean> {
  try {
    // MCP streamable-HTTP endpoint; any HTTP answer means the listener is up
    // (a bare GET gets a 406 from the real gateway).
    const res = await fetch(`${state.url}/mcp`, {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    res.body?.cancel().catch(() => undefined);
    return true; // any HTTP answer means the listener is up
  } catch {
    return false;
  }
}

export async function runGateDoctor(env: NodeJS.ProcessEnv = process.env): Promise<GateDoctorResult> {
  const bin = inspectGateBinary(env);
  const cfg = readGateways(env);
  const state = readGateState(env);
  const running = Boolean(state && pidAlive(state.pid));
  const healthy = running && state ? await probeListener(state) : undefined;
  return {
    binary: { present: bin.present, path: bin.path, ...(bin.version ? { version: bin.version } : {}) },
    config: { path: gatewaysPath(env), servers: cfg.servers.length },
    listener: { running, ...(state ? { url: state.url } : {}), ...(healthy !== undefined ? { healthy } : {}) },
    bindScope: bindScopeFromYaml(env),
  };
}

export interface GateRunResult {
  readonly pid: number;
  readonly url: string;
  readonly port: number;
  readonly otlpPort: number;
  readonly servers: readonly string[];
  readonly configPath: string;
  readonly logPath: string;
  readonly reused: boolean;
  /** Set when a running gateway's on-disk config no longer matches gateways.json. */
  readonly drift?: boolean;
  readonly next: string;
}

/**
 * Generate the gateway YAML from gateways.json, then spawn the detached
 * supervisor (OTLP receiver + gateway binary child). Requires the binary —
 * never downloads; `kya gate setup` is the only downloader. Success is
 * reported only after the listener actually answers.
 */
export async function runGateRun(
  config: ResolvedConfig,
  input: { env?: NodeJS.ProcessEnv } = {},
): Promise<GateRunResult> {
  const env = input.env ?? process.env;
  const bin = inspectGateBinary(env);
  if (!bin.present) {
    throw new KyaError(
      `gateway binary not installed — run \`kya gate setup\` first (expected at ${gateBinaryPath(env)})`,
      "GATE_BINARY_MISSING",
    );
  }

  const gateways = readGateways(env);
  const yaml = generateGatewayYaml(gateways);

  const existing = readGateState(env);
  if (existing && pidAlive(existing.pid) && isGateDaemonProcess(existing.pid)) {
    // Never rewrite gate.yaml under a live process — the gateway watches the
    // file. Compare and report drift instead.
    let drift = false;
    try {
      drift = readFileSync(gateYamlPath(env), "utf8") !== yaml;
    } catch {
      drift = false;
    }
    return {
      pid: existing.pid,
      url: existing.url,
      port: existing.port,
      otlpPort: existing.otlpPort,
      servers: gateways.servers.map((s) => s.id),
      configPath: gateYamlPath(env),
      logPath: gateLogPath(env),
      reused: true,
      ...(drift ? { drift } : {}),
      next: drift
        ? "config changed since gateway started — `kya gate stop && kya gate run` to apply"
        : "gateway already running — `kya gate stop` first to reload config",
    };
  }
  clearGateState(env);
  mkdirSync(globalConfigDir(env), { recursive: true });
  writeFileSync(gateYamlPath(env), yaml, "utf8");

  const logPath = gateLogPath(env);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [cliJsPath(), "gate-serve"], {
    cwd: config.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...input.env, KYA_NODE_CHECKED: "1" },
  });
  child.unref();
  const pid = child.pid ?? -1;

  const fail = async (): Promise<never> => {
    await killGateProcessTree(pid, readGateState(env)?.childPid);
    clearGateState(env);
    throw new KyaError(`gateway failed to start — see ${logPath}`, "GATE_START_FAILED");
  };

  let probingSince = -1;
  for (let waited = 0; waited < 10_000; waited += 100) {
    const state = readGateState(env);
    if (state && state.pid === pid && pidAlive(pid)) {
      // Not "listening" until the listener answers.
      if (probingSince === -1) probingSince = waited;
      if (!(await probeListener(state))) {
        if (child.exitCode !== null || waited - probingSince >= 2_000) await fail();
        await sleep(200);
        continue;
      }
      return {
        pid,
        url: state.url,
        port: state.port,
        otlpPort: state.otlpPort,
        servers: gateways.servers.map((s) => s.id),
        configPath: gateYamlPath(env),
        logPath,
        reused: false,
        next:
          `point your host at ${state.url}/mcp (server key shield-kya-gate) — ` +
          "`kya connect <host> --gate` wires it; `kya gate stop` stops everything.",
      };
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  return fail();
}

/** SIGTERM a pid and wait; escalate to SIGKILL when it outlives the wait. */
async function killWithEscalation(pid: number, kill: (pid: number, signal: string) => void): Promise<void> {
  if (!pidAlive(pid)) return;
  kill(pid, "SIGTERM");
  for (let waited = 0; waited < 3_000 && pidAlive(pid); waited += 100) {
    await sleep(100);
  }
  if (pidAlive(pid)) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      /* raced exit */
    }
    for (let waited = 0; waited < 1_000 && pidAlive(pid); waited += 100) {
      await sleep(100);
    }
  }
}

function defaultSignal(pid: number, signal: string): void {
  try {
    process.kill(pid, signal as NodeJS.Signals);
  } catch {
    /* raced exit */
  }
}

/** Supervisor + gateway binary child, both reaped. */
async function killGateProcessTree(
  supervisorPid: number,
  childPid: number | undefined,
  kill: (pid: number, signal: string) => void = defaultSignal,
): Promise<void> {
  if (pidAlive(supervisorPid) && isGateDaemonProcess(supervisorPid)) {
    await killWithEscalation(supervisorPid, kill);
  }
  if (childPid !== undefined && childPid !== supervisorPid && pidAlive(childPid)) {
    await killWithEscalation(childPid, kill);
  }
}

export interface GateStopResult {
  readonly stopped: boolean;
  readonly pid?: number;
  /** Gateway binary child pid, when the state file carried one. */
  readonly childPid?: number;
  /** State file named a pid that is not our supervisor; cleared unsignaled. */
  readonly stale?: boolean;
}

export async function runGateStop(
  env: NodeJS.ProcessEnv = process.env,
  input: { kill?: (pid: number, signal: string) => void } = {},
): Promise<GateStopResult> {
  const kill = input.kill ?? defaultSignal;
  const state = readGateState(env);
  if (!state) return { stopped: false };
  if (pidAlive(state.pid) && !isGateDaemonProcess(state.pid)) {
    // Planted or recycled pid — never signal a foreign process.
    clearGateState(env);
    return { stopped: false, pid: state.pid, stale: true };
  }
  await killGateProcessTree(state.pid, state.childPid, kill);
  clearGateState(env);
  return {
    stopped: true,
    pid: state.pid,
    ...(state.childPid !== undefined ? { childPid: state.childPid } : {}),
  };
}

/** MCP endpoint hosts should point at (running gateway wins, else configured port). */
export function gateMcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  const state = readGateState(env);
  const port = state && pidAlive(state.pid) ? state.port : readGateways(env).port;
  return `http://127.0.0.1:${port}/mcp`;
}

export function formatGateDoctorHuman(r: GateDoctorResult): string {
  return [
    "KYA gate doctor",
    r.binary.present
      ? `binary: ${r.binary.path}${r.binary.version ? ` (${r.binary.version})` : ""}`
      : `binary: missing — run \`kya gate setup\``,
    `config: ${r.config.path} (${r.config.servers} server${r.config.servers === 1 ? "" : "s"})`,
    `bind scope: ${r.bindScope.detail}`,
    r.listener.running
      ? `listener: ${r.listener.url} (${r.listener.healthy ? "healthy" : "not answering"})`
      : "listener: not running — `kya gate run`",
  ].join("\n");
}

export function gateSubcommand(parsed: { positionals: readonly string[] }): string {
  const sub = parsed.positionals[0];
  if (sub === "init" || sub === "setup" || sub === "doctor" || sub === "run" || sub === "stop") {
    return sub;
  }
  throw new UsageError("Usage: kya gate <init|setup|doctor|run|stop>");
}
