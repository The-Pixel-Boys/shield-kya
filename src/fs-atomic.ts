/**
 * Shared crash-safe file write, used by connect/wire-hooks host config writes
 * and the certify attestation store.
 */
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Crash-safe write: tmp file in the same directory, then rename onto the
 * target (atomic on POSIX and win32 within one volume). A mid-write crash
 * leaves the original config intact; the tmp file is removed best-effort.
 * An existing target's file mode is carried over — a rename would otherwise
 * turn a 0600 config into the umask default.
 */
export function atomicWriteSync(target: string, content: string): void {
  const tmp = `${target}.kya-tmp-${process.pid}`;
  try {
    let mode: number | undefined;
    try {
      mode = statSync(target).mode;
    } catch {
      /* new file — keep default mode */
    }
    writeFileSync(tmp, content, "utf8");
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode);
      } catch {
        /* win32 chmod semantics differ; POSIX correctness is what matters */
      }
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
