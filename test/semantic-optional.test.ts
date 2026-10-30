// Semantic search runtime is opt-in and loaded only from <KYA_HOME>/.kya/semantic.
// Missing runtime: lexical fallback plus one hint. Anything planted elsewhere must never load.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Module from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrailEvent } from "../src/trail.js";
import { installFakeRuntime } from "./support/fake-fastembed.js";

type Embeddings = typeof import("../src/receipt/embeddings.js");

const HINT = "KYA semantic search is off";
const event = (n: number) =>
  ({
    ts: `2026-10-29T00:00:0${n}Z`,
    sessionId: "s-1",
    toolId: `org.sample.tool.${n}`,
    reasonCode: "OK",
    verdict: "ALLOW",
    summary: `run tool ${n}`,
  }) as unknown as TrailEvent;

describe("semantic search runtime loading", () => {
  let base: string;
  let env: NodeJS.ProcessEnv;
  let errors: string[];
  let emb: Embeddings;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Fresh module instance per test: the one-line hint is process-wide state.
    vi.resetModules();
    emb = await import("../src/receipt/embeddings.js");
    base = mkdtempSync(join(tmpdir(), "kya-semantic-base-"));
    env = { KYA_HOME: join(base, "home") };
    mkdirSync(env.KYA_HOME!, { recursive: true });
    errors = [];
    spy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
  });
  afterEach(() => {
    spy.mockRestore();
    rmSync(base, { recursive: true, force: true });
  });

  it("missing runtime: embed and embedBatch return undefined and print one hint with the install command", async () => {
    const provider = new emb.LocalMiniLmProvider(env);
    expect(await provider.embed("dangerous operation")).toBeUndefined();
    expect(await provider.embedBatch(["a", "b"])).toBeUndefined();
    const hints = errors.filter((e) => e.includes(HINT));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(emb.semanticInstallCommand(env));
    expect(hints[0]).toContain("@shield-agent/fastembed@3.0.0");
  });

  it("missing runtime: buildEventEmbeddings returns an empty map and does not throw", async () => {
    const cache = new emb.EventEmbeddingCache(join(base, "idx.json"));
    const out = await emb.buildEventEmbeddings([event(1), event(2)], new emb.LocalMiniLmProvider(env), cache);
    expect(out.size).toBe(0);
  });

  it("a package planted in a parent directory is never loaded", async () => {
    const marker = join(base, "parent-loaded.txt");
    // Opt-in dir exists, so the resolver would walk outward from it if it were allowed to.
    mkdirSync(emb.semanticRuntimeDir(env), { recursive: true });
    const planted = join(base, "node_modules", "@shield-agent", "fastembed");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "package.json"), JSON.stringify({ name: "@shield-agent/fastembed", main: "index.js" }));
    writeFileSync(join(planted, "index.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); exports.EmbeddingModel = {}; exports.FlagEmbedding = {};`);
    expect(await new emb.LocalMiniLmProvider(env).embed("x")).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(errors.some((e) => e.includes(HINT))).toBe(true);
  });

  it("a package planted on NODE_PATH is never loaded", async () => {
    const marker = join(base, "nodepath-loaded.txt");
    const np = join(base, "np");
    const planted = join(np, "@shield-agent", "fastembed");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "package.json"), JSON.stringify({ name: "@shield-agent/fastembed", main: "index.js" }));
    writeFileSync(join(planted, "index.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); exports.EmbeddingModel = {}; exports.FlagEmbedding = {};`);
    // The opt-in directory must exist so the resolver actually walks outward from it.
    mkdirSync(emb.semanticRuntimeDir(env), { recursive: true });
    const prev = process.env.NODE_PATH;
    process.env.NODE_PATH = np;
    (Module as unknown as { _initPaths(): void })._initPaths();
    try {
      expect(await new emb.LocalMiniLmProvider(env).embed("x")).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = prev;
      (Module as unknown as { _initPaths(): void })._initPaths();
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("an installed but broken runtime logs its error and returns undefined", async () => {
    installFakeRuntime(env, `throw new Error("onnx binary missing");`);
    expect(await new emb.LocalMiniLmProvider(env).embed("x")).toBeUndefined();
    expect(errors.some((e) => e.includes("KYA semantic search unavailable: onnx binary missing"))).toBe(true);
    expect(errors.some((e) => e.includes(HINT))).toBe(false);
  });

  it("a missing nested dependency gets its own error, not the not-installed hint", async () => {
    installFakeRuntime(env, `require("nonexistent-nested-dep"); exports.EmbeddingModel = {}; exports.FlagEmbedding = {};`);
    expect(await new emb.LocalMiniLmProvider(env).embed("x")).toBeUndefined();
    expect(errors.some((e) => e.includes("KYA semantic search unavailable") && e.includes("nonexistent-nested-dep"))).toBe(true);
    expect(errors.some((e) => e.includes(HINT))).toBe(false);
  });

  it("uses the opt-in runtime installed under the semantic prefix (no hint)", async () => {
    installFakeRuntime(env);
    const vector = await new emb.LocalMiniLmProvider(env).embed("dangerous operation");
    expect(vector).toHaveLength(384);
    expect(errors.filter((e) => e.includes(HINT))).toHaveLength(0);
  });
});
