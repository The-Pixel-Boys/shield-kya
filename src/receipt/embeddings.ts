/**
 * Optional local semantic embeddings for activity search.
 *
 * fastembed is imported lazily so that production installs without the
 * package remain lightweight. The provider is gated by environment variables
 * and never throws: any failure logs once to stderr and returns undefined.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { eventDocumentText, eventKey, eventTextSha1 } from "./search.js";
import type { TrailEvent } from "../trail.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | undefined>;
}

const MODEL_NAME = "BAAI/bge-small-en-v1.5";
const EXPECTED_DIMS = 384;
const CACHE_DIR = join(homedir(), ".kya", "models");

interface FastEmbedModule {
  EmbeddingModel?: Record<string, string | number>;
  FlagEmbedding?: {
    init(options: { model: string | number; cacheDir: string }): Promise<FastEmbedModel>;
  };
}

interface FastEmbedModel {
  embed(texts: string[]): AsyncIterableIterator<number[]>;
}

function modelDisabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.KYA_SEARCH_SEMANTIC === "off" ||
    env.KYA_OFFLINE === "1" ||
    env.KYA_OFFLINE === "true"
  );
}

/** Local MiniLM provider via fastembed; loaded on first use. */
export class LocalMiniLmProvider implements EmbeddingProvider {
  private model: FastEmbedModel | undefined;
  private tried = false;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async embed(text: string): Promise<number[] | undefined> {
    if (modelDisabled(this.env)) return undefined;
    if (this.tried && !this.model) return undefined;
    this.tried = true;
    try {
      const fastembed = (await import("fastembed").catch(() => undefined)) as FastEmbedModule | undefined;
      if (!fastembed) return undefined;
      const EmbeddingModel =
        fastembed.EmbeddingModel?.[MODEL_NAME] ??
        fastembed.EmbeddingModel?.BAAI_BGE_SMALL_EN_V1_5;
      if (!EmbeddingModel) return undefined;
      if (!this.model) {
        mkdirSync(CACHE_DIR, { recursive: true });
        const FlagEmbedding = fastembed.FlagEmbedding;
        if (!FlagEmbedding) return undefined;
        this.model = await FlagEmbedding.init({
          model: EmbeddingModel,
          cacheDir: CACHE_DIR,
        });
      }
      let result: number[] | undefined;
      for await (const vec of this.model.embed([text])) {
        result = vec;
        break;
      }
      if (!result || result.length !== EXPECTED_DIMS) return undefined;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`KYA semantic search unavailable: ${message}`);
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

const CACHE_FILE = join(homedir(), ".kya", "search-index.json");
const CACHE_VERSION = 1;

/** On-disk cache for event embeddings keyed by event id and document sha1. */
export class EventEmbeddingCache {
  private data: CacheFile;

  constructor() {
    this.data = this.load();
  }

  private load(): CacheFile {
    try {
      if (!existsSync(CACHE_FILE)) return { version: CACHE_VERSION, entries: [] };
      const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as CacheFile;
      if (raw.version !== CACHE_VERSION) return { version: CACHE_VERSION, entries: [] };
      return raw;
    } catch {
      return { version: CACHE_VERSION, entries: [] };
    }
  }

  private save(): void {
    try {
      mkdirSync(join(homedir(), ".kya"), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(this.data, null, 2), "utf8");
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

/**
 * Build a map of embeddings for the given events. Already-cached entries are
 * returned without calling the provider; missing entries are embedded and
 * written to the cache in a single batch.
 */
export async function buildEventEmbeddings(
  events: readonly TrailEvent[],
  provider: EmbeddingProvider,
  cache: EventEmbeddingCache,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const batch: { id: string; sha1: string; vector: number[] }[] = [];
  for (const e of events) {
    const id = eventKey(e);
    const sha1 = eventTextSha1(e);
    const cached = cache.getCached(id, sha1);
    if (cached) {
      out.set(id, cached);
      continue;
    }
    const vector = await provider.embed(eventDocumentText(e));
    if (vector) {
      batch.push({ id, sha1, vector });
      out.set(id, vector);
    }
  }
  if (batch.length > 0) {
    cache.setMany(batch);
  }
  return out;
}
