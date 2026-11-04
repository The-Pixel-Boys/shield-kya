/**
 * One-time offer of plain-language search, made by `kya start`.
 *
 * The search runtime (@shield-agent/fastembed) is opt-in (see embeddings.ts). Nobody was asked, so
 * search silently fell back to exact words. This asks once, in a terminal, installs it on yes, and
 * remembers a "no". It never fails `kya start`: any problem prints the manual command and moves on.
 *
 * Without a terminal it asks nothing. `KYA_SEMANTIC=on` installs without asking (for scripts and
 * images), `KYA_SEMANTIC=off` never asks. `KYA_SEARCH_SEMANTIC=off` (model off) also means never ask.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { globalConfigDir } from "../config.js";
import { semanticInstallCommand, semanticRuntimeDir, semanticRuntimeInstalled } from "./semantic-status.js";

const CHOICE_FILE = "semantic-choice.json";
const INSTALL_TIMEOUT_MS = 5 * 60_000;
export const SEMANTIC_PACKAGE = "@shield-agent/fastembed@3.0.0";

export interface SemanticSetupIo {
  readonly error: (msg: string) => void;
  /** Test seam: force interactive / non-interactive. Defaults to "stdin and stderr are TTYs". */
  readonly isTty?: boolean;
  /** Test seam: returns the raw answer line. Defaults to a readline prompt on stdin/stderr. */
  readonly ask?: (question: string) => Promise<string>;
  /** Test seam: the install step. Defaults to `npm install --prefix <dir> <package>`. */
  readonly install?: (env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail?: string }>;
}

export type SemanticSetupResult = "already" | "installed" | "failed" | "declined" | "skipped" | "hinted";

const NOTICE = [
  "Plain-language search for the activity page (optional).",
  "It lets you search with words like \"dangerous\" or \"deleted files\", not only exact text.",
  "It installs a local runtime and downloads a model once: about 400 MB of disk. Nothing leaves this machine.",
];

function choicePath(env: NodeJS.ProcessEnv): string {
  return join(globalConfigDir(env), CHOICE_FILE);
}

function declinedBefore(env: NodeJS.ProcessEnv): boolean {
  try {
    const raw = JSON.parse(readFileSync(choicePath(env), "utf8")) as { answer?: unknown };
    return raw.answer === "no";
  } catch {
    return false;
  }
}

function recordChoice(env: NodeJS.ProcessEnv, answer: "yes" | "no"): void {
  try {
    mkdirSync(globalConfigDir(env), { recursive: true });
    writeFileSync(choicePath(env), `${JSON.stringify({ answer, askedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch {
    /* a lost answer only means we may ask again */
  }
}

/** `npm install --prefix <dir> @shield-agent/fastembed@3.0.0`. Fixed arguments, no user text. */
export function installSemanticRuntime(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail?: string }> {
  const dir = semanticRuntimeDir(env);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return Promise.resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  const win = process.platform === "win32";
  return new Promise((resolve) => {
    execFile(
      win ? "npm.cmd" : "npm",
      ["install", "--prefix", win ? `"${dir}"` : dir, "--no-audit", "--no-fund", SEMANTIC_PACKAGE],
      { env, timeout: INSTALL_TIMEOUT_MS, windowsHide: true, shell: win },
      (err, _stdout, stderr) => {
        if (err) resolve({ ok: false, detail: (String(stderr).trim().split("\n").pop() || err.message).slice(0, 200) });
        else resolve({ ok: semanticRuntimeInstalled(env) });
      },
    );
  });
}

function defaultAsk(question: string): Promise<string> {
  return new Promise((resolve) => {
    // Prompt on stderr so stdout stays clean for anything piping the command's output.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function runInstall(io: SemanticSetupIo, env: NodeJS.ProcessEnv): Promise<SemanticSetupResult> {
  io.error("Installing the search runtime. This can take a minute...");
  const r = await (io.install ?? installSemanticRuntime)(env);
  if (r.ok) {
    io.error("Plain-language search is on. The model downloads the first time you search.");
    return "installed";
  }
  io.error(`Could not install it${r.detail ? ` (${r.detail})` : ""}. Search keeps matching exact words. Try later: ${semanticInstallCommand(env)}`);
  return "failed";
}

export async function maybeOfferSemanticSearch(io: SemanticSetupIo, env: NodeJS.ProcessEnv): Promise<SemanticSetupResult> {
  const mode = env.KYA_SEMANTIC?.trim().toLowerCase();
  if (mode === "off" || env.KYA_SEARCH_SEMANTIC === "off") return "skipped";
  if (semanticRuntimeInstalled(env)) return "already";
  if (mode === "on" || mode === "1" || mode === "yes") return runInstall(io, env);
  if (declinedBefore(env)) return "skipped";

  const interactive = io.isTty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!interactive) {
    io.error(`Plain-language search is off (exact words only). Turn it on: KYA_SEMANTIC=on kya start`);
    return "hinted";
  }

  for (const line of NOTICE) io.error(line);
  const answer = await (io.ask ?? defaultAsk)("Turn it on now? [Y/n]");
  const no = /^n(o)?$/i.test(answer.trim());
  recordChoice(env, no ? "no" : "yes");
  if (no) {
    io.error("No problem. Turn it on later: KYA_SEMANTIC=on kya start");
    return "declined";
  }
  return runInstall(io, env);
}
