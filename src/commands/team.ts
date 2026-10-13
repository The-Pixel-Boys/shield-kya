/**
 * `kya team init` / `kya team managed-settings`: spread the Claude Code plugin to a team.
 *
 * init merges two keys into the CURRENT PROJECT's `.claude/settings.json` (never the user's):
 *   extraKnownMarketplaces["shield-kya"] = github The-Pixel-Boys/shield-kya at ref v<version>
 *   enabledPlugins["kya@shield-kya"] = true
 * Every other key is kept. No network, no permissions, nothing auto-accepted: Claude Code still
 * shows each teammate its folder trust prompt. managed-settings prints the same two keys as an
 * admin policy document. Schema: code.claude.com/docs/en/plugins/org and
 * /docs/en/plugins/marketplace-reference (marketplace `github` source: repo, ref, path; no sha).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { KyaError } from "../errors.js";
import { atomicWriteSync } from "../fs-atomic.js";
import { CLI_VERSION } from "../version.js";

export const MARKETPLACE = "shield-kya";
export const PLUGIN_ID = "kya@shield-kya";
export const PUBLIC_REPO = "The-Pixel-Boys/shield-kya";

/** Public repo release tags are `v<version>` (the `kya-v*` tags live only in the private monorepo). */
export function releaseRef(version: string = CLI_VERSION): string {
  return `v${version}`;
}

export function marketplaceSource(version: string = CLI_VERSION) {
  return { source: "github", repo: PUBLIC_REPO, ref: releaseRef(version) };
}

/** The managed-settings document an admin deploys. Same pin as `team init`. */
export function managedSettings(version: string = CLI_VERSION): Record<string, unknown> {
  return {
    extraKnownMarketplaces: { [MARKETPLACE]: { source: marketplaceSource(version) } },
    enabledPlugins: { [PLUGIN_ID]: true },
  };
}

export interface TeamInitResult {
  readonly path: string;
  readonly written: boolean;
  readonly dryRun: boolean;
  /** Human-readable change lines, empty when the file already matches. */
  readonly changes: readonly string[];
  readonly content: string;
  readonly ref: string;
  /** The existing file was not in canonical JSON.stringify layout, so unrelated lines are re-laid out. */
  readonly reformatted: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (msg: string) => new KyaError(msg, "TEAM_REFUSED", 1);

function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** Refuse anything that would land outside the project: symlinks, or the user-level Claude dir. */
function guardPaths(cwd: string, env: NodeJS.ProcessEnv): { dir: string; file: string } {
  const root = real(cwd);
  if (!root) throw refuse(`project directory not found: ${cwd}`);
  const dir = join(root, ".claude");
  const file = join(dir, "settings.json");
  // Resolve even when the user dir does not exist yet (HOME behind a symlink, fresh machine).
  const loose = (p: string) => real(p) ?? join(real(dirname(p)) ?? dirname(p), basename(p));
  const userDirs = [join(homedir(), ".claude"), env.CLAUDE_CONFIG_DIR].filter((p): p is string => !!p).map(loose);
  if (userDirs.includes(dir)) {
    throw refuse(`${dir} is your user-level Claude Code directory; run kya team init inside a project`);
  }
  for (const [p, kind] of [[dir, "directory"], [file, "file"]] as const) {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) throw refuse(`${p} is a symlink; refusing to write through it`);
    if (kind === "directory" ? !st.isDirectory() : !st.isFile()) throw refuse(`${p} is not a regular ${kind}`);
  }
  return { dir, file };
}

function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1]! : 2;
}

/** True when tag `a` (vX.Y.Z) is a strictly newer release than `b`; non-semver refs compare as not newer. */
function newerThan(a: string, b: string): boolean {
  const parse = (t: string) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t)?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  const d = x.map((n, i) => n - y[i]!).find((n) => n !== 0);
  return d !== undefined && d > 0;
}

