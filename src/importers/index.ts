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
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { appendTrail } from "../trail.js";
import { importAgt } from "./agt.js";
import {
  extractRecords,
  mapRecord,
  type ImportSource,
} from "./formats.js";

export type { ImportSource } from "./formats.js";
export { defaultAgtAuditPath, verifyAgtChain } from "./agt.js";

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
  /** Non-fatal findings (agt: broken hash chain). Absent for the trace importers. */
  readonly warnings?: string[];
  /** Records skipped because the trail already holds them (agt re-import). Included in `skipped`. */
  readonly duplicates?: number;
}

/** Import files larger than 50MB are refused before reading. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Size guard, exported for tests: returns an error message when over the cap. */
export function checkImportSize(sizeBytes: number): string | undefined {
  if (sizeBytes <= MAX_IMPORT_BYTES) return undefined;
  return `file is ${sizeBytes} bytes, over the ${MAX_IMPORT_BYTES} byte (50MB) import cap`;
}

/** The documented stdin spellings: pipes are allowed there, read with the size cap enforced on bytes read. */
const STDIN_PATHS = new Set(["/dev/stdin", "/proc/self/fd/0"]);

/**
 * Read an import file as text. Explicit paths must be regular files (a FIFO or
 * device reports size 0 and could block or stream forever); stdin spellings are
 * the exception and are read in chunks, failing as soon as the cap is exceeded.
 */
export function readImportText(
  file: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  try {
    if (STDIN_PATHS.has(file)) {
      const fd = openSync(file, "r");
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        const buf = Buffer.alloc(64 * 1024);
        for (;;) {
          let n: number;
          try {
            n = readSync(fd, buf, 0, buf.length, null);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "EOF") break;
            if (code !== "EAGAIN") throw e;
            // Non-blocking stdin with no data yet: wait 10ms and retry.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            continue;
          }
          if (n === 0) break;
          total += n;
          const over = checkImportSize(total);
          if (over) return { ok: false, error: over };
          chunks.push(Buffer.from(buf.subarray(0, n)));
        }
        return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
      } finally {
        closeSync(fd);
      }
    }
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, error: `${file} is not a regular file` };
    const over = checkImportSize(st.size);
    if (over) return { ok: false, error: over };
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch (e) {
    return { ok: false, error: `cannot read ${file} - ${errMsg(e)}` };
  }
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

  const read = readImportText(file);
  if (!read.ok) return { imported, skipped, errors: [read.error] };
  const text = read.text;
  if (from === "agt") return importAgt({ file, text, cwd, env });

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
  if (result.duplicates) lines.push(`already imported: ${result.duplicates} record(s)`);
  if (result.errors.length > 0) {
    const first = result.errors[0]!;
    const clipped = first.length > 120 ? `${first.slice(0, 119)}…` : first;
    lines.push(`errors: ${result.errors.length} (first: ${clipped})`);
  }
  return lines.join("\n");
}
