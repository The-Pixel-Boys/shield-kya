/**
 * Owns the per-run manifest of worker tmp homes (see test/setup.ts) and
 * removes them all after the run. Env set here propagates to test workers.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function setup(): void {
  process.env.KYA_TEST_HOME_MANIFEST = join(
    tmpdir(),
    `kya-test-homes-${process.pid}-${Date.now()}.list`,
  );
}

export function teardown(): void {
  const manifest = process.env.KYA_TEST_HOME_MANIFEST;
  if (!manifest || !existsSync(manifest)) return;
  for (const dir of readFileSync(manifest, "utf8").split("\n").filter(Boolean)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  rmSync(manifest, { force: true });
}
