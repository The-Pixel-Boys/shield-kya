/**
 * Shared crash-safe file write, used by connect/wire-hooks host config writes,
 * team init, gate config, telemetry state and the certify attestation store.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, lstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

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
  const tmp = `${target}.kya-tmp-${randomBytes(16).toString("hex")}`;
  let mode: number | undefined;
  try {
    const st = lstatSync(target);
    if (st.isFile()) mode = st.mode & 0o7777;
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
    beforeRename?.();
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
