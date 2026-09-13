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
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

export const REQUIRED_NODE_MAJOR = 24;

export type NodeManager = "volta" | "fnm" | "nvm" | "brew";

export interface NodeGateDeps {
  readonly version?: string;
  readonly platform?: NodeJS.Platform;
  readonly hasCmd?: (cmd: string) => boolean;
  readonly hasFile?: (path: string) => boolean;
  readonly run?: (cmd: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;
  readonly readdir?: (dir: string) => readonly string[];
  readonly firstNodeOnPath?: () => string | undefined;
  readonly cliJs?: string;
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

function safeReaddir(dir: string): readonly string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function bestSatisfying(entries: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestMajor = -1;
  let bestMinor = -1;
  let bestPatch = -1;
  for (const entry of entries) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(entry);
    if (!match) continue;
    const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (major < REQUIRED_NODE_MAJOR) continue;
    if (
      major > bestMajor ||
      (major === bestMajor && minor > bestMinor) ||
      (major === bestMajor && minor === bestMinor && patch > bestPatch)
    ) {
      best = `v${major}.${minor}.${patch}`;
      bestMajor = major;
      bestMinor = minor;
      bestPatch = patch;
    }
  }
  return best;
}

function managerVersionsDir(manager: NodeManager, env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME ?? "";
  switch (manager) {
    case "nvm":
      return join(env.NVM_DIR ?? join(home, ".nvm"), "versions", "node");
    case "volta":
      return join(home, ".volta", "tools", "image", "node");
    case "fnm":
      return join(env.FNM_DIR ?? join(home, ".local", "share", "fnm"), "node-versions");
    case "brew":
      return undefined; // cellar layout varies; rely on the prompt path
  }
}

/**
 * Newest already-installed Node that satisfies the requirement, per the
 * manager's own versions dir. The gate uses this to never re-offer an install
 * that already succeeded — a repeat prompt means the shell is shadowing the
 * manager's node, not that the upgrade is missing.
 */
export function findInstalledNode(
  manager: NodeManager,
  env: NodeJS.ProcessEnv,
  deps: NodeGateDeps = {},
): string | undefined {
  const dir = managerVersionsDir(manager, env);
  if (!dir) return undefined;
  const readdir = deps.readdir ?? safeReaddir;
  return bestSatisfying(readdir(dir));
}

function defaultFirstNodeOnPath(): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === "win32" ? "node.exe" : "node");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * cli.js sits next to this module when compiled (dist/), one level down in
 * dist/ when running from source (tests). Resolve whichever exists.
 */
function defaultCliJs(): string {
  const compiled = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  return fileURLToPath(new URL("../dist/cli.js", import.meta.url));
}

function switchHint(manager: NodeManager, installed: string): string {  switch (manager) {
    case "nvm":
      return `nvm use ${installed}`;
    case "fnm":
      return `fnm use ${installed}`;
    case "volta":
      return `volta install node@${installed.replace(/^v/, "")}`;
    case "brew":
      return "check PATH order";
  }
}

/**
 * Absolute path to the node binary for an installed version, per manager
 * layout. Lets the gate re-exec the current command under the compliant
 * runtime directly — no shell sourcing, immune to the user's PATH order.
 */
export function installedNodeBin(
  manager: NodeManager,
  installed: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const dir = managerVersionsDir(manager, env);
  if (!dir) return undefined;
  const bare = installed.replace(/^v/, "");
  const exe = platform === "win32" ? "node.exe" : "node";
  switch (manager) {
    case "nvm":
      return join(dir, `v${bare}`, "bin", exe);
    case "volta":
      return join(dir, bare, "bin", exe);
    case "fnm":
      return join(dir, `v${bare}`, "installation", "bin", exe);
    case "brew":
      return undefined;
  }
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

async function defaultRun(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: "inherit", env });
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
  const manager = detectNodeManager(env, deps);

  // Upgrade already done once? Don't re-offer the install — re-exec this
  // command under the installed runtime directly (immune to PATH order).
  // Only the shadow case (binary missing on disk) falls back to a message.
  const installed = manager ? findInstalledNode(manager, env, deps) : undefined;
  if (manager && installed) {
    const bin =
      (deps.platform ?? process.platform) === "win32"
        ? undefined
        : installedNodeBin(manager, installed, env, deps.platform ?? process.platform);
    const hasFile = deps.hasFile ?? existsSync;
    if (bin && hasFile(bin) && env.KYA_NODE_REEXEC !== "1") {
      const cliJs = deps.cliJs ?? defaultCliJs();
      const run = deps.run ?? defaultRun;
      io.error(
        `Running under Node ${installed} (already installed via ${manager}; this shell defaults to ${version} — ${switchHint(manager, installed)} makes it permanent).`,
      );
      return run(bin, [cliJs, ...argv], {
        ...env,
        KYA_NODE_CHECKED: "1",
        KYA_NODE_REEXEC: "1",
      });
    }
    const firstNode = (deps.firstNodeOnPath ?? defaultFirstNodeOnPath)();
    const versionsDir = managerVersionsDir(manager, env);
    const shadow =
      firstNode && versionsDir && !firstNode.startsWith(versionsDir)
        ? ` from ${firstNode}`
        : "";
    io.error(
      `Node ${installed} is already installed via ${manager}, but this shell runs ${version}${shadow}. ` +
        `Run \`${switchHint(manager, installed)}\` or open a new terminal — then this warning stops. ` +
        `Continuing on ${version}.`,
    );
    return undefined;
  }

  const isTty = io.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const confirm = io.confirm ?? defaultConfirm;
  if (!isTty) {
    io.error(`${warn} Continuing anyway — some features may break.`);
    return undefined;
  }

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
  const code = await run(script.shell, script.args, env);
  if (code === 0) {
    io.error(
      `Node 24 installed and set as default. This terminal still runs ${version} — ` +
        "open a new terminal next time (your command above already finished on Node 24).",
    );
  }
  return code;
}
