/**
 * `kya update` - explicit self-update to the latest npm version.
 *
 * Tries to detect the package manager that installed the current binary
 * (npm/pnpm/yarn/volta) and run the appropriate global install command.
 * Falls back to printing the manual install command when detection fails.
 */
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";

export type PackageManager = "npm" | "pnpm" | "yarn" | "volta" | "npx" | "unknown";

export interface UpdateCommandIo {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
}

const defaultIo: UpdateCommandIo = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
};

export function detectPackageManager(execPath: string): PackageManager {
  let path = execPath;
  try {
    path = realpathSync(execPath);
  } catch {
    /* path may not exist in tests or for deleted binaries; fall back to argv path */
  }
  const lower = path.toLowerCase();
  if (lower.includes(".volta")) return "volta";
  if (lower.includes("_npx") || lower.includes(".npm/_npx") || lower.includes("npx")) return "npx";
  // pnpm global dir patterns: pnpm/global, .pnpm-store, or the pnpm-managed module path
  if (
    lower.includes("pnpm/global") ||
    lower.includes(".pnpm-store") ||
    lower.includes("/pnpm/") ||
    lower.includes("\\pnpm\\")
  ) {
    return "pnpm";
  }
  if (lower.includes("yarn/global") || lower.includes(".config/yarn")) return "yarn";
  // npm is the default; node_modules under an npm-managed global tree.
  if (lower.includes("node_modules")) return "npm";
  return "unknown";
}

export function buildInstallCommand(manager: PackageManager): {
  command: string;
  args: readonly string[];
  hint?: string;
} | null {
  switch (manager) {
    case "volta":
      return { command: "volta", args: ["install", "@shield-agent/kya@latest"] };
    case "pnpm":
      return { command: "pnpm", args: ["add", "-g", "@shield-agent/kya@latest"] };
    case "yarn":
      return { command: "yarn", args: ["global", "add", "@shield-agent/kya@latest"] };
    case "npm":
      return { command: "npm", args: ["i", "-g", "@shield-agent/kya@latest"] };
    case "npx":
      return {
        command: "npm",
        args: ["i", "-g", "@shield-agent/kya@latest"],
        hint: "npx runs a temporary copy. Install globally to keep updates:",
      };
    default:
      return null;
  }
}

export function manualUpdateCommand(): string {
  return "npm i -g @shield-agent/kya@latest";
}

function defaultRun(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export interface UpdateCommandDeps {
  readonly execPath?: string;
  readonly run?: (command: string, args: readonly string[]) => Promise<number>;
  readonly io?: UpdateCommandIo;
}

export async function runUpdate(deps: UpdateCommandDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo;
  const execPath = deps.execPath ?? (process.argv[1] ?? "");
  const manager = detectPackageManager(execPath);
  const install = buildInstallCommand(manager);

  if (!install) {
    io.log(`Could not detect the package manager that installed KYA.`);
    io.log(`Run this manually: ${manualUpdateCommand()}`);
    return 0;
  }

  if (install.hint) {
    io.log(install.hint);
  }

  const commandStr = `${install.command} ${install.args.join(" ")}`;
  io.log(`Running: ${commandStr}`);
  const run = deps.run ?? defaultRun;
  const code = await run(install.command, install.args);
  if (code === 0) {
    io.log("KYA updated. Restart your terminal or run `hash -r` if the old binary is still on PATH.");
  } else {
    io.error(`Update command exited with code ${code}. Try running it manually:\n  ${commandStr}`);
  }
  return code;
}
