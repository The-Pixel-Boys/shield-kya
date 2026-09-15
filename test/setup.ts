/**
 * Defense-in-depth: no test may ever wire into the developer's real home.
 * start/connect honor KYA_HOME for user-level host config resolution, so
 * point it at a per-worker tmp dir before any test module runs and register
 * it for removal by the global teardown (worker "exit" hooks do not fire
 * under tinypool). Tests that need a specific home still override explicitly.
 */
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), `kya-test-home-${process.pid}-`));
process.env.KYA_HOME = home;

const manifest = process.env.KYA_TEST_HOME_MANIFEST;
if (manifest) {
  try {
    appendFileSync(manifest, `${home}\n`, "utf8");
  } catch {
    /* manifest is best-effort; tmp dirs under $TMPDIR are reaped by the OS */
  }
}
