/**
 * One-time "star the repo" CTA, printed after `kya start` / `kya receipt`
 * surface a live report URL and the trail has real activity in the window.
 * The flag lives in the project `.kya/` dir, so the CTA prints at most once
 * per project — it never gates or delays the report itself.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";
import { atomicWriteSync } from "./fs-atomic.js";
import { readTrailSince } from "./trail.js";

export const STAR_REPO_URL = "https://github.com/The-Pixel-Boys/shield-agent";
export const STAR_CTA_LINE = `Loving KYA? Star the repo — it keeps the OSS report free: ${STAR_REPO_URL}`;
/** The CTA only fires once the trail has meaningful activity to report. */
export const STAR_CTA_MIN_EVENTS = 10;

export function starCtaFlagPath(cwd: string): string {
  return join(configDir(cwd), "star-cta-shown");
}

export function starCtaShown(cwd: string): boolean {
  return existsSync(starCtaFlagPath(cwd));
}

/**
 * Print the star CTA at most once per `.kya` dir, and only when the trail
 * window has >= STAR_CTA_MIN_EVENTS. Returns true when the line was printed
 * (the flag is persisted before returning); all failures are silent so the
 * CTA can never break start/receipt.
 */
export function maybePrintStarCta(
  cwd: string,
  days: number,
  log: (msg: string) => void = console.log,
): boolean {
  try {
    if (starCtaShown(cwd)) return false;
    const windowDays = days > 0 ? Math.floor(days) : 3;
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const events = readTrailSince(cwd, since);
    if (events.length < STAR_CTA_MIN_EVENTS) return false;
    log(STAR_CTA_LINE);
    try {
      mkdirSync(configDir(cwd), { recursive: true });
      atomicWriteSync(starCtaFlagPath(cwd), `${new Date().toISOString()}\n`);
    } catch {
      /* flag persistence is best-effort — worst case the CTA prints again */
    }
    return true;
  } catch {
    return false;
  }
}
