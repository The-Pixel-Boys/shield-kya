/**
 * Repository policy: `<project>/.kya/policy.json`, committed with the repo by `kya team init`.
 *
 * Tighten only. The file can add tool ids to `deny` or `requireApprove`. It can never relax a verdict:
 * the never-list and every DENY from the base tier stay DENY, and an unknown key (for example `allow`)
 * makes the whole file invalid. The file is supply-chain input, so every problem fails open: the file is
 * ignored and one stderr note says why. The gate then runs with its base rules, exactly as without the file.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const POLICY_FILE = join(".kya", "policy.json");
export const POLICY_VERSION = 1;
/** Policy files are small lists; a larger file is refused, not parsed. */
export const POLICY_MAX_BYTES = 64 * 1024;
const MAX_ENTRY_CHARS = 200;
const MAX_ENTRIES = 1000;
const KEYS = new Set(["version", "deny", "requireApprove"]);

export interface ProjectPolicy {
  readonly deny: ReadonlySet<string>;
  readonly requireApprove: ReadonlySet<string>;
}

/** The scaffold `kya team init` writes when the file is absent. No rules yet, so it changes no verdict. */
export const POLICY_SCAFFOLD = `${JSON.stringify({ version: POLICY_VERSION, deny: [], requireApprove: [] }, null, 2)}\n`;

type Warn = (message: string) => void;
const stderrWarn: Warn = (m) => {
  process.stderr.write(`kya: ignoring ${POLICY_FILE}: ${m}\n`);
};

/** Parse and validate a policy document. Returns undefined when any rule is broken. */
export function parseProjectPolicy(text: string): { policy?: ProjectPolicy; error?: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON (${(err as Error).message})` };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { error: "top level must be an object" };
  const obj = doc as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KEYS.has(key)) return { error: `unknown key "${key}" (only version, deny, requireApprove are read)` };
  }
  if (obj.version !== POLICY_VERSION) return { error: `version must be ${POLICY_VERSION}` };
  const list = (name: "deny" | "requireApprove"): Set<string> | string => {
    const raw = obj[name] ?? [];
    if (!Array.isArray(raw)) return `${name} must be an array`;
    if (raw.length > MAX_ENTRIES) return `${name} has more than ${MAX_ENTRIES} entries`;
    const out = new Set<string>();
    for (const item of raw) {
      if (typeof item !== "string") return `${name} entries must be strings`;
      const id = item.trim();
      if (id === "" || id.length > MAX_ENTRY_CHARS) return `${name} entries must be 1 to ${MAX_ENTRY_CHARS} characters`;
      out.add(id);
    }
    return out;
  };
  const deny = list("deny");
  if (typeof deny === "string") return { error: deny };
  const requireApprove = list("requireApprove");
  if (typeof requireApprove === "string") return { error: requireApprove };
  return { policy: { deny, requireApprove } };
}

/**
 * Load `<cwd>/.kya/policy.json`. Missing file: undefined, silently. Symlink, non-regular file, oversize,
 * or invalid content: undefined plus one warning (fail open). Never throws.
 */
export function loadProjectPolicy(cwd: string, warn: Warn = stderrWarn): ProjectPolicy | undefined {
  const path = join(cwd, POLICY_FILE);
  try {
    const link = lstatSync(path, { throwIfNoEntry: false });
    if (!link) return undefined;
    if (link.isSymbolicLink()) return failOpen(warn, "it is a symlink");
    if (!link.isFile()) return failOpen(warn, "it is not a regular file");
    if (statSync(path).size > POLICY_MAX_BYTES) return failOpen(warn, `it is larger than ${POLICY_MAX_BYTES} bytes`);
    const parsed = parseProjectPolicy(readFileSync(path, "utf8"));
    if (!parsed.policy) return failOpen(warn, parsed.error ?? "invalid");
    return parsed.policy;
  } catch (err) {
    return failOpen(warn, `unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

function failOpen(warn: Warn, why: string): undefined {
  warn(`${why}; the base rules apply`);
  return undefined;
}
