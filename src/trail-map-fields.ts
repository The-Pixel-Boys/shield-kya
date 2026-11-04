/**
 * Map fields for one trail row: `deviceId` (this install) and `targetClass` (class of the tool target).
 * Never throws. A failure leaves the row without the field; the hook verdict and exit code never change.
 */
import { homedir } from "node:os";
import { basename } from "node:path";
import { deviceId } from "./device-id.js";
import { classifyTarget } from "./map/target-class.js";
import { deriveTargetPath, deriveTrailSummary } from "./trail-summary.js";

export interface TrailMapFields {
  readonly deviceId?: string;
  readonly targetClass?: string;
}

/** The class needs only the first token and the first path. A longer string is cut, so a hostile 1 MB command costs nothing here. */
const CLASS_INPUT_MAX = 2048;
const CLASS_MAX = 128;

function clipStrings(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return typeof args === "string" ? args.slice(0, CLASS_INPUT_MAX) : args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = typeof v === "string" && v.length > CLASS_INPUT_MAX ? v.slice(0, CLASS_INPUT_MAX) : v;
  return out;
}

/**
 * Call this on the RAW tool args, before any change-field strip: a never deny or a secret read still gets a class.
 * Only the class leaves this function, never the path, URL path, argument or command line.
 */
export function trailMapFields(toolId: string, args: unknown, cwd: string, env: NodeJS.ProcessEnv): TrailMapFields {
  const out: { deviceId?: string; targetClass?: string } = {};
  try {
    const id = deviceId(env);
    if (id) out.deviceId = id;
  } catch {
    /* row without deviceId */
  }
  try {
    const bounded = clipStrings(args);
    const { class: cls } = classifyTarget({
      toolId,
      targetPath: deriveTargetPath(bounded),
      summary: deriveTrailSummary(toolId, bounded),
      project: basename(cwd),
      cwd,
      home: homedir(),
    });
    if (cls && cls.length <= CLASS_MAX) out.targetClass = cls;
  } catch {
    /* row without targetClass */
  }
  return out;
}
