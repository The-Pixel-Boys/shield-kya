/**
 * Optional local semantic embeddings for activity search.
 *
 * The runtime (@shield-agent/fastembed) is NOT a dependency of kya. It is opt-in:
 * install it under `globalConfigDir()/semantic` (the hint printed when it is
 * missing shows the command). It is loaded lazily from that prefix only, and a
 * missing runtime degrades to lexical search. The provider is gated by environment
 * variables and never throws: any failure logs once to stderr and returns undefined.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { atomicWriteSync } from "../fs-atomic.js";
import { semanticInstallCommand, semanticRuntimeDir } from "./semantic-status.js";
import { eventDocumentText, eventKey, eventTextSha1 } from "./search.js";
import type { TrailEvent } from "../trail.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | undefined>;
  /** Optional batch embed. Providers that implement this can warm the index
   * orders of magnitude faster than one-by-one calls. */
  embedBatch?(texts: string[]): Promise<(number[] | undefined)[] | undefined>;
}

const MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2";
const EXPECTED_DIMS = 384;
const CACHE_DIR = join(homedir(), ".kya", "models");

interface FastEmbedModule {
  EmbeddingModel?: Record<string, string | number>;
  FlagEmbedding?: {
    init(options: { model: string | number; cacheDir: string }): Promise<FastEmbedModel>;
  };
}

interface FastEmbedModel {
  /** fastembed yields one array-of-vectors per input batch. */
  embed(texts: string[]): AsyncIterableIterator<number[][]>;
}

function modelDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.KYA_SEARCH_SEMANTIC === "off";
}

export { semanticInstallCommand, semanticRuntimeDir } from "./semantic-status.js";

const RUNTIME_PKG = "@shield-agent/fastembed";
let hintShown = false;

/** True only when the requested runtime package itself is missing (not a nested dependency). */
function isNotInstalled(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.code === "MODULE_NOT_FOUND" && typeof e.message === "string" && e.message.includes(`'${RUNTIME_PKG}'`);
}

/**
 * Load the runtime from the opt-in prefix only. The resolver is not allowed to walk
 * parent directories or NODE_PATH: a result outside <prefix>/node_modules is refused
 * before any of its code runs. Returns undefined when the runtime is not installed.
 */
function importFastEmbed(env: NodeJS.ProcessEnv): FastEmbedModule | undefined {
  const root = semanticRuntimeDir(env);
  let nodeModules: string;
  try {
    nodeModules = join(realpathSync(root), "node_modules");
  } catch {
    return undefined;
  }
  const req = createRequire(join(root, "package.json"));
  let file: string;
  try {
    file = realpathSync(req.resolve(RUNTIME_PKG));
  } catch (err) {
    if (isNotInstalled(err)) return undefined;
    throw err;
  }
  if (!file.startsWith(nodeModules + sep)) return undefined;
  try {
    return req(file) as FastEmbedModule;
  } catch (err) {
    if (isNotInstalled(err)) return undefined;
    throw err;
  }
}

/** One stderr line per process. Search keeps working without the runtime (lexical only). */
function hintMissingRuntime(env: NodeJS.ProcessEnv): void {
  if (hintShown) return;
  hintShown = true;
  console.error(`KYA semantic search is off (optional runtime not installed). Enable: ${semanticInstallCommand(env)}`);
}

