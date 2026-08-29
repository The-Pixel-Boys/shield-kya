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

/**
 * Same binding as Java {@code FactoryArgsHash.workItemId}: UUID v3 of
 * {@code kya.factory:} + argsHash. Wrap must use this or invoke cannot find APPROVED.
 */
export function factoryWorkItemId(argsHash: string): string {
  const trimmed = argsHash.trim();
  if (!trimmed) {
    throw new Error("argsHash must not be blank");
  }
  const bytes = Buffer.from(
    createHash("md5").update("kya.factory:" + trimmed, "utf8").digest(),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x30;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
