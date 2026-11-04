/**
 * Race-safe "at most once per interval" stamp. Shared by the telemetry hook ping and the IoC scan
 * throttle. The claimed time lives in the stamp content: mtime granularity differs across
 * filesystems. A stale stamp is removed and re-created with an exclusive create (`wx`), so of
 * several hooks racing on a stale stamp only the one whose create succeeds gets the slot.
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function claimDailySlot(stampPath: string, intervalMs: number, nowMs: number = Date.now()): boolean {
  try {
    const raw = readFileSync(stampPath, "utf8").trim();
    const last = raw === "" ? statSync(stampPath).mtimeMs : Number(raw);
    if (Number.isFinite(last) && nowMs - last < intervalMs) return false;
    unlinkSync(stampPath);
  } catch {
    /* no stamp yet, or another hook removed it first: fall through to the exclusive create */
  }
  mkdirSync(dirname(stampPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(stampPath, String(nowMs), { flag: "wx" });
    return true;
  } catch {
    return false; // EEXIST: another hook won the race
  }
}
