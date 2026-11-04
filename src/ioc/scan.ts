/**
 * IoC scan engine. Read-only, offline (no network), fail open per check: an unreadable file is
 * skipped and counted, a missing file or a check that does not apply here is silent.
 * Findings carry the matched label or indicator only, never file contents, never the user name:
 * evidence paths are written with ~ for the home directory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { globalConfigDir, kyaHome } from "../config.js";
import { atomicWriteSync } from "../fs-atomic.js";
import { iocEnabled } from "./spawn.js";
import { locateCrontab as defaultLocateCrontab, readCrontab } from "./exec.js";
import { loadIocList, type IocCheck, type IocEntry, type IocList, type IocWhere } from "./list.js";
import { iocResultPath, type IocFinding, type IocResult } from "./result.js";

/** Extension roots, relative to the home directory. Each holds one directory per installed extension. */
const EXTENSION_DIRS = [
  ".vscode/extensions",
  ".vscode-insiders/extensions",
  ".cursor/extensions",
  ".windsurf/extensions",
  ".vscode-oss/extensions",
] as const;

const KEY_TYPE = /^(ssh-|ecdsa-sha2-|sk-)/;
const KEY_BLOB = /^[A-Za-z0-9+/=]{16,}$/;

const HINTS: Record<IocCheck["kind"], string> = {
  extension:
    "Update the extension to a release that is not listed here, restart the editor, then rotate the credentials it could read.",
  ssh_authorized_keys_comment:
    "Remove this line from authorized_keys, then rotate the SSH keys and credentials this host trusted.",
  net_indicator:
    "Remove the entry that names this address, then review the scheduled jobs and rotate the credentials on this machine.",
  file_exists: "Remove this file, then review what it ran and rotate the credentials it could read.",
};

interface Ctx {
  readonly home: string;
  readonly locateCrontab: () => string | undefined;
  skipped: number;
}

const isMissing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** ~/relative/path with forward slashes. Only paths under the home directory are ever shown. */
const tilde = (ctx: Ctx, abs: string): string => `~/${relative(ctx.home, abs).split(sep).join("/")}`;

/** Reads a text file. Missing is silent; any other failure (EISDIR, EACCES, ...) counts as skipped. */
function readText(ctx: Ctx, path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (!isMissing(e)) ctx.skipped++;
    return undefined;
  }
}

function finding(ioc: IocEntry, check: IocCheck, evidence: string): IocFinding {
  return { ioc: ioc.id, check: check.kind, severity: ioc.severity, evidence, hint: HINTS[check.kind] };
}

function checkExtension(ctx: Ctx, ioc: IocEntry, check: IocCheck, out: IocFinding[]): void {
  const id = (check.id ?? "").toLowerCase();
  if (id === "") return;
  const versions = (check.versions ?? []).map((v) => v.toLowerCase());
  for (const rel of EXTENSION_DIRS) {
    const dir = join(ctx.home, rel);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      if (!isMissing(e)) ctx.skipped++;
      continue;
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!lower.startsWith(`${id}-`)) continue;
      const rest = lower.slice(id.length + 1);
      // `<id>-<version>` or `<id>-<version>-<platform>`; 2.1.3130 must not match 2.1.313.
      const hit = versions.length === 0 ? rest !== "" : versions.some((v) => rest === v || rest.startsWith(`${v}-`));
      if (hit) out.push(finding(ioc, check, `~/${rel}/${name}`));
    }
  }
}

/** Comment labels of authorized_keys lines, with the 1-based line number. Quoted options are dropped first. */
export function authorizedKeyComments(text: string): { line: number; comment: string }[] {
  const out: { line: number; comment: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const tokens = trimmed.replace(/"[^"]*"/g, '""').split(/\s+/);
    for (let k = 0; k + 1 < tokens.length; k++) {
      if (KEY_TYPE.test(tokens[k]) && KEY_BLOB.test(tokens[k + 1])) {
        out.push({ line: i + 1, comment: tokens.slice(k + 2).join(" ") });
        return;
      }
    }
  });
  return out;
}

function checkSshComment(ctx: Ctx, ioc: IocEntry, check: IocCheck, out: IocFinding[]): void {
  const text = readText(ctx, join(ctx.home, ".ssh", "authorized_keys"));
  if (text === undefined || check.value === undefined) return;
  for (const { line, comment } of authorizedKeyComments(text)) {
    if (comment === check.value) out.push(finding(ioc, check, `~/.ssh/authorized_keys line ${line}`));
  }
}

/** Text of one net_indicator source, as [evidence, text] pairs. Built once per scan and reused. */
type Source = readonly [evidence: string, text: string];

