/**
 * Operator attestations — the explicit escape hatch for requirements a machine
 * cannot check. Local file only (<cwd>/.kya/attestations.json); never uploaded,
 * never a PEP. Latest attestation per requirement id wins.
 */
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.js";
import { assertNoSecrets, stripEscapes } from "../dash/render.js";
import { UsageError } from "../errors.js";
import { atomicWriteSync } from "../fs-atomic.js";

export interface AttestationRecord {
  readonly requirementId: string;
  readonly text: string;
  readonly at: string;
}

const MAX_ATTESTATIONS_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 2000;
const REQ_ID = /^[A-Z]+-\d+$/;
// Attestation text and timestamps are interpolated into single-line evidence
// strings, reports, and signed bundles — same rule as catalog attest prompts.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function attestationsPath(cwd: string): string {
  return join(configDir(cwd), "attestations.json");
}

/** Latest attestation per requirement id wins. Corrupt/oversize file → empty map. */
export function loadAttestations(cwd: string): Map<string, AttestationRecord> {
  const map = new Map<string, AttestationRecord>();
  try {
    const path = attestationsPath(cwd);
    const st = statSync(path); // ENOENT/EACCES land in catch → empty map
    if (!st.isFile() || st.size > MAX_ATTESTATIONS_BYTES) return map;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
    const list = (raw as Record<string, unknown>).attestations;
    if (!Array.isArray(list)) return map;
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const r = item as Record<string, unknown>;
      if (
        typeof r.requirementId !== "string" ||
        typeof r.text !== "string" ||
        typeof r.at !== "string"
      ) {
        continue;
      }
      // The store file is operator-editable; refuse entries that would break
      // the single-line evidence contract downstream, and apply the same
      // bidi/zero-width sanitization record applies so hand-edited entries
      // cannot smuggle display spoofing into evidence.
      if (CONTROL_CHARS.test(r.text) || CONTROL_CHARS.test(r.at)) continue;
      const text = stripEscapes(r.text).trim();
      if (text.length === 0) continue;
      map.set(r.requirementId, {
        requirementId: r.requirementId,
        text,
        at: stripEscapes(r.at),
      });
    }
  } catch {
    return new Map();
  }
  return map;
}

export function recordAttestation(
  cwd: string,
  requirementId: string,
  text: string,
): AttestationRecord {
  const id = requirementId.trim();
  if (!REQ_ID.test(id)) {
    throw new UsageError(`--attest id must look like DP-01, got ${JSON.stringify(requirementId)}`);
  }
  if (CONTROL_CHARS.test(text)) {
    throw new UsageError("--text must not contain control characters");
  }
  const clean = stripEscapes(text).trim();
  if (clean.length === 0) throw new UsageError("--text must not be empty");
  if (clean.length > MAX_TEXT_CHARS) {
    throw new UsageError(`--text exceeds ${MAX_TEXT_CHARS} chars`);
  }
  try {
    assertNoSecrets(clean);
  } catch {
    throw new UsageError(
      "--text looks like it contains a secret — attestations describe policy, never credentials",
    );
  }
  const record: AttestationRecord = {
    requirementId: id,
    text: clean,
    at: new Date().toISOString(),
  };
  const others = [...loadAttestations(cwd).values()].filter(
    (r) => r.requirementId !== id,
  );
  const store = { version: 1, attestations: [...others, record] };
  mkdirSync(configDir(cwd), { recursive: true, mode: 0o700 });
  // Atomic tmp+rename: a crash or concurrent run must never truncate the
  // store — the fail-safe load would silently discard all attestation history.
  const path = attestationsPath(cwd);
  atomicWriteSync(path, `${JSON.stringify(store, null, 2)}\n`);
  try {
    chmodSync(path, 0o600); // operator statements are sensitive — evidence-bundle perms
  } catch {
    /* best-effort on non-POSIX */
  }
  return record;
}
