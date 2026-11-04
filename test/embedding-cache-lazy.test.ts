/**
 * EventEmbeddingCache reads the index on first use, not in its constructor.
 * The report daemon builds the cache at start even when search is never used,
 * so an eager read cost about 150 MB RSS for a 100 MB index. The footprint test
 * spawns dist/cli.js - run `pnpm build` first.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventEmbeddingCache } from "../src/receipt/embeddings.js";

const root = join(import.meta.dirname, "..");
const cliJs = join(root, "dist", "cli.js");
const DIMS = 384;
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function vectorFor(seed: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => ((seed + i) % 97) / 97);
}

/** The index stores Float32: this is the exact value it gives back. */
function storedVectorFor(seed: number): number[] {
  return Array.from(Float32Array.from(vectorFor(seed)));
}

function indexWith(entries: { id: string; sha1: string; seed: number }[]): string {
  return JSON.stringify({
    version: 1,
    entries: entries.map((e) => ({ id: e.id, sha1: e.sha1, vector: vectorFor(e.seed) })),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Memory of a pid in MB. On macOS, `footprint` (phys_footprint): ps RSS drops
 * when pages are compressed or swapped, so an eager 60 MB parse looked like 30 MB.
 * Elsewhere, RSS from ps.
 */
function memoryMb(pid: number): number {
  if (process.platform === "darwin") {
    const out = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8" });
    const m = /phys_footprint: ([\d.]+) (KB|MB|GB)/.exec(out);
    if (m) return Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2] as "KB" | "MB" | "GB"];
  }
  const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
  return kb / 1024;
}

/** Write a valid index of about `bytes` bytes in chunks, never as one big string. */
function writeFakeIndex(file: string, bytes: number): void {
  const fd = openSync(file, "w");
  try {
    writeSync(fd, '{"version":1,"entries":[');
    let written = 25;
    let first = true;
    let n = 0;
    while (written < bytes) {
      let chunk = "";
      for (let k = 0; k < 500; k++, n++) {
        const vec = Array.from({ length: DIMS }, () => "0.123456").join(",");
        chunk += `${first ? "" : ","}{"id":"event-${n}","sha1":"${n.toString(16).padStart(40, "0")}","vector":[${vec}]}`;
        first = false;
      }
      writeSync(fd, chunk);
      written += chunk.length;
    }
    writeSync(fd, "]}");
  } finally {
    closeSync(fd);
  }
}

async function daemonMemoryAfter(indexFile: string, ms: number): Promise<number> {
  const cwd = tempDir("kya-lazy-");
  const home = tempDir("kya-lazy-home-");
  const child = spawn(process.execPath, [cliJs, "receipt-serve", "--days", "1"], {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: home,
      KYA_HOME: home,
      KYA_NO_BROWSER: "1",
      KYA_NODE_CHECKED: "1",
      KYA_SKIP_NODE_CHECK: "1",
      KYA_SEARCH_INDEX: indexFile,
      KYA_RECEIPT_IDLE_MINUTES: "0",
      KYA_RECEIPT_CWD_POLL_MS: "600000",
    },
  });
  children.push(child);
  const statePath = join(cwd, ".kya", "receipt-server.json");
  for (let t = 0; t < 150 && !existsSync(statePath); t++) await sleep(100);
  await sleep(ms);
  const pid = child.pid!;
  const mb = memoryMb(pid);
  child.kill("SIGTERM");
  for (let t = 0; t < 50 && child.exitCode === null && child.signalCode === null; t++) await sleep(100);
  return mb;
}

describe("EventEmbeddingCache reads the index on first use", () => {
  it("does not read the file in the constructor", () => {
    const dir = tempDir("kya-cache-");
    const file = join(dir, "index.json");
    writeFileSync(file, indexWith([{ id: "a", sha1: "s1", seed: 1 }]));
    const cache = new EventEmbeddingCache(file);
    writeFileSync(file, indexWith([{ id: "b", sha1: "s2", seed: 2 }]));
    expect(cache.getCached("a", "s1")).toBeUndefined();
    expect(cache.getCached("b", "s2")).toEqual(storedVectorFor(2));
  });

  it("setMany keeps the entries already on disk", () => {
    const dir = tempDir("kya-cache-");
    const file = join(dir, "index.json");
    writeFileSync(file, indexWith([{ id: "a", sha1: "s1", seed: 1 }]));
    new EventEmbeddingCache(file).setMany([{ id: "b", sha1: "s2", vector: vectorFor(2) }]);
    const reread = new EventEmbeddingCache(file);
    expect(reread.getCached("a", "s1")).toEqual(storedVectorFor(1));
    expect(reread.getCached("b", "s2")).toEqual(storedVectorFor(2));
  });

  it("a missing or corrupt index is an empty cache", () => {
    const dir = tempDir("kya-cache-");
    const file = join(dir, "index.json");
    expect(new EventEmbeddingCache(file).getCached("a", "s1")).toBeUndefined();
    writeFileSync(file, "{not json");
    expect(new EventEmbeddingCache(file).getCached("a", "s1")).toBeUndefined();
  });

  it(
    "a daemon with a 60 MB index holds about as much memory as one with no index",
    async () => {
      const dir = tempDir("kya-lazy-index-");
      const big = join(dir, "big-index.json");
      writeFakeIndex(big, 60 * 1024 * 1024);
      const withIndex = await daemonMemoryAfter(big, 5_000);
      const withoutIndex = await daemonMemoryAfter(join(dir, "absent.json"), 5_000);
      expect(withIndex - withoutIndex).toBeLessThan(40);
    },
    90_000,
  );
});

describe("EventEmbeddingCache: an unreadable index is never overwritten", () => {
  it("keeps a corrupt index file as it is when a new batch is added", () => {
    const dir = mkdtempSync(join(tmpdir(), "kya-cache-bad-"));
    try {
      const file = join(dir, "search-index.json");
      writeFileSync(file, '{"version":1,"entries":[{"id":"a"', "utf8");
      const cache = new EventEmbeddingCache(file);
      cache.setMany([{ id: "b", sha1: "x", vector: [1, 2, 3] }]);
      expect(readFileSync(file, "utf8")).toBe('{"version":1,"entries":[{"id":"a"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
