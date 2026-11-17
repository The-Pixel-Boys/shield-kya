/**
 * PEM private-key block finder. Linear time: the one-regex form
 * `BEGIN ... [\s\S]*? END ...` rescans the rest of the text from every BEGIN
 * header and is quadratic on a long run of headers with no END footer.
 * Here each header and footer search moves forward only, and the scan stops
 * at the first header that has no footer after it (no later header can have one).
 */

/**
 * Header and footer patterns. Pass global (`g`) regexes; `lastIndex` is reset on every call.
 * The shared regex objects carry `lastIndex` state, so the helpers are synchronous and must not be re-entered.
 */
export interface PemPatterns {
  readonly head: RegExp;
  readonly tail: RegExp;
}

/** Case-insensitive, digits allowed in the key label (diff preview, trail text). */
export const PEM_ANY_CASE: PemPatterns = {
  head: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gi,
  tail: /-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
};

/** Case-sensitive, letters and spaces only (AgentShield evidence). */
export const PEM_UPPER: PemPatterns = {
  head: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  tail: /-----END [A-Z ]*PRIVATE KEY-----/g,
};

/** Next complete block at or after `from`, as [start, end), or undefined. */
function nextBlock(s: string, from: number, p: PemPatterns): [number, number] | undefined {
  p.head.lastIndex = from;
  const h = p.head.exec(s);
  if (!h) return undefined;
  p.tail.lastIndex = h.index + h[0].length;
  const t = p.tail.exec(s);
  if (!t) return undefined;
  return [h.index, t.index + t[0].length];
}

export function hasPemBlock(s: string, p: PemPatterns = PEM_ANY_CASE): boolean {
  return nextBlock(s, 0, p) !== undefined;
}

export function replacePemBlocks(s: string, replacement: string, p: PemPatterns = PEM_ANY_CASE): string {
  let out = "";
  let pos = 0;
  for (let b = nextBlock(s, 0, p); b; b = nextBlock(s, pos, p)) {
    out += s.slice(pos, b[0]) + replacement;
    pos = b[1];
  }
  return pos === 0 ? s : out + s.slice(pos);
}
