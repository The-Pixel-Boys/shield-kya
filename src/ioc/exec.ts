/**
 * The only external program the IoC scan runs is `crontab -l`. It is started by absolute path from
 * a fixed list, never through PATH, so a relative PATH entry or a planted binary in a project
 * directory cannot run. The child gets a fixed PATH and no other caller environment, and it starts
 * in the home directory, not in the project. Windows has no crontab: the check is skipped there.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

export const CRONTAB_CANDIDATES: readonly string[] = ["/usr/bin/crontab", "/bin/crontab", "/usr/sbin/crontab"];
export const CHILD_PATH = "/usr/bin:/bin";
const CRONTAB_TIMEOUT_MS = 5_000;

/** First candidate that is a regular file and not writable by group or others. Undefined when none is. */
export function locateCrontab(candidates: readonly string[] = CRONTAB_CANDIDATES): string | undefined {
  if (process.platform === "win32") return undefined;
  for (const path of candidates) {
    try {
      const st = statSync(path);
      if (st.isFile() && (st.mode & 0o022) === 0) return path;
    } catch {
      /* missing: try the next candidate */
    }
  }
  return undefined;
}

/** Child environment: a fixed PATH on POSIX, otherwise the caller's env. Nothing else is inherited from PATH. */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return process.platform === "win32" ? { ...base } : { ...base, PATH: CHILD_PATH };
}

/** Children start in the home directory (or the temp dir), never in the project being worked on. */
export function childCwd(): string {
  return homedir() || tmpdir();
}

export type CrontabRead = { readonly status: "ok"; readonly text: string } | { readonly status: "none" } | { readonly status: "error" };

/** Runs `<absolute path> -l`. "no crontab" (exit 1) is a clean result, not an error. */
export function readCrontab(bin: string): Promise<CrontabRead> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["-l"],
      { env: childEnv({}), cwd: childCwd(), timeout: CRONTAB_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ status: "ok", text: String(stdout) });
        if (/no crontab/i.test(String(stderr))) return resolve({ status: "none" });
        resolve({ status: "error" });
      },
    );
  });
}
