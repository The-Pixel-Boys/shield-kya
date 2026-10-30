/**
 * Shared crash-safe file write, used by connect/wire-hooks host config writes,
 * team init, gate config, telemetry state and the certify attestation store.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { KyaError } from "./errors.js";

/**
 * Crash-safe write: tmp file in the same directory, then rename onto the
 * target (atomic on POSIX and win32 within one volume). A mid-write crash
 * leaves the original config intact; the tmp file is removed best-effort.
 *
 * The tmp name carries 128 random bits and is created with O_EXCL ("wx"), so
 * a file or symlink planted at a guessable name (for example inside a cloned
 * repo) makes the write fail instead of being followed. The mode is set on the
 * open fd (fchmod), never through a path that could be swapped. An existing
 * regular target's mode is carried over - a rename would otherwise turn a 0600
 * config into the umask default.
 */
export function atomicWriteSync(target: string, content: string, beforeRename?: () => void): void {
  writeAtomic(target, content, { beforeRename });
}

/**
 * Same crash-safe write, but the file is always mode 0600 (owner read and write only), both
 * when created and when it already existed. Used for hosted credentials. The mode is set at
 * create (open flag) and again with fchmod on the fd, so there is no window with a wider mode.
 */
export function atomicWriteSecretSync(target: string, content: string): void {
  writeAtomic(target, content, { forceMode: 0o600 });
}

function writeAtomic(
  target: string,
  content: string,
  opts: { readonly beforeRename?: () => void; readonly forceMode?: number },
): void {
  const tmp = `${target}.kya-tmp-${randomBytes(16).toString("hex")}`;
  let mode: number | undefined = opts.forceMode;
  try {
    const st = lstatSync(target);
    if (st.isFile() && mode === undefined) mode = st.mode & 0o7777;
  } catch {
    /* new file - keep default mode */
  }
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(tmp, "wx", mode ?? 0o666);
    created = true;
    if (mode !== undefined) {
      try {
        fchmodSync(fd, mode); // umask may have stripped bits at create
      } catch {
        /* win32 chmod semantics differ; POSIX correctness is what matters */
      }
    }
    writeSync(fd, content, null, "utf8");
    closeSync(fd);
    fd = undefined;
    opts.beforeRename?.();
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      // Only remove what we created: never unlink a pre-existing entry at our name.
      if (created) rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** A project-scope write refused because its path leaves the project (exit 1, never a silent skip). */
export class ProjectPathError extends KyaError {
  constructor(message: string) {
    super(message, "PROJECT_PATH_REFUSED", 1);
    this.name = "ProjectPathError";
  }
}

function lstatOrUndefined(p: string): Stats | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Where a project-scope write to `target` may land, or throw ProjectPathError.
 * User-level files (~/.claude.json and co.) never come here: following a
 * dotfiles symlink there is a feature. Inside a project (a cloned repo can
 * ship any symlink) the rules are:
 * - every existing parent must resolve inside realpath(root) (covers a
 *   symlinked .kya, .cursor or .kiro directory);
 * - a symlinked leaf is followed only when it resolves inside the root;
 * - a dangling symlink, anywhere on the path, is refused;
 * - a regular file with other hard links (nlink > 1) is refused;
 * - an existing leaf must be a regular file (or a directory when dir=true).
 * Returns the resolved path for a symlinked leaf, else the path itself.
 */
export function projectWritePath(target: string, root: string, dir = false): string {
  const realRoot = realpathSync(root);
  const abs = resolve(target);
  const inside = (p: string): boolean => {
    const r = relative(realRoot, p);
    return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
  };
  const fix =
    "Replace the symlink with a regular file or directory (remove the link, or copy the content in its place), then re-run. To write to that location on purpose, pass its resolved path (for example --out <resolved path>) instead of the link.";
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      throw new ProjectPathError(`${p} is a dangling symlink inside the project; refusing to write ${target}. ${fix}`);
    }
  };
  let parent = dirname(abs);
  while (!lstatOrUndefined(parent) && dirname(parent) !== parent) parent = dirname(parent);
  const realParent = real(parent);
  if (!inside(realParent)) {
    throw new ProjectPathError(
      `${target} is reached through ${parent}, which resolves to ${realParent}, outside the project ${realRoot}; refusing to write through a symlink. ${fix}`,
    );
  }
  const st = lstatOrUndefined(abs);
  if (!st) return abs;
  let out = abs;
  let leaf = st;
  if (st.isSymbolicLink()) {
    out = real(abs);
    if (!inside(out)) {
      throw new ProjectPathError(
        `${target} is a symlink to ${out}, outside the project ${realRoot}; refusing to write through it. ${fix}`,
      );
    }
    leaf = lstatSync(out);
  }
  if (dir ? !leaf.isDirectory() : !leaf.isFile()) {
    throw new ProjectPathError(`${target} is not a regular ${dir ? "directory" : "file"}; refusing to write it`);
  }
  if (!dir && leaf.nlink > 1) {
    throw new ProjectPathError(
      `${target} has other hard links (${leaf.nlink}), possibly outside the project or elsewhere in the repo; refusing to write a file shared with another path. Replace it with a regular copy (cp it to a new name, then move it over), then re-run.`,
    );
  }
  return out;
}

/** mkdir -p for a project directory (for example .kya) after projectWritePath accepts it. */
export function ensureProjectDir(dir: string, root: string, mode?: number): void {
  mkdirSync(projectWritePath(dir, root, true), { recursive: true, mode });
}

/**
 * atomicWriteSync for a project-scope file: refuses paths that leave the
 * project (projectWritePath) before writing and re-checks right before the
 * rename. Residual: a same-user process can still swap a parent between that
 * re-check and the rename (TOCTOU); the temp file is O_EXCL and the rename
 * replaces a link instead of following it. Returns the path written.
 */
export function writeProjectFile(target: string, content: string, root: string): string {
  const out = projectWritePath(target, root);
  mkdirSync(dirname(out), { recursive: true });
  atomicWriteSync(out, content, () => {
    if (projectWritePath(target, root) !== out) {
      throw new ProjectPathError(`${target} changed while writing; nothing was written`);
    }
  });
  return out;
}

/**
 * Whether an output path goes through the project: lexically inside root, or
 * one of its existing ancestors is the project itself reached through an
 * alias (a symlinked path to the repo). Decides which output rule applies.
 */
function underRoot(path: string, root: string): boolean {
  const r = relative(resolve(root), resolve(path));
  if (r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r))) return true;
  const realRoot = realpathSync(root);
  for (let a = resolve(path); ; a = dirname(a)) {
    if (lstatOrUndefined(a)) {
      try {
        if (realpathSync(a) === realRoot) return true;
      } catch {
        /* dangling: keep walking up */
      }
    }
    if (dirname(a) === a) return false;
  }
}

/**
 * Report/output dir (kya certify --out, kya orr --out, kya receipt --out-dir):
 * inside the project it gets the project rules, outside it is the user's
 * explicit choice and is created as asked.
 */
export function ensureOutDir(dir: string, root: string): void {
  if (underRoot(dir, root)) ensureProjectDir(dir, root);
  else mkdirSync(dir, { recursive: true });
}

/**
 * Report/output file: project rules inside root; outside, an atomic write
 * that replaces a planted leaf link instead of following it.
 */
export function writeOutFile(path: string, content: string, root: string): void {
  if (underRoot(path, root)) writeProjectFile(path, content, root);
  else atomicWriteSync(path, content);
}
