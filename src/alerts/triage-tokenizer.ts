/**
 * Byte-level BPE tokenizer for ModernBERT (GPT-2 style): NFC, split on added tokens, GPT-2 pre-tokenizer
 * regex, byte-to-unicode, BPE merges by rank, then [CLS] ... [SEP]. The vocabulary and merges ship in the
 * model file, so no npm package is needed. Parity with the Hugging Face
 * tokenizer is pinned by test/fixtures/alerts/triage-model-golden.json (token ids of fixed cases).
 */
export interface TokenizerMeta {
  readonly vocab: Readonly<Record<string, number>>;
  readonly merges: readonly string[];
  /** [content, id] of every added token (special tokens and runs of spaces). */
  readonly added: ReadonlyArray<readonly [string, number]>;
  readonly cls: number;
  readonly sep: number;
}

const PRETOKEN = /'(?:s|t|re|ve|m|ll|d)| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** GPT-2 byte to printable unicode map. */
function byteMap(): string[] {
  const keep: number[] = [];
  for (let b = 33; b <= 126; b++) keep.push(b);
  for (let b = 161; b <= 172; b++) keep.push(b);
  for (let b = 174; b <= 255; b++) keep.push(b);
  const map: string[] = new Array<string>(256);
  let extra = 0;
  for (let b = 0; b < 256; b++) map[b] = String.fromCodePoint(keep.includes(b) ? b : 256 + extra++);
  return map;
}
/** Byte value to its printable character (the GPT-2 map). Exported for tests. */
export const BYTE_TO_UNICODE = byteMap();
const BYTES = BYTE_TO_UNICODE;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class BpeTokenizer {
  private readonly ranks = new Map<string, number>();
  private readonly cache = new Map<string, number[]>();
  private readonly addedRe: RegExp | undefined;
  private readonly addedIds = new Map<string, number>();

  constructor(private readonly meta: TokenizerMeta) {
    meta.merges.forEach((m, i) => this.ranks.set(m, i));
    for (const [content, id] of meta.added) this.addedIds.set(content, id);
    const parts = [...this.addedIds.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    this.addedRe = parts.length > 0 ? new RegExp(parts.join("|"), "g") : undefined;
  }

  private bpe(word: string): number[] {
    const hit = this.cache.get(word);
    if (hit) return hit;
    let parts = Array.from(word);
    while (parts.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      parts = [...parts.slice(0, best), parts[best]! + parts[best + 1]!, ...parts.slice(best + 2)];
    }
    const ids = parts.map((p) => this.meta.vocab[p]).filter((v): v is number => v !== undefined);
    this.cache.set(word, ids);
    return ids;
  }

  private plain(chunk: string): number[] {
    const ids: number[] = [];
    for (const m of chunk.matchAll(PRETOKEN)) {
      const mapped = Array.from(Buffer.from(m[0], "utf8"), (b) => BYTES[b]!).join("");
      ids.push(...this.bpe(mapped));
    }
    return ids;
  }

  /** Token ids with [CLS] and [SEP], cut so that the whole sequence has at most `maxLen` ids. */
  encode(text: string, maxLen: number): number[] {
    const norm = text.normalize("NFC");
    const ids: number[] = [];
    let last = 0;
    if (this.addedRe) {
      for (const m of norm.matchAll(this.addedRe)) {
        ids.push(...this.plain(norm.slice(last, m.index)));
        ids.push(this.addedIds.get(m[0])!);
        last = m.index + m[0].length;
      }
    }
    ids.push(...this.plain(norm.slice(last)));
    return [this.meta.cls, ...ids.slice(0, Math.max(0, maxLen - 2)), this.meta.sep];
  }
}
