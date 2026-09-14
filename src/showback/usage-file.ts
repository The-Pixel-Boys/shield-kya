/**
 * Shared usage-file handling: 256KB cap and payload acceptance (bare array
 * or { "usage": [...] }) for .kya/usage.json-style files. Record parsing
 * itself lives in cost-per-task.ts; this module is the file-level seam used
 * by both the ORR --usage loader and the receipt showback card.
 */
import { parseUsageRecords, type UsageRecord } from "./cost-per-task.js";

export const MAX_USAGE_FILE_BYTES = 256 * 1024;

export { parseUsageRecords };

/** Accept either a bare usage array or { "usage": [...] }; throws otherwise. */
export function parseUsageFilePayload(raw: unknown): UsageRecord[] {
  return parseUsageRecords(
    Array.isArray(raw) ? raw : (raw as { usage?: unknown } | null)?.usage,
  );
}
