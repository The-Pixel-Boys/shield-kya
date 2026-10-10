/**
 * kya investigate - deterministic detectors over the local trail: incident
 * grouping plus markdown fix briefs shaped for coding agents. No LLM calls.
 */
import type { ParsedArgs } from "../parse-args.js";
import { flagBool } from "../parse-args.js";
import { readTrail } from "../trail.js";
import {
  investigateTrail,
  renderInvestigateReport,
} from "../investigate/index.js";
import {
  buildInvestigateLastRun,
  writeInvestigateLastRun,
} from "../investigate/last-run.js";

export interface InvestigateCliOptions {
  readonly json: boolean;
}

export function investigateOptionsFromArgs(parsed: ParsedArgs): InvestigateCliOptions {
  return { json: flagBool(parsed.flags, "json") };
}

export async function runInvestigate(
  opts: InvestigateCliOptions,
  io: { log: (s: string) => void },
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const events = readTrail(cwd, env);
  const result = investigateTrail(events);
  // Persist a compact summary for the report's Investigations section;
  // best-effort, a failed write never changes the command outcome.
  writeInvestigateLastRun(buildInvestigateLastRun(result, events), env);
  if (opts.json) {
    io.log(
      JSON.stringify(
        {
          findings: result.findings,
          incidents: result.incidents,
          briefs: Object.fromEntries(result.briefs),
        },
        null,
        2,
      ),
    );
  } else {
    io.log(renderInvestigateReport(result));
  }
  return 0;
}
