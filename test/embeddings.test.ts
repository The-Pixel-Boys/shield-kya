import { describe, expect, it, vi } from "vitest";
import { LocalMiniLmProvider } from "../src/receipt/embeddings.js";

const fakeEmbeddingModel = { key: "BGESmallENV15" };

vi.mock("fastembed", () => ({
  EmbeddingModel: {
    "BAAI/bge-small-en-v1.5": fakeEmbeddingModel,
    BAAI_BGE_SMALL_EN_V1_5: fakeEmbeddingModel,
    BGESmallENV15: fakeEmbeddingModel,
  },
  FlagEmbedding: {
    init: vi.fn(async () => ({
      embed: async function* (texts: string[]) {
        // Real fastembed yields one array-of-vectors per batch, not one vector per iteration.
        yield texts.map((_, i) => Array.from({ length: 384 }, (_, j) => (i + 1) * 0.01 + j * 0.0001));
      },
    })),
  },
}));

describe("LocalMiniLmProvider", () => {
  it("embed returns the first vector from a batched yield", async () => {
    const provider = new LocalMiniLmProvider({});
    const vector = await provider.embed("dangerous operation");
    expect(vector).toBeDefined();
    expect(vector!.length).toBe(384);
    expect(vector![0]).toBeCloseTo(0.01);
  });

  it("embedBatch flattens batched yields into one vector per input", async () => {
    const provider = new LocalMiniLmProvider({});
    const vectors = await provider.embedBatch(["one", "two", "three"]);
    expect(vectors).toBeDefined();
    expect(vectors!.length).toBe(3);
    for (const v of vectors!) {
      expect(v).toBeDefined();
      expect(v!.length).toBe(384);
    }
  });

  it("returns undefined when semantic search is disabled", async () => {
    const provider = new LocalMiniLmProvider({ KYA_SEARCH_SEMANTIC: "off" });
    expect(await provider.embed("anything")).toBeUndefined();
    expect(await provider.embedBatch(["anything"])).toBeUndefined();
  });
});
