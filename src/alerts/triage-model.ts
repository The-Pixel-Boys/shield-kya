/**
 * Local incident triage with the opt-in model (ModernBERT-base, 4 heads, int8 ONNX).
 *
 * Heavy module: it loads onnxruntime-node and the model file. Import it only from the detached flush
 * child and the report daemon (scan.ts does it on demand, after an incident was claimed), never from the
 * hook path. Advisory and fail open: every problem returns undefined and the alert goes out with the
 * detector severity only. The model never decides whether an alert is sent.
 *
 * Input is renderState(TriageInput): the same privacy-safe text the hosted model sees.
 * Runtime is loaded from <kya home>/.kya/triage only. Model file layout: magic "KYATRI01", uint32 LE meta length, meta JSON (modelId, labels, temperature, maxLen, tokenizer), then the ONNX bytes.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, sep } from "node:path";
import { BpeTokenizer, type TokenizerMeta } from "./triage-tokenizer.js";
import { TRIAGE_RUNTIME_NAME, triageModelFile, triageRuntimeDir } from "./triage-status.js";
import { loadTriageSchema, renderState } from "./triage-prompt.js";
import type { TriageInput } from "./triage-input.js";

export const HEADS = ["category", "urgency", "action", "benign"] as const;
type Head = (typeof HEADS)[number];
const MAGIC = "KYATRI01";

export interface TriagePick {
  readonly id: string;
  /** Calibrated probability, 3 decimals. */
  readonly p: number;
}
export interface IncidentTriage {
  readonly model: string;
  readonly category: TriagePick;
  readonly urgency: TriagePick;
  readonly action: TriagePick;
  /** Probability that the incident is harmless (answer "yes" of the benign head). */
  readonly benign: number;
}

interface PackMeta {
  readonly modelId: string;
  readonly labels: Readonly<Record<Head, readonly string[]>>;
  readonly temperature: Readonly<Record<Head, number>>;
  readonly maxLen: number;
  readonly tokenizer: TokenizerMeta;
}

/** Just what is used of onnxruntime-node. */
interface OrtTensor {
  readonly data: ArrayLike<number>;
}
interface OrtModule {
  InferenceSession: {
    create(model: Uint8Array, options?: Record<string, unknown>): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
      release?(): Promise<void>;
    }>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

interface Loaded {
  readonly meta: PackMeta;
  readonly tok: BpeTokenizer;
  readonly ort: OrtModule;
  readonly session: Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;
}

/** Half of the cores, 1 to 4: measured on an 8-core laptop, 4 threads gave 60 ms per incident, 2 gave 91 ms, 8 was slower than 1. */
function inferenceThreads(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

/** Load the runtime from the opt-in prefix only: a result outside <prefix>/node_modules is refused. */
function importOrt(env: NodeJS.ProcessEnv): OrtModule {
  const root = triageRuntimeDir(env);
  const nodeModules = join(realpathSync(root), "node_modules");
  const req = createRequire(join(root, "package.json"));
  const file = realpathSync(req.resolve(TRIAGE_RUNTIME_NAME));
  if (!file.startsWith(nodeModules + sep)) throw new Error("runtime is outside the opt-in prefix");
  return req(file) as OrtModule;
}

/** Parse the packed file. Throws on a bad magic, a bad meta, or labels that differ from triage-schema.json. */
export function parsePack(raw: Buffer): { meta: PackMeta; onnx: Uint8Array } {
  if (raw.length < 12 || raw.subarray(0, 8).toString("latin1") !== MAGIC) throw new Error("not a kya triage model file");
  const metaLen = raw.readUInt32LE(8);
  if (12 + metaLen >= raw.length) throw new Error("truncated kya triage model file");
  const meta = JSON.parse(raw.subarray(12, 12 + metaLen).toString("utf8")) as PackMeta;
  const schema = loadTriageSchema();
  for (const h of HEADS) {
    const want = schema.questions.find((q) => q.id === h)?.choices.map((c) => c.id) ?? [];
    if (JSON.stringify(meta.labels?.[h]) !== JSON.stringify(want)) throw new Error(`model labels for ${h} differ from triage-schema.json`);
    if (!(meta.temperature?.[h] > 0)) throw new Error(`bad temperature for ${h}`);
  }
  return { meta, onnx: new Uint8Array(raw.buffer, raw.byteOffset + 12 + metaLen, raw.length - 12 - metaLen) };
}

let loaded: { key: string; p: Promise<Loaded> } | undefined;

async function load(env: NodeJS.ProcessEnv): Promise<Loaded> {
  const file = triageModelFile(env);
  const key = `${triageRuntimeDir(env)}|${file}`;
  if (loaded?.key === key) return loaded.p;
  const p = (async () => {
    const { meta, onnx } = parsePack(await readFile(file));
    const ort = importOrt(env);
    const session = await ort.InferenceSession.create(onnx, { executionProviders: ["cpu"], intraOpNumThreads: inferenceThreads(), graphOptimizationLevel: "all" });
    return { meta, tok: new BpeTokenizer(meta.tokenizer), ort, session };
  })();
  loaded = { key, p };
  p.catch(() => {
    if (loaded?.p === p) loaded = undefined; // a failed load is tried again on the next call
  });
  return p;
}

/** Drop the loaded model and free its memory (the report daemon has a memory ceiling). Never throws. */
export async function releaseTriageModel(): Promise<void> {
  const l = loaded;
  loaded = undefined;
  try {
    await (await l?.p)?.session.release?.();
  } catch {
    /* nothing to release */
  }
}

function softmax(logits: ArrayLike<number>, temperature: number): number[] {
  const z = Array.from(logits, (v) => v / temperature);
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface TriageProbs {
  readonly modelId: string;
  readonly probs: Readonly<Record<Head, number[]>>;
  readonly labels: Readonly<Record<Head, readonly string[]>>;
}

/** Calibrated probabilities of every head for the rendered state text. Throws on any problem. */
export async function scoreText(text: string, env: NodeJS.ProcessEnv): Promise<TriageProbs> {
  const m = await load(env);
  const ids = m.tok.encode(text, m.meta.maxLen);
  const feeds = {
    input_ids: new m.ort.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
    attention_mask: new m.ort.Tensor("int64", BigInt64Array.from(ids, () => 1n), [1, ids.length]),
  };
  const out = await m.session.run(feeds);
  const probs = {} as Record<Head, number[]>;
  for (const h of HEADS) {
    const t = out[`${h}_logits`];
    if (!t) throw new Error(`model output ${h}_logits is missing`);
    probs[h] = softmax(t.data, m.meta.temperature[h]);
  }
  return { modelId: m.meta.modelId, probs, labels: m.meta.labels };
}

/** Triage of one incident. Returns undefined when the model is missing, broken or slow: the caller alerts without it. */
export async function triageIncident(input: TriageInput, env: NodeJS.ProcessEnv = process.env): Promise<IncidentTriage | undefined> {
  try {
    const r = await scoreText(renderState(input), env);
    const pick = (h: Head): TriagePick => {
      const p = r.probs[h];
      const at = p.indexOf(Math.max(...p));
      return { id: r.labels[h][at]!, p: round3(p[at]!) };
    };
    const yes = r.labels.benign.indexOf("yes");
    return { model: r.modelId, category: pick("category"), urgency: pick("urgency"), action: pick("action"), benign: round3(r.probs.benign[yes]!) };
  } catch {
    return undefined;
  }
}
