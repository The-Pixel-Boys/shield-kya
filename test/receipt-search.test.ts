import { describe, expect, it } from "vitest";
import {
  Bm25Index,
  buildEventIndex,
  cosine,
  extractFacetHints,
  rankEvents,
  rrfMerge,
  tokenize,
} from "../src/receipt/search.js";
import type { TrailEvent } from "../src/trail.js";

function ev(partial: Partial<TrailEvent> & Pick<TrailEvent, "ts" | "sessionId">): TrailEvent {
  return {
    toolId: "org.sample.safe.read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...partial,
  };
}

describe("tokenize", () => {
  it("lowercases, splits non-alphanum, and drops stopwords", () => {
    expect(tokenize("The quick brown fox")).toEqual(["quick", "brown", "fox"]);
  });

  it("splits camelCase, snake_case, kebab-case, and dot.case", () => {
    expect(tokenize("readFile_someThing foo-bar baz.qux")).toEqual([
      "read",
      "file",
      "thing",
      "foo",
      "bar",
      "baz",
      "qux",
    ]);
  });

  it("light-stems trailing ing/ed/s", () => {
    expect(tokenize("running runners denied uses")).toEqual(["run", "runner", "deni"]);
  });
});

describe("BM25 index", () => {
  it("ranks title matches higher than body matches", () => {
    const index = new Bm25Index();
    index.add("title-match", {
      id: "title-match",
      tokens: ["deploy", "api", "gateway"],
      fields: [
        { text: "deploy api gateway", weight: 2 },
        { text: "some body text", weight: 1 },
      ],
    });
    index.add("body-match", {
      id: "body-match",
      tokens: ["some", "body", "deploy"],
      fields: [
        { text: "some body", weight: 2 },
        { text: "deploy text", weight: 1 },
      ],
    });
    const results = index.search("deploy api gateway");
    expect(results[0]?.id).toBe("title-match");
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("buildEventIndex orders events by query relevance", () => {
    const events: TrailEvent[] = [
      ev({ ts: "2026-09-11T10:00:00.000Z", sessionId: "s", toolId: "org.sample.safe.read", summary: "read api docs" }),
      ev({ ts: "2026-09-11T09:00:00.000Z", sessionId: "s", toolId: "org.deploy.api.publish", summary: "deployed the api" }),
      ev({ ts: "2026-09-11T08:00:00.000Z", sessionId: "s", toolId: "org.api.health", summary: "api health check" }),
    ];
    const ranked = rankEvents(events, { query: "deploy api" });
    expect(ranked[0]?.event.toolId).toBe("org.deploy.api.publish");
    expect(ranked[1]?.event.toolId).toBe("org.api.health");
    expect(ranked[2]?.event.toolId).toBe("org.sample.safe.read");
  });
});

describe("extractFacetHints", () => {
  it("maps natural-language terms to facet values", () => {
    expect(extractFacetHints("denied postgres calls by cursor")).toEqual({
      verdict: ["DENY"],
      server: ["PostgreSQL"],
      product: ["cursor"],
    });
  });

  it("returns an empty object when no hints match", () => {
    expect(extractFacetHints("hello world")).toEqual({});
  });

  it("recognizes aliases for products and servers", () => {
    expect(extractFacetHints("github slack claude")).toEqual({
      server: ["GitHub", "Slack"],
      product: ["claude"],
    });
  });
});

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 for mismatched or empty vectors", () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});

describe("rrfMerge", () => {
  it("boosts documents present in both rankings", () => {
    const bm25 = [
      { id: "a", score: 10 },
      { id: "b", score: 5 },
      { id: "c", score: 1 },
    ];
    const semantic = [
      { id: "b", score: 0.9 },
      { id: "d", score: 0.8 },
    ];
    const merged = rrfMerge(bm25, semantic);
    expect(merged.map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("uses k to control rank contribution", () => {
    const bm25 = [{ id: "a", score: 1 }, { id: "b", score: 0.9 }];
    const semantic = [{ id: "b", score: 1 }, { id: "c", score: 0.8 }];
    const merged = rrfMerge(bm25, semantic, 60);
    // b appears in both lists: rank 2 in BM25, rank 1 in semantic.
    expect(merged[0]?.id).toBe("b");
    expect(merged[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 8);
  });
});

describe("rankEvents", () => {
  it("applies chip filters before ranking", () => {
    const events: TrailEvent[] = [
      ev({ ts: "2026-09-11T10:00:00.000Z", sessionId: "s", toolId: "tool-A", verdict: "DENY" }),
      ev({ ts: "2026-09-11T09:00:00.000Z", sessionId: "s", toolId: "tool-B", verdict: "ALLOW" }),
      ev({ ts: "2026-09-11T08:00:00.000Z", sessionId: "s", toolId: "tool-C", verdict: "ALLOW" }),
    ];
    const ranked = rankEvents(events, { query: "tool", filters: { verdict: ["ALLOW"] } });
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.event.verdict === "ALLOW")).toBe(true);
  });

  it("falls back to BM25 when embeddings are absent", () => {
    const events: TrailEvent[] = [
      ev({ ts: "2026-09-11T10:00:00.000Z", sessionId: "s", toolId: "A", summary: "database migration" }),
      ev({ ts: "2026-09-11T09:00:00.000Z", sessionId: "s", toolId: "B", summary: "update readme" }),
    ];
    const ranked = rankEvents(events, { query: "migration" });
    expect(ranked[0]?.event.toolId).toBe("A");
  });
});
