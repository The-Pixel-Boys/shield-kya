/**
 * `kya export --format agent-flow`: the local trail as an agent-flow JSONL event log. Local only. Never changes a verdict.
 * Each line is `{"time": <s since the first row>, "type": ..., "payload": {...}}`. The payload holds only a hashed session,
 * the tool id, the verdict, the reason code, the target class, the device id and the mode. No args, hashes or paths.
 */
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { installSalt } from "../device-id.js";
import { UsageError } from "../errors.js";
import { writeFileSync } from "node:fs";
import { ensureOutDir, projectWritePath, underRoot, writeOutFile } from "../fs-atomic.js";
import { flagBool, flagString, type ParsedArgs } from "../parse-args.js";
import { sessionHash, targetOf } from "../map/build.js";
import { loadTrailEvents } from "../map/load.js";
import { scanMapOutput } from "../map/page.js";
import type { TrailEventLike } from "../map/types.js";
import { trailPath } from "../trail.js";
import { daysFromArgs } from "./map.js";

export const EXPORT_FORMATS = ["agent-flow"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly days: number;
  readonly session?: string;
  readonly out?: string;
  /** Replace an existing --out file. */
  readonly force: boolean;
}

export function exportOptionsFromArgs(parsed: ParsedArgs): ExportOptions {
  const format = parsed.flags["format"];
  if (typeof format !== "string" || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new UsageError(`--format must be one of: ${EXPORT_FORMATS.join(", ")} (for example --format agent-flow)`);
  }
  const days = daysFromArgs(parsed);
  if (parsed.flags["session"] === true) throw new UsageError("--session needs a session id");
  if (parsed.flags["out"] === true) throw new UsageError("--out needs a file path, for example --out flow.jsonl");
  return {
    format: format as ExportFormat,
    days,
    session: flagString(parsed.flags, "session"),
    out: flagString(parsed.flags, "out"),
    force: flagBool(parsed.flags, "force"),
  };
}

export interface AgentFlowEvent {
  time: number;
  type: "agent_spawn" | "tool_call_start" | "tool_call_end";
  payload: Record<string, string>;
}

const DEVICE_ID = /^[0-9a-f]{16}$/;
/** A third-party MCP tool name can be any length. A longer one is replaced by its hash: a cut could keep a secret-shaped prefix. */
export const TOOL_MAX = 200;

export function toolLabel(toolId: string): string {
  return toolId.length <= TOOL_MAX ? toolId : `tool:${createHash("sha256").update(toolId, "utf8").digest("hex").slice(0, 16)}`;
}

/** JSON.stringify keeps U+2028 and U+2029 raw. Readers that split lines on them (readline) would break the line. */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Pure mapper. Rows are ordered by time, then by file order, so the same trail gives the same bytes.
 * One `agent_spawn` per session at its first row, then a start and an end event per row at the same time.
 */
export function toAgentFlow(events: readonly TrailEventLike[], salt: string): AgentFlowEvent[] {
  const rows = events
    .map((e, i) => ({ e, i, ms: Date.parse(e.ts) }))
    .filter((r) => Number.isFinite(r.ms))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  if (rows.length === 0) return [];
  const t0 = rows[0]!.ms;
  const seen = new Set<string>();
  const out: AgentFlowEvent[] = [];
  for (const { e, ms } of rows) {
    const time = (ms - t0) / 1000;
    const agent = sessionHash(salt, e.product ?? "unknown", e.sessionId);
    const device: Record<string, string> = typeof e.deviceId === "string" && DEVICE_ID.test(e.deviceId) ? { deviceId: e.deviceId } : {};
    if (!seen.has(agent)) {
      seen.add(agent);
      out.push({ time, type: "agent_spawn", payload: { name: agent, sessionId: agent, ...device } });
    }
    const call = {
      agent,
      sessionId: agent,
      tool: toolLabel(e.toolId),
      verdict: e.verdict,
      reasonCode: e.reasonCode,
      targetClass: targetOf(e).cls,
      mode: e.mode,
      ...device,
    };
    out.push({ time, type: "tool_call_start", payload: call });
    out.push({ time, type: "tool_call_end", payload: call });
  }
  return out;
}


export async function runExport(
  opts: ExportOptions,
  io: { log: (line: string) => void; error: (line: string) => void },
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const salt = installSalt(env) ?? randomBytes(16).toString("hex");
  const { events } = await loadTrailEvents({ path: trailPath(cwd, env), days: opts.days, now: new Date(), session: opts.session });
  const lines = toAgentFlow(events, salt).map(jsonLine);
  if (lines.length === 0) {
    io.error(`No events in the last ${opts.days} days. Nothing to export.`);
    return 0;
  }
  const body = `${lines.join("\n")}\n`;
  scanMapOutput(body);
  if (opts.out === undefined) {
    io.log(body.trimEnd());
    return 0;
  }
  const target = resolve(cwd, opts.out);
  // The project root already exists. ensureOutDir would check the root's parent and refuse it.
  if (resolve(dirname(target)) !== resolve(cwd)) ensureOutDir(dirname(target), cwd);
  if (opts.force) {
    // Atomic replace, owner read and write only, also when the old file was wider. A link at the target is replaced, not followed.
    writeOutFile(target, body, cwd, 0o600);
  } else {
    // Exclusive create: no window between a check and the write, and an existing file or symlink is never replaced.
    const dest = underRoot(target, cwd) ? projectWritePath(target, cwd) : target;
    try {
      writeFileSync(dest, body, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new UsageError(`${target} exists. Pass --force to replace it.`);
      throw err;
    }
  }
  io.error(`${lines.length} lines written to ${target}`);
  return 0;
}
