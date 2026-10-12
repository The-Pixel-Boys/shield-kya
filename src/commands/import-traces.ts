/**
 * kya import - convert foreign trace exports (LangSmith, Langfuse, Phoenix,
 * OTel JSON, the AGT audit log) into local trail events so the receipt/certify sees them.
 */
import type { ParsedArgs } from "../parse-args.js";
import { flagString } from "../parse-args.js";
import {
  defaultAgtAuditPath,
  importTraces,
  renderImportSummary,
  type ImportSource,
} from "../importers/index.js";

const SOURCES: readonly ImportSource[] = ["langsmith", "langfuse", "phoenix", "otel", "agt", "adr-sensor"];

export interface ImportCliOptions {
  readonly from: ImportSource | undefined;
  readonly file: string | undefined;
}

export function importOptionsFromArgs(parsed: ParsedArgs): ImportCliOptions {
  const rawFrom = flagString(parsed.flags, "from")?.toLowerCase();
  const from = SOURCES.find((s) => s === rawFrom);
  return { from, file: flagString(parsed.flags, "file") ?? parsed.positionals[0] };
}

export async function runImport(
  opts: ImportCliOptions,
  io: { log: (s: string) => void; error: (s: string) => void },
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  // agt reads AGT's own audit log, so --file is optional there.
  const file = opts.file ?? (opts.from === "agt" ? defaultAgtAuditPath(env) : undefined);
  if (!opts.from || !file) {
    io.error("Usage: kya import --from <langsmith|langfuse|phoenix|otel|agt|adr-sensor> <file> | --file <path>");
    return 2;
  }
  const result = await importTraces({ from: opts.from, file, cwd, env });
  io.log(renderImportSummary(result));
  for (const w of result.warnings ?? []) io.error(`warning: ${w}`);
  return result.imported === 0 && result.errors.length > 0 ? 1 : 0;
}
