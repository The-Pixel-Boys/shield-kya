/**
 * Trace importer: reads a foreign trace export (LangSmith, Langfuse, Phoenix,
 * OTLP/JSON) and appends each span/run to the local KYA trail via appendTrail.
 *
 * JSON vs JSONL is detected by content: a whole-file JSON.parse that succeeds
 * wins; otherwise the file is processed line by line. The file is capped at
 * MAX_IMPORT_BYTES (50MB) - an oversized file returns an error entry instead
 * of reading. Bad records never throw: they are skipped and collected in
 * `errors`, and the import continues.
 */
import { readFileSync, statSync } from "node:fs";
import { appendTrail } from "../trail.js";
import {
  extractRecords,
  mapRecord,
  type ImportSource,
} from "./formats.js";

export type { ImportSource } from "./formats.js";

export interface ImportOptions {
  readonly from: ImportSource;
  readonly file: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly errors: string[];
}

/** Import files larger than 50MB are refused before reading. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Size guard, exported for tests: returns an error message when over the cap. */
export function checkImportSize(sizeBytes: number): string | undefined {
  if (sizeBytes <= MAX_IMPORT_BYTES) return undefined;
  return `file is ${sizeBytes} bytes, over the ${MAX_IMPORT_BYTES} byte (50MB) import cap`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Split a JSONL body into records; bad lines become errors + skips. */
function jsonlRecords(
  text: string,
  errors: string[],
): { records: unknown[]; skipped: number } {
  const records: unknown[] = [];
  let skipped = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      skipped++;
      errors.push(`line ${i + 1}: invalid JSON - ${errMsg(e)}`);
    }
  }
  return { records, skipped };
}

/**
 * Import one export file into the trail. Returns counts plus per-record
 * errors; resolves even when the file is missing, oversized, or every
 * record is bad.
 */
export async function importTraces(opts: ImportOptions): Promise<ImportResult> {
  const { from, file, cwd } = opts;
  const env = opts.env ?? process.env;
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;

  let size: number;
  try {
    size = statSync(file).size;
  } catch (e) {
    return { imported, skipped, errors: [`cannot read ${file} - ${errMsg(e)}`] };
  }
  const sizeError = checkImportSize(size);
  if (sizeError) return { imported, skipped, errors: [sizeError] };

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { imported, skipped, errors: [`cannot read ${file} - ${errMsg(e)}`] };
  }

  let records: unknown[];
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      records = extractRecords(from, JSON.parse(trimmed));
    } catch {
      // Not one JSON document - fall back to JSONL line by line.
      const parsed = jsonlRecords(text, errors);
      records = parsed.records;
      skipped += parsed.skipped;
    }
  } else {
    const parsed = jsonlRecords(text, errors);
    records = parsed.records;
    skipped += parsed.skipped;
  }

  const fallbackSession = `import-${from}-${new Date().toISOString().slice(0, 10)}`;

  for (let i = 0; i < records.length; i++) {
    const mapped = mapRecord(from, records[i], fallbackSession);
    if (!mapped.ok) {
      skipped++;
      errors.push(`record ${i + 1}: ${mapped.error}`);
      continue;
    }
    try {
      appendTrail(cwd, mapped.event, env);
      imported++;
    } catch (e) {
      skipped++;
      errors.push(`record ${i + 1}: trail append failed - ${errMsg(e)}`);
    }
  }

  return { imported, skipped, errors };
}

/** Two or three plain-text lines for the CLI to print after an import. */
export function renderImportSummary(result: ImportResult): string {
  const lines = [
    `imported ${result.imported} trace record(s) into the KYA trail`,
    `skipped ${result.skipped} record(s)`,
  ];
  if (result.errors.length > 0) {
    const first = result.errors[0]!;
    const clipped = first.length > 120 ? `${first.slice(0, 119)}…` : first;
    lines.push(`errors: ${result.errors.length} (first: ${clipped})`);
  }
  return lines.join("\n");
}
