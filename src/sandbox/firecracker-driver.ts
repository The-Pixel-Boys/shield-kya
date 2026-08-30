import { accessSync, constants, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { spawn } from "node:child_process";
import { UsageError } from "../errors.js";
import { assertSandboxId } from "./id.js";
import type { SandboxDriver } from "./types.js";

const pids = new Map<string, number>();
const socks = new Map<string, string>();

function resolveBin(name: string, envName: string): string {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) {
    if (!fromEnv.startsWith("/") || basename(fromEnv) !== name) {
      throw new UsageError(
        `${envName} must be an absolute path whose basename is ${name}`,
      );
    }
    accessSync(fromEnv, constants.X_OK);
    return fromEnv;
  }
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir || dir === "." || dir.startsWith(".")) continue;
    const candidate = `${dir.replace(/\/+$/, "")}/${name}`;
    if (!candidate.startsWith("/")) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* continue */
    }
  }
  throw new UsageError(
    `${name} not found: set ${envName} to an absolute path or install on PATH (not shipped in npm)`,
  );
}

/**
 * Real Firecracker/jailer driver. Binaries and kernel/rootfs must be operator-supplied.
 */
export function createFirecrackerDriver(): SandboxDriver {
  const firecracker = resolveBin("firecracker", "KYA_SANDBOX_FIRECRACKER");
  const jailer = resolveBin("jailer", "KYA_SANDBOX_JAILER");
  return {
    backend: "firecracker",
    async spawn(input) {
      const id = assertSandboxId(input.sandboxId);
      if (!input.kernelPath?.startsWith("/") || !input.rootfsPath?.startsWith("/")) {
        throw new UsageError(
          "KYA_SANDBOX_KERNEL and KYA_SANDBOX_ROOTFS must be absolute paths (not shipped)",
        );
      }
      const sock = `/run/kya-fc-${id}.sock`;
      const child = spawn(
        jailer,
        [
          "--id",
          id,
          "--exec-file",
          firecracker,
          "--",
          "--api-sock",
          sock,
          "--config-file",
          "/dev/null",
        ],
        { stdio: "ignore", detached: false },
      );
      if (child.pid == null) {
        throw new UsageError("jailer did not start");
      }
      pids.set(id, child.pid);
      socks.set(id, sock);
      child.on("exit", () => {
        pids.delete(id);
      });
    },
    async exec() {
      throw new UsageError(
        "firecracker exec requires vsock wiring for this host; use KYA_SANDBOX=mock in tests",
      );
    },
    async kill(sandboxId) {
      const id = assertSandboxId(sandboxId);
      const pid = pids.get(id);
      if (pid != null) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        pids.delete(id);
      }
      const sock = socks.get(id);
      if (sock) {
        try {
          unlinkSync(sock);
        } catch {
          /* missing */
        }
        socks.delete(id);
      }
    },
  };
}

export function firecrackerTrackedPid(sandboxId: string): number | undefined {
  return pids.get(sandboxId);
}