/** Local MiniLM provider via the opt-in fastembed runtime; loaded on first use. */
export class LocalMiniLmProvider implements EmbeddingProvider {
  private queryModel: FastEmbedModel | undefined;
  private batchModel: FastEmbedModel | undefined;
  private queryTried = false;
  private batchTried = false;
  /** fastembed model init is not re-entrant; serialize loadModel calls. */
  private loadLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private async withLoadLock<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.loadLock.then(() => fn());
    this.loadLock = p.catch(() => {});
    return p;
  }

  private async loadModel(which: "query" | "batch"): Promise<FastEmbedModel | undefined> {
    return this.withLoadLock(async () => {
      if (modelDisabled(this.env)) return undefined;
      const modelProp = which === "query" ? "queryModel" : "batchModel";
      const triedProp = which === "query" ? "queryTried" : "batchTried";
      if (this[triedProp] && !this[modelProp]) return undefined;
      this[triedProp] = true;
      const fastembed = importFastEmbed(this.env);
      if (!fastembed) {
        hintMissingRuntime(this.env);
        return undefined;
      }
      const EmbeddingModel =
        fastembed.EmbeddingModel?.[MODEL_NAME] ??
        fastembed.EmbeddingModel?.AllMiniLML6V2 ??
        fastembed.EmbeddingModel?.BAAI_BGE_SMALL_EN_V1_5 ??
        fastembed.EmbeddingModel?.BGESmallENV15;
      if (!EmbeddingModel) return undefined;
      if (!this[modelProp]) {
        mkdirSync(CACHE_DIR, { recursive: true });
        const FlagEmbedding = fastembed.FlagEmbedding;
        if (!FlagEmbedding) return undefined;
        this[modelProp] = await FlagEmbedding.init({
          model: EmbeddingModel,
          cacheDir: CACHE_DIR,
        });
      }
      return this[modelProp];
    });
  }

  async embed(text: string): Promise<number[] | undefined> {
    try {
      const model = await this.loadModel("query");
      if (!model) return undefined;
      let batch: number[][] | undefined;
      for await (const vec of model.embed([text])) {
        batch = vec;
        break;
      }
      const result = batch?.[0];
      if (!result || result.length !== EXPECTED_DIMS) return undefined;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`KYA semantic search unavailable: ${message}`);
      return undefined;
    }
  }

  async embedBatch(texts: string[]): Promise<(number[] | undefined)[] | undefined> {
    try {
      const model = await this.loadModel("batch");
      if (!model) return undefined;
      const BATCH_SIZE = 64;
      const results: (number[] | undefined)[] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const chunk = texts.slice(i, i + BATCH_SIZE);
        const chunkResults: number[][] = [];
        for await (const vec of model.embed(chunk)) {
          // fastembed yields one array-of-vectors per batch, not one vector per iteration.
          chunkResults.push(...vec);
        }
        if (chunkResults.length !== chunk.length) return undefined;
        results.push(...chunkResults.map((v) => (v.length === EXPECTED_DIMS ? v : undefined)));
        // Yield to the event loop so concurrent query embeddings can interleave
        // instead of being queued behind the entire warmup batch.
        await new Promise((r) => setImmediate(r));
      }
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`KYA semantic search batch unavailable: ${message}`);
      return undefined;
    }
  }
}

interface CacheEntry {
  /** Hex sha1 of the document sha1 the vector was made from. */
  readonly check: string;
  readonly vector: Float32Array;
}

/**
 * search-index.bin layout (little endian). The header never changes after create:
 *   magic "KYAV", u32 format version, u32 dimension, u32 reserved (0).
 * Then fixed-size records, oldest first:
 *   4-byte record check (first 4 bytes of sha1 over the rest of the record),
 *   20-byte sha1 of the event id, 20-byte sha1 of the document sha1, dimension x float32.
 * The record count comes from the file length: a header count would have to be
 * rewritten on every append, and after a crash it could disagree with the tail.
 */
const MAGIC = "KYAV";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 16;
const HASH_BYTES = 20;
const CHECK_BYTES = 4;
const RECORD_BYTES = CHECK_BYTES + 2 * HASH_BYTES + EXPECTED_DIMS * 4;
const DEFAULT_MAX_ENTRIES = 20_000;
const LEGACY_VERSION = 1;
const DEFAULT_CACHE_FILE = join(homedir(), ".kya", "search-index.json");

function sha1(text: string): Buffer {
  return createHash("sha1").update(text).digest();
}

function recordCheck(record: Buffer): Buffer {
  return createHash("sha1").update(record.subarray(CHECK_BYTES)).digest().subarray(0, CHECK_BYTES);
}

function encodeRecord(idHash: string, check: string, vector: Float32Array): Buffer {
  const rec = Buffer.alloc(RECORD_BYTES);
  rec.write(idHash, CHECK_BYTES, HASH_BYTES, "hex");
  rec.write(check, CHECK_BYTES + HASH_BYTES, HASH_BYTES, "hex");
  let off = CHECK_BYTES + 2 * HASH_BYTES;
  for (let i = 0; i < EXPECTED_DIMS; i++, off += 4) rec.writeFloatLE(vector[i]!, off);
  recordCheck(rec).copy(rec, 0);
  return rec;
}

function encodeHeader(): Buffer {
  const head = Buffer.alloc(HEADER_BYTES);
  head.write(MAGIC, 0, "latin1");
  head.writeUInt32LE(FORMAT_VERSION, 4);
  head.writeUInt32LE(EXPECTED_DIMS, 8);
  return head;
}

function headerOk(buf: Buffer): boolean {
  return (
    buf.length >= HEADER_BYTES &&
    buf.toString("latin1", 0, 4) === MAGIC &&
    buf.readUInt32LE(4) === FORMAT_VERSION &&
    buf.readUInt32LE(8) === EXPECTED_DIMS
  );
}

function maxEntries(env: NodeJS.ProcessEnv): number {
  const n = Number(env.KYA_SEARCH_INDEX_MAX);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ENTRIES;
}

