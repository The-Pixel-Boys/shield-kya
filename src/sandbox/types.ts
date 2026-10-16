export type SandboxBackend = "firecracker" | "openshell";

export interface SandboxRecord {
  readonly sandboxId: string;
  readonly backend: SandboxBackend;
  readonly createdAt: string;
  readonly status: "running" | "killed";
  readonly agentId?: string;
  /** Backend-side name, when the backend keeps its own (openshell sandbox name). */
  readonly externalName?: string;
}

export interface SandboxDriver {
  readonly backend: SandboxBackend;
  /** Backend-side name for a spawned sandbox, when the backend has one. */
  readonly externalNameFor?: (sandboxId: string) => string | undefined;
  spawn(input: {
    sandboxId: string;
    kernelPath: string;
    rootfsPath: string;
  }): Promise<void>;
  exec(input: {
    sandboxId: string;
    command: string[];
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  kill(sandboxId: string): Promise<void>;
}
