/**
 * Optional local semantic embeddings for activity search.
 *
 * fastembed is imported lazily so that production installs without the
 * package remain lightweight. The provider is gated by environment variables
 * and never throws: any failure logs once to stderr and returns undefined.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/** Local MiniLM provider via fastembed; loaded on first use. */
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
      const fastembed = (await import("fastembed").catch(() => undefined)) as FastEmbedModule | undefined;
      if (!fastembed) return undefined;
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
  readonly id: string;
  readonly sha1: string;
  readonly vector: number[];
}

interface CacheFile {
  readonly version: number;
  readonly entries: CacheEntry[];
}

const DEFAULT_CACHE_FILE = join(homedir(), ".kya", "search-index.json");
const CACHE_VERSION = 1;

/** On-disk cache for event embeddings keyed by event id and document sha1. */
export class EventEmbeddingCache {
  private data: CacheFile;
  private readonly cacheFile: string;

  constructor(cacheFile?: string) {
    this.cacheFile = cacheFile ?? process.env.KYA_SEARCH_INDEX ?? DEFAULT_CACHE_FILE;
    this.data = this.load();
  }

  private load(): CacheFile {
    try {
      if (!existsSync(this.cacheFile)) return { version: CACHE_VERSION, entries: [] };
      const raw = JSON.parse(readFileSync(this.cacheFile, "utf8")) as CacheFile;
      if (raw.version !== CACHE_VERSION) return { version: CACHE_VERSION, entries: [] };
      return raw;
    } catch {
      return { version: CACHE_VERSION, entries: [] };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.data, null, 2), "utf8");
    } catch {
      /* best-effort cache */
    }
  }

  getCached(eventId: string, textSha1: string): number[] | undefined {
    return this.data.entries.find((e) => e.id === eventId && e.sha1 === textSha1)?.vector;
  }

  setCached(eventId: string, textSha1: string, vector: number[]): void {
    this.setMany([{ id: eventId, sha1: textSha1, vector }]);
  }

  /** Replace many entries in one pass instead of filtering on every item. */
  setMany(batch: readonly { readonly id: string; readonly sha1: string; readonly vector: number[] }[]): void {
    const replaced = new Set(batch.map((b) => b.id));
    const entries = this.data.entries.filter((e) => !replaced.has(e.id));
    entries.push(...batch);
    this.data = { version: CACHE_VERSION, entries };
    this.save();
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
