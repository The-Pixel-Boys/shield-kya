/**
 * kya doctor - local checks. `--iocs` runs the IoC scan now and stores the result; without it the
 * last stored result is shown. Advisory: exit code is 0 whatever the findings.
 */
import { iocEnabled } from "../ioc/spawn.js";
import { iocLines } from "../ioc/format.js";
import { readIocResult } from "../ioc/result.js";
import { runIocScanAndStore } from "../ioc/scan.js";
import { optInHint } from "../otel/map-attrs-optin.js";

export async function runDoctor(
  log: (line: string) => void,
  opts: { readonly env: NodeJS.ProcessEnv; readonly iocs: boolean; readonly json: boolean; readonly cwd?: string; readonly warn?: (line: string) => void },
): Promise<number> {
  // OTLP map-attribute opt-in that a check refuses: one line on stderr, so stdout (and --json) stays the same.
  const hint = opts.warn ? optInHint(opts.cwd) : undefined;
  if (hint) opts.warn!(hint);
  const result = opts.iocs ? await runIocScanAndStore(opts.env) : readIocResult(opts.env);
  const enabled = iocEnabled(opts.env);
  if (opts.json) {
    log(JSON.stringify({ iocs: { enabled, ran: opts.iocs, result: result ?? null } }, null, 2));
  } else {
    for (const line of iocLines(result, enabled)) log(line);
  }
  return 0;
}
