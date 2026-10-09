/**
 * kya import - convert foreign trace exports (LangSmith, Langfuse, Phoenix,
 * OTel JSON) into local trail events so the receipt/certify sees them.
 */
import type { ParsedArgs } from "../parse-args.js";
import { flagString } from "../parse-args.js";
import {
  importTraces,
  renderImportSummary,
  type ImportSource,
} from "../importers/index.js";

const SOURCES: readonly ImportSource[] = ["langsmith", "langfuse", "phoenix", "otel"];

export interface ImportCliOptions {
  readonly from: ImportSource | undefined;
  readonly file: string | undefined;
}

export function importOptionsFromArgs(parsed: ParsedArgs): ImportCliOptions {
  const rawFrom = flagString(parsed.flags, "from")?.toLowerCase();
  const from = SOURCES.find((s) => s === rawFrom);
  return { from, file: parsed.positionals[0] };
}

export async function runImport(
  opts: ImportCliOptions,
  io: { log: (s: string) => void; error: (s: string) => void },
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  if (!opts.from || !opts.file) {
    io.error("Usage: kya import --from <langsmith|langfuse|phoenix|otel> <file>");
    return 2;
  }
  const result = await importTraces({ from: opts.from, file: opts.file, cwd, env });
  io.log(renderImportSummary(result));
  return result.imported === 0 && result.errors.length > 0 ? 1 : 0;
}
