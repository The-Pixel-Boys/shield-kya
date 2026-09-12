/**
 * Node version gate with a guided upgrade. The package declares
 * `engines.node: >=24`; on an older runtime the CLI warns, and on a TTY it
 * offers to install Node 24 via the detected version manager, reinstall the
 * global package under it, and re-run the original command. Declining (or a
 * non-TTY run) continues with a warning — the gate never blocks outright.
 *
 * Escape hatches: KYA_SKIP_NODE_CHECK=1 skips entirely; KYA_NODE_CHECKED=1 is
 * set by the upgrade re-exec and by the receipt daemon child so the check
 * never loops.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const REQUIRED_NODE_MAJOR = 24;

export type NodeManager = "volta" | "fnm" | "nvm" | "brew";

export interface NodeGateDeps {
  readonly version?: string;
  readonly platform?: NodeJS.Platform;
  readonly hasCmd?: (cmd: string) => boolean;
  readonly hasFile?: (path: string) => boolean;
  readonly run?: (shell: string, args: readonly string[]) => Promise<number>;
}

export function currentNodeMajor(version: string = process.version): number {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function nodeSatisfied(version: string = process.version): boolean {
  return currentNodeMajor(version) >= REQUIRED_NODE_MAJOR;
}

function defaultHasCmd(cmd: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

function nvmScriptPath(env: NodeJS.ProcessEnv): string {
  return join(env.NVM_DIR ?? join(env.HOME ?? "", ".nvm"), "nvm.sh");
}

/** Priority: dedicated managers first, brew last (shared global prefix). */
export function detectNodeManager(
  env: NodeJS.ProcessEnv,
  deps: NodeGateDeps = {},
): NodeManager | undefined {
  const hasCmd = deps.hasCmd ?? defaultHasCmd;
  const hasFile = deps.hasFile ?? existsSync;
  const platform = deps.platform ?? process.platform;
  if (hasCmd("volta")) return "volta";
  if (hasCmd("fnm")) return "fnm";
  if (platform !== "win32" && hasFile(nvmScriptPath(env))) return "nvm";
  if (platform !== "win32" && hasCmd("brew")) return "brew";
  return undefined;
}

function rerunTail(argv: readonly string[]): string {
  // --force on start so MCP blocks are rewritten to the new node's execPath.
  const needsForce = argv[0] === "start" && !argv.includes("--force");
  const args = [...argv, ...(needsForce ? ["--force"] : [])];
  return `npm i -g @shield-agent/kya@latest && KYA_NODE_CHECKED=1 kya ${args.join(" ")}`;
}

/** Shell script that installs Node 24, reinstalls the CLI, and re-runs argv. */
export function buildUpgradeScript(
  manager: NodeManager,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): { shell: string; args: readonly string[] } {
  const tail = rerunTail(argv);
  const platform = process.platform;
  if (platform === "win32") {
    // Only volta/fnm are supported on Windows; && chaining works in cmd.
    const install = manager === "volta" ? "volta install node@24" : "fnm install 24 && fnm default 24";
    return { shell: "cmd", args: ["/c", `${install} && ${tail}`] };
  }
  const lines: string[] = ["set -e"];
  switch (manager) {
    case "volta":
      lines.push("volta install node@24");
      break;
    case "fnm":
      lines.push("fnm install 24", "fnm default 24", 'eval "$(fnm env --shell bash)"');
      break;
    case "nvm":
      lines.push(
        `export NVM_DIR="${env.NVM_DIR ?? "$HOME/.nvm"}"`,
        '. "$NVM_DIR/nvm.sh"',
        "nvm install 24",
        "nvm alias default 24",
      );
      break;
    case "brew":
      lines.push("brew install node || brew upgrade node");
      break;
  }
  lines.push(tail);
  return { shell: "bash", args: ["-c", lines.join("\n")] };
}

async function defaultRun(shell: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function defaultConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(!/^n(o)?$/i.test(answer.trim()));
    });
  });
}

export interface NodeGateIo {
  readonly error: (msg: string) => void;
  readonly isTty?: boolean;
  readonly confirm?: (question: string) => Promise<boolean>;
}

const SKIP_COMMANDS = new Set(["help", "serve-mcp", "receipt-serve"]);

/**
 * Returns an exit code when the upgrade ran and the original command was
 * handed off to the new Node; undefined when the current process should
 * continue normally.
 */
export async function ensureSupportedNode(
  io: NodeGateIo,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  command: string | undefined,
  deps: NodeGateDeps = {},
): Promise<number | undefined> {
  if (!command || SKIP_COMMANDS.has(command)) return undefined;
  if (env.KYA_SKIP_NODE_CHECK === "1" || env.KYA_NODE_CHECKED === "1") return undefined;
  const version = deps.version ?? process.version;
  if (nodeSatisfied(version)) return undefined;

  const warn = `KYA needs Node.js ${REQUIRED_NODE_MAJOR}+ (you have ${version}).`;
  const isTty = io.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const confirm = io.confirm ?? defaultConfirm;
  if (!isTty) {
    io.error(`${warn} Continuing anyway — some features may break.`);
    return undefined;
  }

  const manager = detectNodeManager(env, deps);
  const question = manager
    ? `${warn} Upgrade to Node 24 via ${manager} now and continue? [Y/n]`
    : `${warn} No version manager found (nodejs.org/en/download). Continue anyway? [Y/n]`;
  const ok = await confirm(question);
  if (!ok) {
    io.error("Continuing on an unsupported Node — some features may break.");
    return undefined;
  }
  if (!manager) return undefined;

  const script = buildUpgradeScript(manager, env, argv);
  const run = deps.run ?? defaultRun;
  return run(script.shell, script.args);
}
