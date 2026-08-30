import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../errors.js";
import { createFirecrackerDriver } from "./firecracker-driver.js";
import { createMockDriver } from "./mock-driver.js";
import { assertSandboxId } from "./id.js";
import { assertInsideRoot, jailRoot } from "./path-jail.js";
import type { SandboxDriver, SandboxRecord } from "./types.js";

export function resolveSandboxDriver(
  backend: string | undefined,
): SandboxDriver {
  const b = (backend ?? process.env.KYA_SANDBOX ?? "").trim().toLowerCase();
  if (!b) {
    throw new UsageError(
      "sandbox is opt-in: set KYA_SANDBOX=firecracker or KYA_SANDBOX=mock",
    );
  }
  if (b === "mock") return createMockDriver();
  if (b === "firecracker") return createFirecrackerDriver();
  throw new UsageError(`unknown sandbox backend: ${b}`);
}

export function sandboxStatePath(root: string): string {
  return join(root, ".kya", "sandboxes.json");
}

export function loadSandboxState(root: string): SandboxRecord[] {
  const jailed = jailRoot(root);
  const path = sandboxStatePath(jailed);
  assertInsideRoot(path, jailed, "sandbox state");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as SandboxRecord[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveSandboxState(root: string, rows: SandboxRecord[]): void {
  const jailed = jailRoot(root);
  const dir = join(jailed, ".kya");
  mkdirSync(dir, { recursive: true });
  const path = sandboxStatePath(jailed);
  assertInsideRoot(path, jailed, "sandbox state");
  writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
}

export async function spawnSandbox(input: {
  root: string;
  driver: SandboxDriver;
  agentId?: string;
  kernelPath?: string;
  rootfsPath?: string;
}): Promise<SandboxRecord> {
  const sandboxId = `sbx-${randomUUID()}`;
  assertSandboxId(sandboxId);
  await input.driver.spawn({
    sandboxId,
    kernelPath: input.kernelPath ?? process.env.KYA_SANDBOX_KERNEL ?? "",
    rootfsPath: input.rootfsPath ?? process.env.KYA_SANDBOX_ROOTFS ?? "",
  });
  const row: SandboxRecord = {
    sandboxId,
    backend: input.driver.backend,
    createdAt: new Date().toISOString(),
    status: "running",
    agentId: input.agentId,
  };
  const rows = loadSandboxState(input.root).filter((r) => r.status === "running");
  rows.push(row);
  saveSandboxState(input.root, rows);
  return row;
}

export async function killSandbox(input: {
  root: string;
  driver: SandboxDriver;
  sandboxId: string;
}): Promise<void> {
  const id = assertSandboxId(input.sandboxId);
  await input.driver.kill(id);
  const rows = loadSandboxState(input.root).map((r) =>
    r.sandboxId === id ? { ...r, status: "killed" as const } : r,
  );
  saveSandboxState(input.root, rows);
}
