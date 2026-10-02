/**
 * Hidden supervisor: runs the OTLP receiver and the gateway binary as its
 * child in the foreground, publishing `<global .kya>/gate-server.json` once
 * up. Spawned detached by `kya gate run` — never invoked by users directly.
 * SIGTERM/SIGINT (or a dead binary child) shuts both down.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { UsageError } from "../errors.js";
import { readGateways } from "../gate/config.js";
import {
  syncGatewayToHosted,
  type GatewayHostedState,
} from "../gate/hosted-sync.js";
import { gateBinaryPath } from "../gate/binary.js";
import {
  clearGateState,
  gateYamlPath,
  writeGateState,
} from "../gate/daemon.js";
import { startOtlpReceiver, type OtlpReceiver } from "../gate/otlp-receiver.js";

export interface GateServeHandle {
  readonly pid: number;
  readonly childPid: number | undefined;
  readonly url: string;
  readonly port: number;
  readonly otlpPort: number;
  readonly waitUntilClosed: Promise<void>;
  /** Test-safe stop (production stops via SIGTERM to the detached process). */
  readonly stop: () => void;
}

/**
 * Start the receiver + binary child and publish the state file. Exported for
 * lifecycle tests: pass a fake `binaryPath` (any executable, e.g. a shell
 * script) and an ephemeral OTLP port override.
 */
export async function startGateSupervisor(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
  readonly otlpPort?: number;
}): Promise<GateServeHandle> {
  const env = input.env ?? process.env;
  const gateways = readGateways(env);
  const otlpPort = input.otlpPort ?? gateways.otlpPort;
  const binary = input.binaryPath ?? gateBinaryPath(env);

  let receiver: OtlpReceiver;
  try {
    receiver = await startOtlpReceiver({
      port: otlpPort,
      cwd: input.cwd,
      fallbackSessionId: `gate-${randomUUID()}`,
      env,
    });
  } catch (err) {
    throw new UsageError(
      `gate OTLP receiver could not bind 127.0.0.1:${otlpPort} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const child: ChildProcess = spawn(binary, ["-f", gateYamlPath(env)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...env },
  });

  const url = `http://127.0.0.1:${gateways.port}`;
  const startedAt = new Date().toISOString();
  writeGateState(
    {
      pid: process.pid,
      ...(child.pid !== undefined ? { childPid: child.pid } : {}),
      url,
      port: gateways.port,
      otlpPort: receiver.port,
      startedAt,
    },
    env,
  );

  const baseUrl = (env.KYA_BASE_URL ?? "").trim();
  const apiKey = (env.KYA_API_KEY ?? env.SHIELD_API_KEY ?? "").trim();
  const hostedSyncEnabled = Boolean(baseUrl && apiKey);

  function doHostedSync(state: GatewayHostedState, force?: boolean): void {
    if (!hostedSyncEnabled) return;
    try {
      void syncGatewayToHosted({
        cwd: input.cwd,
        env,
        gatewaysConfig: readGateways(env),
        supervisorState:
          state === "running"
            ? { state: "running", url, port: gateways.port, startedAt, binaryVersion: undefined }
            : { state: "configured-stopped" },
        baseUrl,
        apiKey,
        force,
      });
    } catch {
      /* sync is best-effort — never crash the supervisor */
    }
  }

  // Initial running sync + 60s heartbeat (only when credentials are configured).
  doHostedSync("running", true);
  const heartbeat = hostedSyncEnabled
    ? setInterval(() => doHostedSync("running", true), 60_000)
    : undefined;

  let shutdownFn: () => void = () => {};
  const waitUntilClosed = new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      if (heartbeat) clearInterval(heartbeat);
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      if (child.exitCode === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      // Fire-and-forget a final "configured-stopped" sync before we exit.
      doHostedSync("configured-stopped");
      void receiver
        .close()
        .catch(() => undefined)
        .finally(() => {
          clearGateState(env, process.pid);
          resolve();
        });
    };
    shutdownFn = shutdown;
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    child.once("exit", () => shutdown());
  });

  return {
    pid: process.pid,
    childPid: child.pid ?? undefined,
    url,
    port: gateways.port,
    otlpPort: receiver.port,
    waitUntilClosed,
    stop: () => shutdownFn(),
  };
}

export async function runGateServe(cwd: string): Promise<void> {
  const handle = await startGateSupervisor({ cwd });
  await handle.waitUntilClosed;
}