function filesIn(ctx: Ctx, rel: string, keep: (name: string) => boolean): Source[] {
  const dir = join(ctx.home, rel);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (!isMissing(e)) ctx.skipped++;
    return [];
  }
  const out: Source[] = [];
  for (const name of names.sort()) {
    if (!keep(name)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue; // subdirectories are not config files
    } catch {
      continue;
    }
    const text = readText(ctx, path);
    if (text !== undefined) out.push([tilde(ctx, path), text]);
  }
  return out;
}

/** `crontab -l` from a fixed absolute path (see exec.ts). Skipped and counted when no safe binary exists. */
async function crontabText(ctx: Ctx): Promise<string | undefined> {
  const bin = ctx.locateCrontab();
  if (bin === undefined) {
    if (process.platform !== "win32") ctx.skipped++;
    return undefined;
  }
  const r = await readCrontab(bin);
  if (r.status === "ok") return r.text;
  if (r.status === "none") return "";
  ctx.skipped++;
  return undefined;
}

async function sourcesFor(ctx: Ctx, where: IocWhere, cache: Map<IocWhere, Source[]>): Promise<Source[]> {
  const cached = cache.get(where);
  if (cached) return cached;
  let out: Source[];
  switch (where) {
    case "crontab": {
      const text = await crontabText(ctx);
      out = text === undefined ? [] : [["crontab -l", text]];
      break;
    }
    case "launchagents":
      out = filesIn(ctx, join("Library", "LaunchAgents"), (n) => n.endsWith(".plist"));
      break;
    case "systemd_user":
      out = filesIn(ctx, join(".config", "systemd", "user"), () => true);
      break;
    case "ssh_config":
      out = filesIn(ctx, ".ssh", (n) => n === "config");
      break;
    case "shell_rc":
      out = [".zshrc", ".bashrc", ".profile"].flatMap((n) => {
        const text = readText(ctx, join(ctx.home, n));
        return text === undefined ? [] : [[`~/${n}`, text] as const];
      });
      break;
  }
  cache.set(where, out);
  return out;
}

async function checkNetIndicator(
  ctx: Ctx,
  ioc: IocEntry,
  check: IocCheck,
  cache: Map<IocWhere, Source[]>,
  out: IocFinding[],
): Promise<void> {
  if (check.value === undefined || check.value === "") return;
  for (const where of check.where ?? []) {
    for (const [evidence, text] of await sourcesFor(ctx, where, cache)) {
      if (text.includes(check.value)) out.push(finding(ioc, check, evidence));
    }
  }
}

function checkFileExists(ctx: Ctx, ioc: IocEntry, check: IocCheck, out: IocFinding[]): void {
  const rel = (check.value ?? "").replace(/^~[/\\]?/, "");
  if (rel === "" || isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) return; // only paths under ~
  const abs = join(ctx.home, rel);
  if (existsSync(abs)) out.push(finding(ioc, check, tilde(ctx, abs)));
}

/** Runs every check of the list against the home directory. Never throws; returns the result to store. */
export async function runIocScan(opts: {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly list?: IocList;
  readonly now?: Date;
  /** Test seam: where crontab is looked up. Default: fixed candidate paths, never PATH. */
  readonly locateCrontab?: () => string | undefined;
}): Promise<IocResult> {
  const env = opts.env ?? process.env;
  const ctx: Ctx = {
    home: opts.home ?? kyaHome(env),
    locateCrontab: opts.locateCrontab ?? (() => defaultLocateCrontab()),
    skipped: 0,
  };
  const list = opts.list ?? loadIocList();
  const findings: IocFinding[] = [];
  const cache = new Map<IocWhere, Source[]>();
  for (const ioc of list.iocs) {
    for (const check of ioc.checks) {
      if (check.kind === "extension") checkExtension(ctx, ioc, check, findings);
      else if (check.kind === "ssh_authorized_keys_comment") checkSshComment(ctx, ioc, check, findings);
      else if (check.kind === "net_indicator") await checkNetIndicator(ctx, ioc, check, cache, findings);
      else if (check.kind === "file_exists") checkFileExists(ctx, ioc, check, findings);
    }
  }
  return {
    schema: 1,
    checkedAt: (opts.now ?? new Date()).toISOString(),
    listVersion: list.version,
    skipped: ctx.skipped,
    findings,
  };
}

/** Scan and store ~/.kya/ioc-latest.json (atomic write). Used by `kya doctor --iocs` and the detached run. */
export async function runIocScanAndStore(env: NodeJS.ProcessEnv): Promise<IocResult> {
  const result = await runIocScan({ env });
  mkdirSync(globalConfigDir(env), { recursive: true, mode: 0o700 });
  atomicWriteSync(iocResultPath(env), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Hidden `kya ioc-scan`: the detached child of the hook. Checks the opt-out again; fails open. */
export async function runDetachedIocScan(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    if (!iocEnabled(env)) return;
    await runIocScanAndStore(env);
  } catch {
    /* fail open: a failed background scan leaves the previous result in place */
  }
}
