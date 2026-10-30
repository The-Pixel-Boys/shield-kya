// Test helper: a CommonJS stand-in for the opt-in runtime, installed where `npm install --prefix` puts it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { semanticRuntimeDir } from "../../src/receipt/embeddings.js";

/** 384-dim vectors; the first component of text i is (i + 1) * 0.01. */
export const WORKING_INDEX_JS = `
exports.EmbeddingModel = { BGESmallENV15: "bge" };
exports.FlagEmbedding = { init: async () => ({ embed: async function* (texts) {
  yield texts.map((_, i) => Array.from({ length: 384 }, (_, j) => (i + 1) * 0.01 + j * 0.0001));
} }) };
`;

/** Writes @shield-agent/fastembed under the opt-in prefix for `env` and returns the package dir. */
export function installFakeRuntime(env: NodeJS.ProcessEnv, indexJs: string = WORKING_INDEX_JS): string {
  const pkg = join(semanticRuntimeDir(env), "node_modules", "@shield-agent", "fastembed");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@shield-agent/fastembed", version: "3.0.0", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), indexJs);
  return pkg;
}
