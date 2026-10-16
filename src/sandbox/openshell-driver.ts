import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { UsageError } from "../errors.js";
import { resolveBin } from "./firecracker-driver.js";
import { assertSandboxId } from "./id.js";
import { writeOpenshellPolicy } from "./openshell-policy.js";
import type { SandboxDriver } from "./types.js";

/**
 * NVIDIA OpenShell driver (github.com/NVIDIA/OpenShell, Apache 2.0). Shells
 * out to the `openshell` CLI (`openshell sandbox create/exec/delete`) with a
 * generated version 1 policy. Requires docker or podman on PATH.
 *
 * KYA never ships the openshell binary or a container runtime; both must be
 * operator-supplied. Telemetry is always disabled on the spawned environment:
 * OPENSHELL_TELEMETRY_ENABLED=false is set on every CLI invocation.
 */
export const OPENSHELL_MIN_VERSION = ">=0.1.0";

/** sbx-<uuid> -> openshell-side sandbox name. */
const externalNames = new Map<string, string>();

function onPath(name: string): boolean {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir || dir === "." || dir.startsWith(".")) continue;
    const candidate = `${dir.replace(/\/+$/, "")}/${name}`;
    if (!candidate.startsWith("/")) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

function openshellEnv(): NodeJS.ProcessEnv {
  return { ...process.env, OPENSHELL_TELEMETRY_ENABLED: "false" };
}

function floorParts(): [number, number, number] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(OPENSHELL_MIN_VERSION);
  if (!m) throw new Error(`OPENSHELL_MIN_VERSION is unparsable: ${OPENSHELL_MIN_VERSION}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionAtLeast(version: string, floor: [number, number, number]): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== floor[i]) return parts[i] > floor[i];
  }
  return true;
}

/**
 * Preflight for the spawn path: openshell on PATH, a container runtime
 * (docker or podman) present, and the CLI version at or above the pinned
 * floor. Throws UsageError naming the fix.
 */
export function preflightOpenshell(): { readonly bin: string; readonly version: string } {
  const bin = resolveBin("openshell", "KYA_SANDBOX_OPENSHELL");
  if (!onPath("docker") && !onPath("podman")) {
    throw new UsageError(
      "openshell needs a container runtime: install docker or podman on PATH (https://github.com/NVIDIA/OpenShell)",
    );
  }
  let version: string;
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: openshellEnv(),
      timeout: 10_000,
    }).trim();
    version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? out.split("\n")[0]?.trim() ?? "";
  } catch (err) {
    throw new UsageError(
      `openshell --version failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!versionAtLeast(version, floorParts())) {
    throw new UsageError(
      `openshell ${version} is too old: KYA requires ${OPENSHELL_MIN_VERSION}; upgrade OpenShell (https://github.com/NVIDIA/OpenShell)`,
    );
  }
  return { bin, version };
}

/** `openshell sandbox create` prints JSON with the backend id/name; fall back to our --name. */
function parseExternalName(stdout: string, fallback: string): string {
  try {
    const parsed = JSON.parse(stdout) as { id?: unknown; name?: unknown };
    const name = typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : typeof parsed.id === "string" && parsed.id.trim()
        ? parsed.id.trim()
        : undefined;
    if (name) return name;
  } catch {
    /* not JSON: fall through */
  }
  const line = stdout.split("\n").find((l) => l.trim());
  return line ?? fallback;
}

function run(bin: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: openshellEnv(),
      timeout: 60_000,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    if (typeof e.status === "number") {
      return { exitCode: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
    throw new UsageError(`openshell ${args[0] ?? ""} failed: ${e.message ?? String(err)}`);
  }
}

export function createOpenshellDriver(input: {
  readonly root: string;
}): SandboxDriver {
  const root = input.root;
  return {
    backend: "openshell",
    externalNameFor(sandboxId) {
      return externalNames.get(assertSandboxId(sandboxId));
    },
    async spawn(spawnInput) {
      const id = assertSandboxId(spawnInput.sandboxId);
      const { bin } = preflightOpenshell();
      const policyPath = writeOpenshellPolicy(root, id);
      const name = `kya-${id}`;
      const created = run(bin, [
        "sandbox",
        "create",
        "--name",
        name,
        "--policy",
        policyPath,
      ]);
      if (created.exitCode !== 0) {
        throw new UsageError(
          `openshell sandbox create failed (${created.exitCode}): ${created.stderr || created.stdout}`,
        );
      }
      externalNames.set(id, parseExternalName(created.stdout, name));
    },
    async exec(execInput) {
      const id = assertSandboxId(execInput.sandboxId);
      const bin = resolveBin("openshell", "KYA_SANDBOX_OPENSHELL");
      const name = externalNames.get(id) ?? `kya-${id}`;
      return run(bin, ["sandbox", "exec", name, "--", ...execInput.command]);
    },
    async kill(sandboxId) {
      const id = assertSandboxId(sandboxId);
      const bin = resolveBin("openshell", "KYA_SANDBOX_OPENSHELL");
      const name = externalNames.get(id) ?? `kya-${id}`;
      try {
        run(bin, ["sandbox", "delete", name]);
      } catch {
        /* already gone: kill is best-effort, state file marks it killed */
      }
      externalNames.delete(id);
    },
  };
}

/** Test hook: drop cached backend names. */
export function openshellResetForTests(): void {
  externalNames.clear();
}
