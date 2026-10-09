import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/certify/catalog.js";

const MAP_URL = new URL("../src/certify/eu-ai-act-map.json", import.meta.url);
const DOC_URL = new URL("../docs/certify-eu-ai-act.md", import.meta.url);
const ARTICLE_KEY = /^art-\d+$/;

interface EuAiActMap {
  version: number;
  articles: Record<string, { title: string; requirements: string[] }>;
  requirementToArticles: Record<string, string[]>;
}

function loadMap(): EuAiActMap {
  return JSON.parse(readFileSync(fileURLToPath(MAP_URL), "utf8")) as EuAiActMap;
}

describe("certify EU AI Act crosswalk", () => {
  const map = loadMap();
  const catalog = loadCatalog();
  const catalogIds = catalog.requirements.map((r) => r.id);

  it("covers every catalog requirement in requirementToArticles", () => {
    expect(catalog.requirements.length).toBeGreaterThan(0);
    for (const id of catalogIds) {
      expect(
        map.requirementToArticles[id],
        `requirementToArticles is missing catalog requirement ${id}`,
      ).toBeDefined();
      expect(map.requirementToArticles[id].length).toBeGreaterThan(0);
    }
  });

  it("references only requirement ids that exist in the catalog", () => {
    const known = new Set(catalogIds);
    const referenced = new Set<string>([
      ...Object.keys(map.requirementToArticles),
      ...Object.values(map.articles).flatMap((a) => a.requirements),
    ]);
    for (const id of referenced) {
      expect(known.has(id), `${id} is not a catalog requirement`).toBe(true);
    }
  });

  it("uses article keys matching /^art-\\d+$/", () => {
    for (const key of Object.keys(map.articles)) {
      expect(key).toMatch(ARTICLE_KEY);
    }
    for (const [id, articles] of Object.entries(map.requirementToArticles)) {
      for (const art of articles) {
        expect(art, `${id} references malformed article ${art}`).toMatch(ARTICLE_KEY);
        expect(
          map.articles[art],
          `${id} references article ${art} missing from articles`,
        ).toBeDefined();
      }
    }
  });

  it("keeps articles and requirementToArticles consistent", () => {
    for (const [art, def] of Object.entries(map.articles)) {
      for (const id of def.requirements) {
        expect(
          map.requirementToArticles[id],
          `articles.${art} lists ${id} but requirementToArticles.${id} omits it`,
        ).toContain(art);
      }
    }
  });

  it("has a doc file containing every article key", () => {
    const docPath = fileURLToPath(DOC_URL);
    expect(existsSync(docPath), `doc not found: ${docPath}`).toBe(true);
    const doc = readFileSync(docPath, "utf8");
    for (const key of Object.keys(map.articles)) {
      expect(doc, `doc does not mention ${key}`).toContain(key);
    }
  });
});
