import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMiniLmProvider } from "../src/receipt/embeddings.js";
import { installFakeRuntime } from "./support/fake-fastembed.js";

describe("LocalMiniLmProvider with an opt-in runtime", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    env = { KYA_HOME: mkdtempSync(join(tmpdir(), "kya-emb-home-")) };
    installFakeRuntime(env);
  });

  it("embed returns the first vector from a batched yield", async () => {
    const vector = await new LocalMiniLmProvider(env).embed("dangerous operation");
    expect(vector).toBeDefined();
    expect(vector!.length).toBe(384);
    expect(vector![0]).toBeCloseTo(0.01);
  });

  it("embedBatch flattens batched yields into one vector per input", async () => {
    const vectors = await new LocalMiniLmProvider(env).embedBatch(["one", "two", "three"]);
    expect(vectors).toBeDefined();
    expect(vectors!.length).toBe(3);
    for (const v of vectors!) {
      expect(v).toBeDefined();
      expect(v!.length).toBe(384);
    }
  });

  it("returns undefined when semantic search is disabled", async () => {
    const provider = new LocalMiniLmProvider({ ...env, KYA_SEARCH_SEMANTIC: "off" });
    expect(await provider.embed("anything")).toBeUndefined();
    expect(await provider.embedBatch(["anything"])).toBeUndefined();
  });
});
