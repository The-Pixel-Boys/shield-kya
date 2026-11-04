/**
 * Hook-side throttle for the IoC scan. Lean on purpose: `kya hook` imports this module and nothing
 * from ./scan.js, so the hook path loads no scan code. The scan itself runs in a detached child
 * (`kya ioc-scan`) that the hook never waits for.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { globalConfigDir } from "../config.js";
import { claimDailySlot } from "../daily-slot.js";
import { childCwd, childEnv } from "./exec.js";

export const IOC_SCAN_INTERVAL_MS = 24 * 60 * 60_000;

/** KYA_IOC=0 (or off/false) or ~/.kya/config.json {"ioc":{"enabled":false}} turns the background scan off. */
export function iocEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = String(env["KYA_IOC"] ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return false;
  try {
    const cfg = JSON.parse(readFileSync(join(globalConfigDir(env), "config.json"), "utf8")) as { ioc?: { enabled?: unknown } };
    return cfg.ioc?.enabled !== false;
  } catch {
    return true; // no config file (the usual case) or unreadable: the default is on
  }
}

export function iocStampPath(env: NodeJS.ProcessEnv): string {
  return join(globalConfigDir(env), "ioc-scan-stamp");
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore"; env: NodeJS.ProcessEnv; cwd: string; windowsHide: boolean },
) => { unref(): void; on(event: "error", listener: () => void): unknown };

/**
 * Starts `kya ioc-scan` detached when the 24 h slot is free. Never throws, never waits.
 * Returns whether a scan was started. A failed spawn keeps the slot claimed until tomorrow.
 */
export function maybeSpawnIocScan(deps: {
  readonly env: NodeJS.ProcessEnv;
  readonly entry?: string;
  readonly spawnImpl?: SpawnLike;
  readonly nowMs?: number;
}): boolean {
  try {
    if (!iocEnabled(deps.env)) return false;
    const entry = deps.entry ?? process.argv[1];
    // Absolute only: the child starts in the home directory, so a relative entry would not resolve.
    if (entry === undefined || !isAbsolute(entry)) return false; // before claiming: a skipped spawn must not burn the slot
    if (!claimDailySlot(iocStampPath(deps.env), IOC_SCAN_INTERVAL_MS, deps.nowMs)) return false;
    const child = (deps.spawnImpl ?? (spawn as unknown as SpawnLike))(
      process.execPath,
      [entry, "ioc-scan"],
      { detached: true, stdio: "ignore", env: childEnv(deps.env), cwd: childCwd(), windowsHide: true },
    );
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
