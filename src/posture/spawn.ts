/**
 * Hook-side start of the daily posture send. Lean on purpose: `kya hook` imports this module and
 * nothing heavy. With the local toggle off this returns before it claims a slot or spawns
 * anything. Otherwise it starts `kya posture-send` detached, at most once per 24 h, and never
 * waits for it. Same shape as ioc/spawn.ts, but the child keeps the caller PATH: host detection
 * reads PATH directories and never executes anything.
 */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { claimDailySlot } from "../daily-slot.js";
import { childCwd } from "../ioc/exec.js";
import { postureStampPath, shareOn } from "./store.js";

export const POSTURE_SEND_INTERVAL_MS = 24 * 60 * 60_000;

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore"; env: NodeJS.ProcessEnv; cwd: string; windowsHide: boolean },
) => { unref(): void; on(event: "error", listener: () => void): unknown };

/** Never throws, never waits. Returns whether a send was started. */
export function maybeSpawnPostureSend(deps: {
  readonly env: NodeJS.ProcessEnv;
  readonly entry?: string;
  readonly spawnImpl?: SpawnLike;
  readonly nowMs?: number;
}): boolean {
  try {
    if (!shareOn(deps.env)) return false; // toggle off: no slot, no process
    const entry = deps.entry ?? process.argv[1];
    if (entry === undefined || !isAbsolute(entry)) return false;
    if (!claimDailySlot(postureStampPath(deps.env), POSTURE_SEND_INTERVAL_MS, deps.nowMs)) return false;
    const child = (deps.spawnImpl ?? (spawn as unknown as SpawnLike))(
      process.execPath,
      [entry, "posture-send"],
      { detached: true, stdio: "ignore", env: { ...deps.env }, cwd: childCwd(), windowsHide: true },
    );
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
