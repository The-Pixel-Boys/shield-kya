import { createHash } from "node:crypto";

/** Canonical JSON: sorted keys, no insignificant whitespace (tool-wrap §1.2). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

/** argsHash = hex(sha256(canonical_json(args))) */
export function computeArgsHash(args: unknown): string {
  const payload = canonicalJson(args === undefined ? {} : args);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
