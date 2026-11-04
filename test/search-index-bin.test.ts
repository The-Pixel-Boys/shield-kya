/**
 * search-index.bin: fixed-size Float32 records, append-only writes, a cap with
 * compaction, a one-time migration from search-index.json, and safe reads of a
 * torn tail or a damaged header.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEventEmbeddings, EventEmbeddingCache, type EmbeddingProvider } from "../src/receipt/embeddings.js";
import { eventKey, eventTextSha1, rankEvents } from "../src/receipt/search.js";
import type { TrailEvent } from "../src/trail.js";

const DIMS = 384;
const HEADER = 16;
const RECORD = 4 + 20 + 20 + DIMS * 4;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kya-index-bin-"));
  dirs.push(dir);
  return dir;
}

/** Deterministic pseudo-random vector. */
function vec(seed: number): number[] {
  let x = seed * 2654435761 + 1;
  return Array.from({ length: DIMS }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  });
}

/** The value a Float32 file gives back for a vector. */
function f32(v: number[]): number[] {
  return Array.from(Float32Array.from(v));
}

function entries(from: number, to: number): { id: string; sha1: string; vector: number[] }[] {
  return Array.from({ length: to - from }, (_, k) => ({ id: `e${from + k}`, sha1: `s${from + k}`, vector: vec(from + k) }));
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const noProvider: EmbeddingProvider = { embed: async () => undefined };

const event = (n: number): TrailEvent =>
  ({
    ts: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString(),
    sessionId: "s-1",
    toolId: `org.sample.tool.${n}`,
    reasonCode: "OK",
    verdict: "ALLOW",
    mode: "local",
    summary: `run tool ${n % 7}`,
  }) as unknown as TrailEvent;

describe("search-index.bin format", () => {
  it("round trip: 1,000 vectors come back with the same keys within Float32 precision", () => {
    const file = join(tempDir(), "search-index.bin");
    const cache = new EventEmbeddingCache(file);
    for (let i = 0; i < 1000; i += 250) cache.setMany(entries(i, i + 250));
    expect(statSync(file).size).toBe(HEADER + 1000 * RECORD);
    const reread = new EventEmbeddingCache(file);
    let worst = 0;
    for (let i = 0; i < 1000; i++) {
      const want = vec(i);
      const back = reread.getCached(`e${i}`, `s${i}`)!;
      expect(back).toEqual(f32(want));
      for (let k = 0; k < DIMS; k++) worst = Math.max(worst, Math.abs(back[k]! - want[k]!));
    }
    expect(worst).toBeLessThan(1e-7);
    expect(reread.getCached("e1", "other-sha1")).toBeUndefined();
    expect(reread.getCached("e1000", "s1000")).toBeUndefined();
  });

  it("a .json path derives the .bin name next to it", () => {
    const dir = tempDir();
    new EventEmbeddingCache(join(dir, "idx.json")).setMany(entries(0, 1));
    expect(existsSync(join(dir, "idx.bin"))).toBe(true);
    expect(existsSync(join(dir, "idx.json"))).toBe(false);
  });

  it("a new batch is appended: the file prefix is not rewritten", () => {
    const file = join(tempDir(), "search-index.bin");
    const cache = new EventEmbeddingCache(file);
    cache.setMany(entries(0, 512));
    const before = readFileSync(file);
    const ino = statSync(file).ino;
    cache.setMany(entries(512, 768));
    const after = readFileSync(file);
    expect(after.length - before.length).toBe(256 * RECORD);
    // An atomic rewrite would give a new inode; an append keeps it and the prefix bytes.
    expect(statSync(file).ino).toBe(ino);
    expect(sha256(after.subarray(0, before.length))).toBe(sha256(before));
  });

  it("a torn last record is ignored, and the next save leaves a clean file", () => {
    const file = join(tempDir(), "search-index.bin");
    new EventEmbeddingCache(file).setMany(entries(0, 10));
    // The stray bytes carry a valid record check, so only the length test can stop the read.
    const tail = Buffer.alloc(700, 7);
    createHash("sha256").update(tail.subarray(4)).digest().copy(tail, 0, 0, 4);
    appendFileSync(file, tail);
    const torn = new EventEmbeddingCache(file);
    expect(torn.getCached("e9", "s9")).toEqual(f32(vec(9)));
    torn.setMany(entries(10, 11));
    expect(statSync(file).size).toBe(HEADER + 11 * RECORD);
    const reread = new EventEmbeddingCache(file);
    for (let i = 0; i < 11; i++) expect(reread.getCached(`e${i}`, `s${i}`)).toEqual(f32(vec(i)));
  });

  it("a damaged record in the middle is skipped; the records after it stay, and the next save compacts", () => {
    const file = join(tempDir(), "search-index.bin");
    new EventEmbeddingCache(file).setMany(entries(0, 5));
    const buf = readFileSync(file);
    buf[HEADER + 2 * RECORD + 100] ^= 0xff;
    writeFileSync(file, buf);
    const reread = new EventEmbeddingCache(file);
    expect(reread.getCached("e1", "s1")).toEqual(f32(vec(1)));
    expect(reread.getCached("e2", "s2")).toBeUndefined();
    expect(reread.getCached("e4", "s4")).toEqual(f32(vec(4)));
    reread.setMany(entries(5, 6));
    expect((readFileSync(file).length - HEADER) % RECORD).toBe(0);
    expect(readFileSync(file).length).toBe(HEADER + 5 * RECORD);
  });

  it("a JSON file that is not a legacy index is never renamed or turned into an index", () => {
    const dir = tempDir();
    const other = join(dir, "package.json");
    writeFileSync(other, '{"name":"x","version":"1.0.0"}');
    const cache = new EventEmbeddingCache(other);
    cache.setMany(entries(0, 2));
    expect(readFileSync(other, "utf8")).toBe('{"name":"x","version":"1.0.0"}');
    expect(existsSync(join(dir, "package.json.migrated"))).toBe(false);
    expect(existsSync(join(dir, "package.bin"))).toBe(false);
    // Same shape as an index but another version: only the version check can protect it.
    const v2 = join(dir, "other.json");
    writeFileSync(v2, '{"version":2,"entries":[]}');
    new EventEmbeddingCache(v2).setMany(entries(0, 1));
    expect(readFileSync(v2, "utf8")).toBe('{"version":2,"entries":[]}');
    expect(existsSync(join(dir, "other.json.migrated"))).toBe(false);
  });

  it("a vector of another size stays in memory and does not corrupt the file", () => {
    const file = join(tempDir(), "search-index.bin");
    const cache = new EventEmbeddingCache(file);
    cache.setMany([{ id: "short", sha1: "s", vector: [1, 2, 3] }, ...entries(0, 2)]);
    cache.setMany(entries(2, 3));
    const reread = new EventEmbeddingCache(file);
    expect(reread.getCached("e0", "s0")).toEqual(f32(vec(0)));
    expect(reread.getCached("e2", "s2")).toEqual(f32(vec(2)));
    expect((readFileSync(file).length - HEADER) % RECORD).toBe(0);
  });

  it("a corrupt header leaves the file untouched and the cache works in memory", () => {
    const file = join(tempDir(), "search-index.bin");
    new EventEmbeddingCache(file).setMany(entries(0, 3));
    const buf = readFileSync(file);
    buf.write("XXXX", 0, "latin1");
    writeFileSync(file, buf);
    const cache = new EventEmbeddingCache(file);
    expect(cache.getCached("e0", "s0")).toBeUndefined();
    cache.setMany(entries(3, 4));
    expect(cache.getCached("e3", "s3")).toEqual(f32(vec(3)));
    expect(readFileSync(file).equals(buf)).toBe(true);
  });

  it("records hold SHA-256 cut to 20 bytes of the id and the document sha1, never SHA-1", () => {
    const file = join(tempDir(), "search-index.bin");
    new EventEmbeddingCache(file).setMany(entries(0, 1));
    const buf = readFileSync(file);
    expect(buf.readUInt32LE(4)).toBe(2);
    const rec = buf.subarray(HEADER, HEADER + RECORD);
    const h20 = (s: string) => createHash("sha256").update(s).digest().subarray(0, 20);
    // Mutant checks: SHA-1 in any of the three places fails one of these.
    expect(rec.subarray(4, 24).equals(h20("e0"))).toBe(true);
    expect(rec.subarray(24, 44).equals(h20("s0"))).toBe(true);
    expect(rec.subarray(0, 4).equals(createHash("sha256").update(rec.subarray(4)).digest().subarray(0, 4))).toBe(true);
  });

  it("a format 1 file (SHA-1 records, never released) is left untouched and the cache works in memory", () => {
    const file = join(tempDir(), "search-index.bin");
    new EventEmbeddingCache(file).setMany(entries(0, 3));
    const buf = readFileSync(file);
    buf.writeUInt32LE(1, 4);
    writeFileSync(file, buf);
    const cache = new EventEmbeddingCache(file);
    expect(cache.getCached("e0", "s0")).toBeUndefined();
    cache.setMany(entries(3, 4));
    expect(cache.getCached("e3", "s3")).toEqual(f32(vec(3)));
    expect(readFileSync(file).equals(buf)).toBe(true);
  });

  it("prune to the cap keeps the newest entries and compacts the file", () => {
    const file = join(tempDir(), "search-index.bin");
    const cache = new EventEmbeddingCache(file, { KYA_SEARCH_INDEX_MAX: "100" });
    for (let i = 0; i < 300; i += 10) cache.setMany(entries(i, i + 10));
    // Stale records may wait for compaction, but never more than a quarter of the cap.
    expect(statSync(file).size).toBeLessThanOrEqual(HEADER + 125 * RECORD);
    const reread = new EventEmbeddingCache(file, { KYA_SEARCH_INDEX_MAX: "100" });
    for (let i = 200; i < 300; i++) expect(reread.getCached(`e${i}`, `s${i}`)).toEqual(f32(vec(i)));
    for (let i = 0; i < 200; i++) expect(reread.getCached(`e${i}`, `s${i}`)).toBeUndefined();
  });

  it("prune keeps the ids of the current window before older ones", () => {
    const file = join(tempDir(), "search-index.bin");
    const cache = new EventEmbeddingCache(file, { KYA_SEARCH_INDEX_MAX: "100" });
    cache.setWindow(["e0", "e1"]);
    for (let i = 0; i < 150; i += 10) cache.setMany(entries(i, i + 10));
    expect(cache.getCached("e0", "s0")).toEqual(f32(vec(0)));
    expect(cache.getCached("e1", "s1")).toEqual(f32(vec(1)));
    expect(cache.getCached("e2", "s2")).toBeUndefined();
    expect(cache.getCached("e149", "s149")).toEqual(f32(vec(149)));
  });

  it("migrates a legacy JSON once, keeps it as .migrated, and search results stay the same", async () => {
    const dir = tempDir();
    const json = join(dir, "search-index.json");
    const events = Array.from({ length: 60 }, (_, n) => event(n));
    const legacyEntries = events.map((e, n) => ({ id: eventKey(e), sha1: eventTextSha1(e), vector: vec(n) }));
    const legacyText = JSON.stringify({ version: 1, entries: legacyEntries }, null, 2);
    writeFileSync(json, legacyText);

    const migrated = await buildEventEmbeddings(events, noProvider, new EventEmbeddingCache(json));
    expect(existsSync(json)).toBe(false);
    expect(readFileSync(`${json}.migrated`, "utf8")).toBe(legacyText);
    expect(statSync(join(dir, "search-index.bin")).size).toBe(HEADER + 60 * RECORD);
    expect(statSync(join(dir, "search-index.bin")).size).toBeLessThan(legacyText.length / 5);

    const legacy = new Map(legacyEntries.map((e) => [e.id, e.vector]));
    expect(migrated.size).toBe(60);
    for (let q = 0; q < 10; q++) {
      const opts = { query: "run tool", queryEmbedding: vec(1000 + q) };
      const fromJson = rankEvents(events, { ...opts, embeddings: legacy }).map((r) => eventKey(r.event));
      const fromBin = rankEvents(events, { ...opts, embeddings: migrated }).map((r) => eventKey(r.event));
      expect(fromBin).toEqual(fromJson);
    }
    // Second open reads the .bin only; the .migrated copy is not read or touched.
    const again = await buildEventEmbeddings(events, noProvider, new EventEmbeddingCache(json));
    expect([...again.keys()].sort()).toEqual([...migrated.keys()].sort());
    expect(readFileSync(`${json}.migrated`, "utf8")).toBe(legacyText);
  });

  it("a corrupt legacy JSON is not migrated, renamed or overwritten", () => {
    const dir = tempDir();
    const json = join(dir, "search-index.json");
    writeFileSync(json, '{"version":1,"entries":[{"id":"a"');
    const cache = new EventEmbeddingCache(json);
    cache.setMany(entries(0, 1));
    expect(cache.getCached("e0", "s0")).toEqual(f32(vec(0)));
    expect(readFileSync(json, "utf8")).toBe('{"version":1,"entries":[{"id":"a"');
    expect(existsSync(join(dir, "search-index.bin"))).toBe(false);
    expect(existsSync(`${json}.migrated`)).toBe(false);
  });
});
