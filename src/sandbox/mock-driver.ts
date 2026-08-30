import type { SandboxDriver } from "./types.js";

/** In-memory driver for unit tests — never talks to a real VMM. */
export function createMockDriver(): SandboxDriver & {
  readonly live: Set<string>;
} {
  const live = new Set<string>();
  return {
    backend: "firecracker",
    live,
    async spawn(input) {
      live.add(input.sandboxId);
    },
    async exec(input) {
      if (!live.has(input.sandboxId)) {
        throw new Error(`sandbox not running: ${input.sandboxId}`);
      }
      return {
        exitCode: 0,
        stdout: `mock-exec ${input.command.join(" ")}`,
        stderr: "",
      };
    },
    async kill(sandboxId) {
      live.delete(sandboxId);
    },
  };
}
