import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { installSalt } from "../device-id.js";
import { UsageError } from "../errors.js";
import { ensureOutDir, writeOutFile } from "../fs-atomic.js";
import { flagBool, flagString, type ParsedArgs } from "../parse-args.js";
import { loadMap } from "../map/load.js";
import { ADVISORY_LINE, renderMapPage, scanMapOutput } from "../map/page.js";
import { receiptsDir, trailPath } from "../trail.js";

export const DEFAULT_MAP_DAYS = 3;

export interface MapOptions {
  readonly days: number;
  readonly json: boolean;
  readonly html?: string;
  readonly session?: string;
}

/** Flag parsing for `kya map`. A bad value is a usage error (exit 2), never a silent default. */
/** `--days` for `kya map` and `kya export`. A bad value is a usage error (exit 2). */
export function daysFromArgs(parsed: ParsedArgs): number {
  const raw = parsed.flags["days"];
  if (raw === undefined) return DEFAULT_MAP_DAYS;
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw new UsageError("--days must be a positive whole number of days, for example --days 3");
  }
  return Number(raw);
}

export function mapOptionsFromArgs(parsed: ParsedArgs): MapOptions {
  const days = daysFromArgs(parsed);
  if (parsed.flags["html"] === true) throw new UsageError("--html needs a file path, for example --html map.html");
  if (parsed.flags["session"] === true) throw new UsageError("--session needs a session id");
  return {
    days,
    json: flagBool(parsed.flags, "json"),
    html: flagString(parsed.flags, "html"),
    session: flagString(parsed.flags, "session"),
  };
}

/**
 * `kya map`: one graph and two heat views from the local trail. Local only. Never changes a verdict.
 * With neither --json nor --html the page goes to .kya/receipts/map-<days>d.html, as `kya receipt` does.
 */
export async function runMap(
  opts: MapOptions,
  io: { log: (line: string) => void; error: (line: string) => void },
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const now = new Date();
  const salt = installSalt(env) ?? randomBytes(16).toString("hex");
  const loaded = await loadMap({
    path: trailPath(cwd, env),
    days: opts.days,
    now,
    salt,
    session: opts.session,
    tzOffsetMinutes: -now.getTimezoneOffset(),
  });
  const { graph, heat, windowEvents } = loaded;
  const empty = windowEvents === 0;
  const emptyLine = `No events in the last ${opts.days} days.`;

  if (opts.json) {
    const body = `${JSON.stringify({ ...graph, heat }, null, 2)}\n`;
    scanMapOutput(body);
    io.log(body.trimEnd());
    if (empty) io.error(emptyLine);
  }

  if (opts.html !== undefined || !opts.json) {
    const page = renderMapPage({ graph, heat, days: opts.days, title: "KYA map" });
    scanMapOutput(page);
    const target = opts.html !== undefined ? resolve(cwd, opts.html) : join(receiptsDir(cwd), `map-${opts.days}d.html`);
    // The project root already exists. ensureOutDir would check the root's parent and refuse it.
    if (resolve(dirname(target)) !== resolve(cwd)) ensureOutDir(dirname(target), cwd);
    writeOutFile(target, page, cwd);
    if (!opts.json) {
      io.log(empty ? emptyLine : `${windowEvents} events in the last ${opts.days} days.`);
      io.log(`html: ${target}`);
      io.log(ADVISORY_LINE);
    }
  }
  return 0;
}
