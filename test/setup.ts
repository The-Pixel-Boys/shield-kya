/**
 * Defense-in-depth: no test may ever wire into the developer's real home.
 * start/connect honor KYA_HOME for user-level host config resolution, so
 * point it at a per-worker tmp dir before any test module runs and register
 * it for removal by the global teardown (worker "exit" hooks do not fire
 * under tinypool). Tests that need a specific home still override explicitly.
 *
 * The trail is global (one trail.jsonl per KYA_HOME) since 0.3.0, so a
 * shared per-worker home would leak events across tests in the same worker.
 * A beforeEach re-points KYA_HOME at a fresh tmp dir per test; the worker
 * pin above stays as fallback for module-scope work that runs before any
 * test (all are registered with the manifest teardown).
 *
 * Env threading policy: process.env is the authoritative env for trail
 * resolution, except where a command explicitly threads its parsed env
 * (currently only the eval-tool case in cli.ts → appendTrail). CLI-level
 * tests that pass a synthetic env to runCli MUST set KYA_HOME in it
 * (freshTestHome below) — an env without KYA_HOME falls back to
 * os.homedir() and would append to the real ~/.kya/trail.jsonl.
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

/** Fresh tmp KYA_HOME registered with the manifest teardown. */
export function freshTestHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kya-test-home-"));
  const manifest = process.env.KYA_TEST_HOME_MANIFEST;
  if (manifest) {
    try {
      appendFileSync(manifest, `${home}\n`, "utf8");
    } catch {
      /* manifest is best-effort; tmp dirs under $TMPDIR are reaped by the OS */
    }
  }
  return home;
}

process.env.KYA_HOME = freshTestHome();

beforeEach(() => {
  process.env.KYA_HOME = freshTestHome();
});