/**
 * On-disk cache for event embeddings keyed by event id and document sha1.
 * New vectors are appended to search-index.bin; the whole file is rewritten only
 * to compact it. A legacy search-index.json is read once, converted, and renamed
 * to search-index.json.migrated (kept, never deleted).
 */
export class EventEmbeddingCache {
  // Read on first use: the report daemon builds this cache at start even when search is never used.
  private entries: Map<string, CacheEntry> | undefined;
  private readonly binFile: string;
  private readonly legacyFile: string | undefined;
  private readonly max: number;
  /** The file exists but could not be read: never write over it with a near-empty index. */
  private unreadable = false;
  /** Records in the file as last read or written; undefined = no valid file to append to. */
  private diskRecords: number | undefined;
  private window = new Set<string>();

  constructor(cacheFile?: string, env: NodeJS.ProcessEnv = process.env) {
    const file = cacheFile ?? env.KYA_SEARCH_INDEX ?? DEFAULT_CACHE_FILE;
    this.binFile = file.endsWith(".json") ? `${file.slice(0, -".json".length)}.bin` : file;
    this.legacyFile = file.endsWith(".json") ? file : undefined;
    this.max = maxEntries(env);
  }

  private loaded(): Map<string, CacheEntry> {
    if (!this.entries) {
      this.entries = this.load();
      this.evictOverCap();
    }
    return this.entries;
  }

  private load(): Map<string, CacheEntry> {
    const entries = new Map<string, CacheEntry>();
    try {
      if (existsSync(this.binFile)) this.readBin(entries);
      else if (this.legacyFile && existsSync(this.legacyFile)) this.migrate(entries);
    } catch {
      this.unreadable = true;
      entries.clear();
    }
    return entries;
  }

  private readBin(entries: Map<string, CacheEntry>): void {
    const buf = readFileSync(this.binFile);
    if (!headerOk(buf)) throw new Error("search index header not recognized");
    let off = HEADER_BYTES;
    let records = 0;
    // A damaged record is skipped and a torn tail is ignored; the next save compacts the file.
    let damaged = false;
    for (; off + RECORD_BYTES <= buf.length; off += RECORD_BYTES, records++) {
      const rec = buf.subarray(off, off + RECORD_BYTES);
      if (!recordCheck(rec).equals(rec.subarray(0, CHECK_BYTES))) {
        damaged = true;
        continue;
      }
      const vector = new Float32Array(EXPECTED_DIMS);
      const base = CHECK_BYTES + 2 * HASH_BYTES;
      for (let i = 0; i < EXPECTED_DIMS; i++) vector[i] = rec.readFloatLE(base + i * 4);
      const idHash = rec.toString("hex", CHECK_BYTES, CHECK_BYTES + HASH_BYTES);
      entries.delete(idHash);
      entries.set(idHash, { check: rec.toString("hex", CHECK_BYTES + HASH_BYTES, RECORD_BYTES - EXPECTED_DIMS * 4), vector });
    }
    this.diskRecords = off === buf.length && !damaged ? records : undefined;
  }

  private migrate(entries: Map<string, CacheEntry>): void {
    const legacy = this.legacyFile!;
    const raw = JSON.parse(readFileSync(legacy, "utf8")) as {
      version?: number;
      entries?: { id: string; sha1: string; vector: number[] }[];
    };
    // KYA_SEARCH_INDEX can point at any JSON file: touch only a file that is a legacy index.
    if (raw.version !== LEGACY_VERSION || !Array.isArray(raw.entries)) throw new Error("not a legacy search index");
    for (const e of raw.entries) {
      if (e?.vector?.length !== EXPECTED_DIMS) continue;
      const idHash = sha1(e.id).toString("hex");
      entries.delete(idHash);
      entries.set(idHash, { check: sha1(e.sha1).toString("hex"), vector: Float32Array.from(e.vector) });
    }
    this.entries = entries;
    if (!this.rewrite()) return;
    const kept = `${legacy}.migrated`;
    // An older .migrated copy is never replaced; the legacy file then stays, and the .bin wins.
    if (!existsSync(kept)) {
      try {
        renameSync(legacy, kept);
      } catch {
        /* the .bin is read first, so a legacy file left in place is ignored */
      }
    }
  }

  /** Write every live entry to a new file in one atomic step. */
  private rewrite(): boolean {
    if (this.unreadable || !this.entries) return false;
    try {
      const parts = [encodeHeader()];
      for (const [idHash, e] of this.entries) {
        if (e.vector.length === EXPECTED_DIMS) parts.push(encodeRecord(idHash, e.check, e.vector));
      }
      mkdirSync(dirname(this.binFile), { recursive: true });
      atomicWriteSync(this.binFile, Buffer.concat(parts));
      this.diskRecords = parts.length - 1;
      return true;
    } catch {
      this.diskRecords = undefined;
      return false;
    }
  }