/** Merge our two keys into `settings`; returns change lines. Throws (nothing written) on conflicts. */
export function mergeTeamSettings(settings: Obj, version: string = CLI_VERSION): string[] {
  const changes: string[] = [];
  const want = marketplaceSource(version);

  // Claude Code reads the alias only when the canonical key is absent: adding ours would drop theirs.
  if (settings.additionalMarketplaces !== undefined) {
    throw refuse("settings use the additionalMarketplaces alias; rename it to extraKnownMarketplaces by hand first");
  }
  const markets = settings.extraKnownMarketplaces ?? {};
  if (!isObj(markets)) throw refuse("extraKnownMarketplaces is not an object; fix it by hand first");
  const entry = markets[MARKETPLACE];
  if (entry === undefined) {
    markets[MARKETPLACE] = { source: want };
    changes.push(`+ extraKnownMarketplaces.${MARKETPLACE}.source = github ${want.repo} ref ${want.ref}`);
  } else {
    const src = isObj(entry) ? entry.source : undefined;
    if (!isObj(src) || src.source !== "github" || src.repo !== PUBLIC_REPO) {
      throw refuse(
        `extraKnownMarketplaces.${MARKETPLACE} already points somewhere else; remove or fix it by hand, then rerun`,
      );
    }
    if (src.ref !== want.ref) {
      if (typeof src.ref === "string" && newerThan(src.ref, want.ref)) {
        changes.push(`! downgrade: the file pins ${src.ref}, newer than this kya (${want.ref}); upgrade kya instead if that is not intended`);
      }
      changes.push(`~ extraKnownMarketplaces.${MARKETPLACE}.source.ref: ${JSON.stringify(src.ref ?? null)} -> "${want.ref}"`);
      src.ref = want.ref;
    }
  }
  settings.extraKnownMarketplaces = markets;

  const enabled = settings.enabledPlugins ?? {};
  if (!isObj(enabled)) throw refuse("enabledPlugins is not an object; fix it by hand first");
  if (enabled[PLUGIN_ID] === false) {
    throw refuse(`enabledPlugins["${PLUGIN_ID}"] is false (someone turned it off); change it by hand if you want it on`);
  }
  if (enabled[PLUGIN_ID] !== true) {
    enabled[PLUGIN_ID] = true;
    changes.push(`+ enabledPlugins["${PLUGIN_ID}"] = true`);
  }
  settings.enabledPlugins = enabled;
  return changes;
}

export function runTeamInit(opts: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly dryRun?: boolean;
  readonly version?: string;
}): TeamInitResult {
  const { dir, file } = guardPaths(opts.cwd, opts.env ?? process.env);
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  let settings: unknown = {};
  if (before !== undefined && before.trim() !== "") {
    try {
      settings = JSON.parse(before);
    } catch (err) {
      throw refuse(`${file} is not valid JSON (${(err as Error).message}); nothing was written`);
    }
  }
  if (!isObj(settings)) throw refuse(`${file} is not a JSON object; nothing was written`);
  const changes = mergeTeamSettings(settings, opts.version);
  const indent = before ? detectIndent(before) : 2;
  // ponytail: re-serializes the whole file; a surgical text insert would keep a hand-made layout.
  const reformatted = !!before?.trim() && `${JSON.stringify(JSON.parse(before), null, indent)}\n` !== before;
  const content = `${JSON.stringify(settings, null, indent)}\n`;
  const base = { path: file, dryRun: opts.dryRun === true, changes, content, ref: releaseRef(opts.version), reformatted };
  if (base.dryRun || changes.length === 0) return { ...base, written: false };
  if (!existsSync(dir)) mkdirSync(dir);
  // Re-check right before the rename that .claude and settings.json are still not symlinks and still the
  // project's. Residual: a same-user process can still swap them between this check and the rename (TOCTOU);
  // a planted temp file or symlink cannot be followed, since atomicWriteSync creates its temp with O_EXCL.
  atomicWriteSync(file, content, () => {
    const again = guardPaths(opts.cwd, opts.env ?? process.env);
    if (again.file !== file) throw refuse(`${dir} changed while writing; nothing was written`);
  });
  return { ...base, written: true };
}

export function formatTeamInitHuman(r: TeamInitResult): string {
  const lines: string[] = [];
  if (r.changes.length === 0) lines.push(`${r.path} already enables ${PLUGIN_ID} at ${r.ref}; nothing to do.`);
  else lines.push(`${r.dryRun ? "Would write" : "Wrote"} ${r.path}:`, ...r.changes.map((c) => `  ${c}`));
  if (r.changes.length > 0 && r.reformatted) {
    lines.push("Note: the existing file's layout is normalized to standard JSON (keys and values unchanged).");
  }
  if (r.dryRun && r.changes.length > 0) lines.push("", "Resulting file:", r.content.trimEnd());
  lines.push(
    "",
    "Next: commit .claude/settings.json. Teammates see Claude Code's folder trust prompt once;",
    `after they accept it, the ${MARKETPLACE} marketplace is added and ${PLUGIN_ID} installs at the next session.`,
    `Pinned to tag ${r.ref} of ${PUBLIC_REPO}. Rerun kya team init after upgrading kya to move the pin.`,
    `Verify the public tag ${r.ref} exists (git ls-remote https://github.com/${PUBLIC_REPO} refs/tags/${r.ref});`,
    "if it does not, teammates will see the plugin skipped, not an error.",
    "OSS plugin is advisory and fails open: it records tool calls and blocks only the never-list.",
  );
  return lines.join("\n");
}
