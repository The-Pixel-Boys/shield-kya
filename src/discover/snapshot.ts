/**
 * Local snapshot persistence for endpoint discovery.
 *
 * Writes timestamped discovery JSON under ~/.kya/discovery/ and keeps a
 * `latest.json` copy for the receipt card and diff comparisons.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import type { DiscoveryFinding, DiscoverySnapshot } from "./scan.js";

export interface SnapshotFs {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
  readFileSync(path: string, encoding: "utf8"): string;
  existsSync(path: string): boolean;
}

export function snapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "discovery");
}

function isoTimestamp(snapshot: DiscoverySnapshot): string {
  return snapshot.capturedAt.replace(/[:.]/g, "-");
}

export function writeDiscoverySnapshot(
  snapshot: DiscoverySnapshot,
  env: NodeJS.ProcessEnv = process.env,
  fs: SnapshotFs = defaultSnapshotFs(),
): { path: string; latestPath: string } {
  const dir = snapshotDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const timestamped = join(dir, `${isoTimestamp(snapshot)}.json`);
  const latestPath = join(dir, "latest.json");
  const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
  fs.writeFileSync(timestamped, payload, "utf8");
  fs.writeFileSync(latestPath, payload, "utf8");
  return { path: timestamped, latestPath };
}

export function loadDiscoverySnapshot(
  path: string,
  fs: Pick<SnapshotFs, "existsSync" | "readFileSync"> = defaultSnapshotFs(),
): DiscoverySnapshot | undefined {
  try {
    if (!fs.existsSync(path)) return undefined;
    const raw = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { inventory?: unknown }).inventory)) {
      return undefined;
    }
    return raw as DiscoverySnapshot;
  } catch {
    return undefined;
  }
}

export function loadLatestDiscoverySnapshot(
  env: NodeJS.ProcessEnv = process.env,
  fs: Pick<SnapshotFs, "existsSync" | "readFileSync"> = defaultSnapshotFs(),
): DiscoverySnapshot | undefined {
  return loadDiscoverySnapshot(join(snapshotDir(env), "latest.json"), fs);
}

function identityKey(f: DiscoveryFinding): string {
  return `${f.id}|${f.source}|${JSON.stringify(f.evidence)}`;
}

function sourceKey(f: DiscoveryFinding): string {
  return `${f.id}|${f.source}`;
}

export interface DiscoveryDiff {
  readonly added: readonly DiscoveryFinding[];
  readonly removed: readonly DiscoveryFinding[];
  readonly changed: readonly { current: DiscoveryFinding; previous: DiscoveryFinding }[];
}

export function diffDiscoverySnapshots(
  current: DiscoverySnapshot,
  previous: DiscoverySnapshot,
): DiscoveryDiff {
  const added: DiscoveryFinding[] = [];
  const removed: DiscoveryFinding[] = [];
  const changed: { current: DiscoveryFinding; previous: DiscoveryFinding }[] = [];

  const currentByKey = new Map<string, DiscoveryFinding>();
  for (const f of current.inventory) currentByKey.set(identityKey(f), f);
  const previousByKey = new Map<string, DiscoveryFinding>();
  for (const f of previous.inventory) previousByKey.set(identityKey(f), f);

  for (const f of current.inventory) {
    if (!previousByKey.has(identityKey(f))) added.push(f);
  }
  for (const f of previous.inventory) {
    if (!currentByKey.has(identityKey(f))) removed.push(f);
  }

  // Pair added/removed entries with the same id+source but different evidence as "changed".
  let remainingAdded = added;
  let remainingRemoved = removed;
  if (added.length > 0 && removed.length > 0) {
    const consumedRemoved = new Set<number>();
    const newAdded: DiscoveryFinding[] = [];
    for (const cur of added) {
      const skey = sourceKey(cur);
      const idx = remainingRemoved.findIndex(
        (p, i) => !consumedRemoved.has(i) && sourceKey(p) === skey,
      );
      if (idx !== -1) {
        consumedRemoved.add(idx);
        changed.push({ current: cur, previous: remainingRemoved[idx]! });
      } else {
        newAdded.push(cur);
      }
    }
    remainingAdded = newAdded;
    remainingRemoved = remainingRemoved.filter((_, i) => !consumedRemoved.has(i));
  }

  return { added: remainingAdded, removed: remainingRemoved, changed };
}

function defaultSnapshotFs(): SnapshotFs {
  return { mkdirSync, writeFileSync, readFileSync, existsSync };
}
