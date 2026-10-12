/**
 * kya discover - local endpoint inventory scanner.
 *
 * Scans the workstation for known AI agents, IDE extensions, desktop apps,
 * model runtimes, and MCP servers. Writes a snapshot under ~/.kya/discovery/
 * and can push the result to the hosted console.
 */

import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagString } from "../parse-args.js";
import { pushDiscoverySnapshot } from "../discover/push.js";
import { scanEndpoint, type DiscoverySnapshot } from "../discover/scan.js";
import {
  diffDiscoverySnapshots,
  loadDiscoverySnapshot,
  writeDiscoverySnapshot,
} from "../discover/snapshot.js";

export interface DiscoverCliOptions {
  readonly json: boolean;
  readonly push: boolean;
  readonly diff: string | undefined;
  readonly file: string | undefined;
}

export function discoverOptionsFromArgs(parsed: ParsedArgs): DiscoverCliOptions {
  return {
    json: flagBool(parsed.flags, "json"),
    push: flagBool(parsed.flags, "push"),
    diff: flagString(parsed.flags, "diff"),
    file: flagString(parsed.flags, "file") ?? parsed.positionals[0],
  };
}

export interface DiscoverCliIo {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function loadSnapshotForPush(
  opts: DiscoverCliOptions,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<DiscoverySnapshot | undefined> {
  // --push --json --file - reads stdin; otherwise --file loads a snapshot.
  if (opts.json && opts.file === "-") {
    const raw = await readStdin();
    try {
      return JSON.parse(raw) as DiscoverySnapshot;
    } catch {
      return undefined;
    }
  }
  if (opts.file && opts.file !== "-") {
    const loaded = loadDiscoverySnapshot(opts.file);
    if (loaded) return loaded;
  }
  return scanEndpoint({ env, cwd });
}

export async function runDiscover(
  opts: DiscoverCliOptions,
  io: DiscoverCliIo,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  if (opts.push) {
    const apiKey = (env.KYA_API_KEY ?? "").trim();
    const baseUrl = (env.KYA_BASE_URL ?? "").trim();
    if (!apiKey || !baseUrl) {
      io.error("Usage: kya discover --push requires KYA_API_KEY and KYA_BASE_URL");
      io.error("  export KYA_BASE_URL=https://shield-agent.com");
      io.error("  export KYA_API_KEY=your-token");
      return 2;
    }
    const snapshot = await loadSnapshotForPush(opts, cwd, env);
    if (!snapshot) {
      io.error("error: could not read snapshot to push");
      return 1;
    }
    const result = await pushDiscoverySnapshot(snapshot, { baseUrl, apiKey });
    if (opts.json) {
      io.log(JSON.stringify({ pushed: result.ok, status: result.status, error: result.error }, null, 2));
    } else {
      io.log(`push ${result.ok ? "ok" : "failed"} (HTTP ${result.status})${result.error ? `: ${result.error}` : ""}`);
    }
    return result.ok ? 0 : 1;
  }

  if (opts.diff) {
    const previous = loadDiscoverySnapshot(opts.diff);
    if (!previous) {
      io.error(`error: could not read previous snapshot: ${opts.diff}`);
      return 1;
    }
    const current = scanEndpoint({ env, cwd });
    const diff = diffDiscoverySnapshots(current, previous);
    if (opts.json) {
      io.log(JSON.stringify(diff, null, 2));
    } else {
      io.log(formatDiffHuman(diff));
    }
    return 0;
  }

  const snapshot = scanEndpoint({ env, cwd });

  if (opts.json) {
    io.log(JSON.stringify(snapshot, null, 2));
    return 0;
  }

  const written = writeDiscoverySnapshot(snapshot, env);
  io.log(formatSnapshotHuman(snapshot, written.latestPath));
  return 0;
}

function formatSnapshotHuman(snapshot: DiscoverySnapshot, latestPath: string): string {
  const lines: string[] = [];
  lines.push(`Discovered ${snapshot.inventory.length} endpoint item(s) on ${snapshot.os}`);
  lines.push(`  endpointUid: ${snapshot.endpointUid}`);
  lines.push(`  snapshot:    ${latestPath}`);
  if (snapshot.inventory.length === 0) {
    lines.push("  (none - try installing or wiring an MCP host, then run again)");
    return lines.join("\n");
  }
  const byCategory = new Map<string, number>();
  for (const f of snapshot.inventory) {
    byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
  }
  const categories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cat, n]) => `${cat}=${n}`)
    .join("  ");
  lines.push(`  categories:  ${categories}`);
  for (const f of snapshot.inventory.slice(0, 20)) {
    const evidence = Object.entries(f.evidence)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    lines.push(`  - ${f.name} (${f.id}) [${f.confidence}] ${evidence}`);
  }
  if (snapshot.inventory.length > 20) {
    lines.push(`  ... and ${snapshot.inventory.length - 20} more`);
  }
  return lines.join("\n");
}

function formatDiffHuman(diff: ReturnType<typeof diffDiscoverySnapshots>): string {
  const lines: string[] = [];
  lines.push(`Discovery diff: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`);
  for (const f of diff.added) lines.push(`  + ${f.name} (${f.id})`);
  for (const f of diff.removed) lines.push(`  - ${f.name} (${f.id})`);
  for (const c of diff.changed) {
    lines.push(`  ~ ${c.current.name} (${c.current.id})`);
  }
  return lines.join("\n");
}
