// Test helpers for the local triage model: a CommonJS stand-in for onnxruntime-node (installed where
// `npm install --prefix` puts it) and a packed model file with a toy byte-level tokenizer.
// Env knobs of the fake runtime: FAKE_ORT_MARKER (file that records every load and its command line),
// FAKE_ORT_MODE = throw | crash | benign | (default: credential-access), FAKE_ORT_LOG (file that records the ids it was given).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BYTE_TO_UNICODE } from "../../src/alerts/triage-tokenizer.js";
import { loadTriageSchema } from "../../src/alerts/triage-prompt.js";
import { triageModelInstallPath, triageRuntimeDir } from "../../src/alerts/triage-status.js";

export const FAKE_ORT_JS = `
const fs = require("node:fs");
if (process.env.FAKE_ORT_MARKER) fs.appendFileSync(process.env.FAKE_ORT_MARKER, process.argv.slice(1).join(" ") + "\\n");
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
const pick = (n, at, hi = 9) => Float32Array.from({ length: n }, (_, i) => (i === at ? hi : 0));
exports.Tensor = Tensor;
exports.InferenceSession = { create: async (bytes) => {
  if (process.env.FAKE_ORT_MODE === "throw") throw new Error("model load failed");
  if (process.env.FAKE_ORT_MODE === "crash") process.exit(139); // a native crash: no catch can run
  return { run: async (feeds) => {
    if (process.env.FAKE_ORT_LOG) fs.appendFileSync(process.env.FAKE_ORT_LOG, JSON.stringify(Array.from(feeds.input_ids.data, Number)) + "\\n");
    const benign = process.env.FAKE_ORT_MODE === "benign";
    return {
      category_logits: { data: pick(8, benign ? 7 : 1) },
      urgency_logits: { data: pick(4, benign ? 3 : 1) },
      action_logits: { data: pick(5, benign ? 4 : 2) },
      benign_logits: { data: pick(2, benign ? 0 : 1) },
    };
  } };
} };
`;

/** Writes onnxruntime-node under the opt-in prefix of `env`. */
export function installFakeOrt(env: NodeJS.ProcessEnv, indexJs: string = FAKE_ORT_JS): string {
  const pkg = join(triageRuntimeDir(env), "node_modules", "onnxruntime-node");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.30.0", main: "index.js" }));
  writeFileSync(join(pkg, "index.js"), indexJs);
  return pkg;
}

/** Toy tokenizer: one token per byte (id = byte value), [CLS] 256, [SEP] 257. No merges. */
export function toyTokenizer() {
  const vocab: Record<string, number> = {};
  BYTE_TO_UNICODE.forEach((ch, b) => (vocab[ch] = b));
  return { vocab, merges: [] as string[], added: [] as Array<[string, number]>, cls: 256, sep: 257 };
}

/** A packed model file in the real layout (magic, meta length, meta JSON, ONNX bytes). The ONNX bytes are filler. */
export function packModel(over: Record<string, unknown> = {}, onnx: Buffer = Buffer.alloc(4096, 7)): Buffer {
  const labels = Object.fromEntries(loadTriageSchema().questions.map((q) => [q.id, q.choices.map((c) => c.id)]));
  const meta = {
    modelId: "kya-triage-test",
    labels,
    temperature: { category: 1, urgency: 1, action: 1, benign: 1 },
    maxLen: 2048,
    tokenizer: toyTokenizer(),
    ...over,
  };
  const mb = Buffer.from(JSON.stringify(meta));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(mb.length);
  return Buffer.concat([Buffer.from("KYATRI01", "latin1"), len, mb, onnx]);
}

/** Writes the packed model where the offer would put it. Returns the path. */
export function installFakeModel(env: NodeJS.ProcessEnv, over: Record<string, unknown> = {}): string {
  const file = triageModelInstallPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, packModel(over));
  return file;
}

/** Decodes toy-tokenizer ids back to text (for asserting what the model was given). */
export function decodeToy(ids: number[]): string {
  return Buffer.from(ids.filter((i) => i < 256)).toString("utf8");
}