  private append(records: Buffer[]): void {
    if (this.unreadable || records.length === 0) return;
    try {
      // Another daemon can append to the same file: check its real length, never trust the count.
      const size = this.diskRecords === undefined ? -1 : statSync(this.binFile).size;
      if (size < HEADER_BYTES || (size - HEADER_BYTES) % RECORD_BYTES !== 0) {
        this.rewrite();
        return;
      }
      appendFileSync(this.binFile, Buffer.concat(records));
      this.diskRecords = (size - HEADER_BYTES) / RECORD_BYTES + records.length;
    } catch {
      this.diskRecords = undefined;
    }
  }

  /** Drop the oldest entries above the cap. Ids in the current report window go last. */
  private evictOverCap(): void {
    const entries = this.entries!;
    let over = entries.size - this.max;
    if (over <= 0) return;
    for (const pass of [false, true]) {
      for (const idHash of entries.keys()) {
        if (over <= 0) return;
        if (this.window.has(idHash) !== pass) continue;
        entries.delete(idHash);
        over--;
      }
    }
  }

  /** Ids of the events in the current report window: pruning keeps these before older ones. */
  setWindow(eventIds: Iterable<string>): void {
    this.window = new Set([...eventIds].map((id) => sha1(id).toString("hex")));
  }

  getCached(eventId: string, textSha1: string): number[] | undefined {
    const e = this.loaded().get(sha1(eventId).toString("hex"));
    return e && e.check === sha1(textSha1).toString("hex") ? Array.from(e.vector) : undefined;
  }

  setCached(eventId: string, textSha1: string, vector: number[]): void {
    this.setMany([{ id: eventId, sha1: textSha1, vector }]);
  }

  /** Add or replace many entries; only the new records are written. */
  setMany(batch: readonly { readonly id: string; readonly sha1: string; readonly vector: number[] }[]): void {
    const entries = this.loaded();
    const records: Buffer[] = [];
    for (const b of batch) {
      const idHash = sha1(b.id).toString("hex");
      const entry = { check: sha1(b.sha1).toString("hex"), vector: Float32Array.from(b.vector) };
      entries.delete(idHash);
      entries.set(idHash, entry);
      // Other sizes stay in memory only: the file holds one fixed dimension.
      if (b.vector.length === EXPECTED_DIMS) records.push(encodeRecord(idHash, entry.check, entry.vector));
    }
    this.evictOverCap();
    // Compact when stale records (replaced or evicted) pass a quarter of the cap.
    if (this.diskRecords === undefined || this.diskRecords + records.length - entries.size > this.max / 4) {
      this.rewrite();
    } else {
      this.append(records);
    }
  }
}

const SAVE_INTERVAL = 256;

/**
 * Build a map of embeddings for the given events. Already-cached entries are
 * returned without calling the provider; missing entries are embedded and
 * written to the cache in chunks so the index warms incrementally.
 */
export async function buildEventEmbeddings(
  events: readonly TrailEvent[],
  provider: EmbeddingProvider,
  cache: EventEmbeddingCache,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const pending: { id: string; sha1: string; text: string }[] = [];
  cache.setWindow(events.map(eventKey));
  for (const e of events) {
    const id = eventKey(e);
    const sha1 = eventTextSha1(e);
    const cached = cache.getCached(id, sha1);
    if (cached) {
      out.set(id, cached);
    } else {
      pending.push({ id, sha1, text: eventDocumentText(e) });
    }
  }

  const saveChunk = (chunk: readonly { id: string; sha1: string; vector: number[] }[]): void => {
    if (chunk.length > 0) cache.setMany(chunk);
  };

  if (provider.embedBatch) {
    for (let i = 0; i < pending.length; i += SAVE_INTERVAL) {
      const slice = pending.slice(i, i + SAVE_INTERVAL);
      const vectors = await provider.embedBatch(slice.map((p) => p.text));
      const saveBatch: { id: string; sha1: string; vector: number[] }[] = [];
      if (vectors) {
        for (let j = 0; j < slice.length; j++) {
          const vector = vectors[j];
          if (!vector) continue;
          const { id, sha1 } = slice[j]!;
          saveBatch.push({ id, sha1, vector });
          out.set(id, vector);
        }
      }
      saveChunk(saveBatch);
      // Yield between chunks so the live server stays responsive.
      await new Promise((r) => setImmediate(r));
    }
  } else {
    // Fallback for test fakes and legacy providers.
    for (let i = 0; i < pending.length; i++) {
      const { id, sha1, text } = pending[i]!;
      const vector = await provider.embed(text);
      if (vector) {
        saveChunk([{ id, sha1, vector }]);
        out.set(id, vector);
      }
    }
  }
  return out;
}
