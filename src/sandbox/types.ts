export type SandboxBackend = "firecracker";

export interface SandboxRecord {
  readonly sandboxId: string;
  readonly backend: SandboxBackend;
  readonly createdAt: string;
  readonly status: "running" | "killed";
  readonly agentId?: string;
}

export interface SandboxDriver {
  readonly backend: SandboxBackend;
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
