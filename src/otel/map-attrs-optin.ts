/**
 * The user-level config for the OTLP map-attribute opt-in, read from a path a repo cannot steer.
 * A repo sets env through .claude/settings.json or .mcp.json, so HOME and KYA_HOME (and a relative value of them,
 * which resolves against the project dir) never pick this file. The path is the passwd home: os.userInfo().homedir.
 * Used ONLY for the map-attribute decision. All other config loading is unchanged.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface OptInDeps {
  /** Test seam for the passwd home. Never read from env. */
  readonly passwdHome?: () => string;
  readonly lstat?: (p: string) => Stats;
  readonly stat?: (p: string) => Stats;
  readonly realpath?: (p: string) => string;
  readonly uid?: () => number;
  readonly platform?: NodeJS.Platform;
  /** Test seam: fstat of the opened file. */
  readonly fstat?: (fd: number) => Stats;
  /** Test seam: runs after the checks and before the open, to simulate a swap of the file. */
  readonly beforeOpen?: (path: string) => void;
}

/** Owner, mode and link-count checks on one stat result. Windows has no POSIX owner or mode bits: those two do not run. */
function fileRefusal(st: Stats, deps: OptInDeps): string | undefined {
  if (!st.isFile()) return "not a file";
  if (st.nlink !== 1) return "hard link";
  if ((deps.platform ?? process.platform) !== "win32") {
    const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid.bind(process) : undefined);
    if (uid && st.uid !== uid()) return "owned by another user";
    if ((st.mode & 0o022) !== 0) return "group or world writable";
  }
  return undefined;
}

function under(child: string, dir: string): boolean {
  const r = relative(dir, child);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/**
 * Why the file at `path` cannot carry the opt-in, or undefined when it can.
 * The project check protects one case the owner, mode and symlink checks cannot: a repo checked out at or above the
 * home (a dotfiles repo in ~) commits `.kya/config.json`. That file is the user's own, 0644, no link. So it is checked
 * against the real project dir of the call, not the process cwd (the hosted hook runs from home).
 * Refused: no absolute project dir (fail closed); the file (or its symlink target) is under the project dir;
 * a hard link (nlink is not 1, so a project file can share it); another user owns it; group or others can write it;
 * a symlink that resolves outside the passwd home. Windows has no POSIX owner or mode bits, so there those two
 * checks do not run.
 */
export function optInRefusal(path: string, home: string, projectDir: string | undefined, deps: OptInDeps = {}): string | undefined {
  if (!projectDir || !isAbsolute(projectDir)) return "no project dir";
  const lst = (deps.lstat ?? lstatSync)(path);
  const rp = deps.realpath ?? realpathSync;
  const real = rp(path);
  const realHome = rp(home);
  if (lst.isSymbolicLink() && !under(real, realHome)) return "symlink outside the home";
  let realDir: string;
  try {
    realDir = rp(projectDir);
  } catch {
    realDir = resolve(projectDir);
  }
  if (under(real, realDir) || under(resolve(path), resolve(projectDir))) return "under the project dir";
  return fileRefusal((deps.stat ?? statSync)(real), deps);
}

/** Parsed `<passwd home>/.kya/config.json` when it passes optInRefusal, else undefined. Never throws. */
export function readOptInConfig(projectDir: string | undefined, deps: OptInDeps = {}): unknown {
  try {
    const home = deps.passwdHome ? deps.passwdHome() : userInfo().homedir;
    if (!home || !isAbsolute(home)) return undefined;
    const path = join(home, ".kya", "config.json");
    if (optInRefusal(path, home, projectDir, deps) !== undefined) return undefined;
    const real = (deps.realpath ?? realpathSync)(path);
    deps.beforeOpen?.(real);
    // Open once (no symlink follow where the OS has O_NOFOLLOW), check the opened file again, read the same fd:
    // a swap of the path after the checks cannot change what is read.
    const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (fileRefusal((deps.fstat ?? fstatSync)(fd), deps) !== undefined) return undefined;
      return JSON.parse(readFileSync(fd, "utf8")) as unknown;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * One stderr line for `kya doctor` when the passwd-home file asks for map attributes but a check refuses it.
 * The export ignores the opt-in silently; this is the only place that says why. Undefined when nothing to say.
 */
export function optInHint(projectDir: string | undefined, deps: OptInDeps = {}): string | undefined {
  try {
    const home = deps.passwdHome ? deps.passwdHome() : userInfo().homedir;
    if (!home || !isAbsolute(home)) return undefined;
    const path = join(home, ".kya", "config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { otlpExport?: { mapAttrs?: unknown } };
    if (raw?.otlpExport?.mapAttrs !== true) return undefined;
    const why = optInRefusal(path, home, projectDir, deps);
    if (why === undefined) return undefined;
    const fix = why === "group or world writable" ? ` Run "chmod 600 ${path}".` : "";
    return `kya: otlpExport.mapAttrs in ${path} is ignored (${why}).${fix} See docs/otlp.md.`;
  } catch {
    return undefined;
  }
}
