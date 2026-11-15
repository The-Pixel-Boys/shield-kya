/**
 * `kya team init` / `kya team managed-settings`: spread the Claude Code plugin to a team.
 *
 * `team init --guard` does the same for the kya-guard plugin (one bundled file, no install step): the same marketplace pin,
 * and enabledPlugins["kya-guard@shield-kya"] = true instead of kya@shield-kya. It prints the exact diff and a README badge,
 * writes no .kya/policy.json, and refuses when kya@shield-kya is on (both plugins would write a row for every call).
 * The write is recorded in ~/.kya/manifest.json by the caller (src/cli.ts), so `kya uninstall --project` reverses it.
 *
 * init merges two keys into the CURRENT PROJECT's `.claude/settings.json` (never the user's):
 *   extraKnownMarketplaces["shield-kya"] = github The-Pixel-Boys/shield-kya at ref v<version>
 *   enabledPlugins["kya@shield-kya"] = true
 * Every other key is kept. init also scaffolds `<project>/.kya/policy.json` when it is absent (no rules, so no
 * verdict changes); an existing file is never touched. See src/project-policy.ts for what the file may do.
 * No network, no permissions, nothing auto-accepted: Claude Code still
 * shows each teammate its folder trust prompt. managed-settings prints the same two keys as an
 * admin policy document. A prerelease kya refuses both (no public tag to pin). Schema: code.claude.com/docs/en/plugins/org and
 * /docs/en/plugins/marketplace-reference (marketplace `github` source: repo, ref, path; no sha).
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { globalConfigDir } from "../config.js";
import { KyaError } from "../errors.js";
import { atomicWriteSync } from "../fs-atomic.js";
import { POLICY_FILE, POLICY_SCAFFOLD } from "../project-policy.js";
import { compareVersions } from "../update-check.js";
import { CLI_VERSION } from "../version.js";
import { journalMkdir } from "../write-journal.js";

export const MARKETPLACE = "shield-kya";
export const PLUGIN_ID = "kya@shield-kya";
export const GUARD_PLUGIN_ID = "kya-guard@shield-kya";
export const SCOREBOARD_URL = "https://shield-agent.com/replays";
/** The line a maintainer pastes into the README: a static badge that reads "agent-guarded" and links to the scoreboard. */
export const GUARD_BADGE = `[![agent-guarded](https://img.shields.io/badge/agent--guarded-KYA%20Guard-2ea44f)](${SCOREBOARD_URL})`;
export const PUBLIC_REPO = "The-Pixel-Boys/shield-kya";

/** Public repo release tags are `v<version>` (the `kya-v*` tags live only in the private monorepo). */
export function releaseRef(version: string = CLI_VERSION): string {
  return `v${version}`;
}

/**
 * A prerelease kya (X.Y.Z-pre) is published to npm `next` only: shield-kya gets no `v<version>` tag for it,
 * so a pin to that ref would point at nothing. Refuse instead of writing a broken marketplace source.
 */
export function marketplaceSource(version: string = CLI_VERSION) {
  if (version.includes("-")) {
    throw refuse(`kya ${version} is a prerelease: prerelease kya has no public tag; use a stable kya (npx @shield-agent/kya@latest team init)`);
  }
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
  /** --guard run: the kya-guard plugin instead of the kya plugin. */
  readonly guard: boolean;
  /** Unified diff of the settings file (guard runs; empty otherwise). */
  readonly diff: string;
  /** README badge line (guard runs; empty otherwise). */
  readonly badge: string;
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

/** Refuse anything that would land outside the project: symlinks, or the user-level Claude or kya dir. */
function guardPaths(cwd: string, env: NodeJS.ProcessEnv): { dir: string; file: string; policyDir: string; policyFile: string } {
  const root = real(cwd);
  if (!root) throw refuse(`project directory not found: ${cwd}`);
  const dir = join(root, ".claude");
  const file = join(dir, "settings.json");
  const policyDir = join(root, ".kya");
  const policyFile = join(root, POLICY_FILE);
  // Resolve even when the user dir does not exist yet (HOME behind a symlink, fresh machine).
  const loose = (p: string) => real(p) ?? join(real(dirname(p)) ?? dirname(p), basename(p));
  const userDirs = [join(homedir(), ".claude"), env.CLAUDE_CONFIG_DIR].filter((p): p is string => !!p).map(loose);
  if (userDirs.includes(dir)) {
    throw refuse(`${dir} is your user-level Claude Code directory; run kya team init inside a project`);
  }
  if (loose(policyDir) === loose(globalConfigDir(env))) {
    throw refuse(`${policyDir} is your global kya directory; run kya team init inside a project`);
  }
  for (const [p, kind] of [[dir, "directory"], [file, "file"], [policyDir, "directory"], [policyFile, "file"]] as const) {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isSymbolicLink()) throw refuse(`${p} is a symlink; refusing to write through it`);
    if (kind === "directory" ? !st.isDirectory() : !st.isFile()) throw refuse(`${p} is not a regular ${kind}`);
  }
  return { dir, file, policyDir, policyFile };
}

function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1]! : 2;
}

/** True when tag `a` (vX.Y.Z[-pre]) is a strictly newer release than `b` (SemVer precedence); other refs are not newer. */
function newerThan(a: string, b: string): boolean {
  const tag = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
  return tag.test(a) && tag.test(b) && compareVersions(a, b) > 0;
}

/**
 * Unified diff of two texts, 2 lines of context. Line based (LCS): the settings files are small.
 * Empty string when the texts are equal.
 */
export function unifiedDiff(label: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<[" " | "-" | "+", string]> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([" ", a[i++]!]), j++;
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push(["-", a[i++]!]); // a removal first, as diff does
    else ops.push(["+", b[j++]!]);
  }
  const keep = ops.map(([k], x) => k !== " " || ops.slice(Math.max(0, x - 2), x + 3).some(([c]) => c !== " "));
  const out = [`--- ${before === "" ? "/dev/null" : `a/${label}`}`, `+++ b/${label}`];
  let x = 0;
  while (x < ops.length) {
    if (!keep[x]) { x++; continue; }
    let end = x;
    while (end < ops.length && keep[end]) end++;
    const hunk = ops.slice(x, end);
    const startA = ops.slice(0, x).filter(([k]) => k !== "+").length + 1;
    const startB = ops.slice(0, x).filter(([k]) => k !== "-").length + 1;
    out.push(`@@ -${startA},${hunk.filter(([k]) => k !== "+").length} +${startB},${hunk.filter(([k]) => k !== "-").length} @@`);
    for (const [k, line] of hunk) out.push(`${k}${line}`);
    x = end;
  }
  return out.join("\n");
}

/** Merge our two keys into `settings`; returns change lines. Throws (nothing written) on conflicts. `guard` swaps kya for kya-guard. */
export function mergeTeamSettings(settings: Obj, version: string = CLI_VERSION, guard = false): string[] {
  const pluginId = guard ? GUARD_PLUGIN_ID : PLUGIN_ID;
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
  if (enabled[pluginId] === false) {
    throw refuse(`enabledPlugins["${pluginId}"] is false (someone turned it off); change it by hand if you want it on`);
  }
  if (guard && enabled[PLUGIN_ID] === true) {
    throw refuse(`enabledPlugins["${PLUGIN_ID}"] is on: kya and kya-guard together write two rows for every call; turn one off by hand first`);
  }
  if (enabled[pluginId] !== true) {
    enabled[pluginId] = true;
    changes.push(`+ enabledPlugins["${pluginId}"] = true`);
  }
  settings.enabledPlugins = enabled;
  return changes;
}

export function runTeamInit(opts: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly dryRun?: boolean;
  readonly version?: string;
  /** Enable the kya-guard plugin instead of the kya plugin. */
  readonly guard?: boolean;
}): TeamInitResult {
  const guard = opts.guard === true;
  const { dir, file, policyDir, policyFile } = guardPaths(opts.cwd, opts.env ?? process.env);
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
  const settingsChanges = mergeTeamSettings(settings, opts.version, guard);
  const indent = before ? detectIndent(before) : 2;
  // ponytail: re-serializes the whole file; a surgical text insert would keep a hand-made layout.
  const reformatted = !!before?.trim() && `${JSON.stringify(JSON.parse(before), null, indent)}\n` !== before;
  const content = `${JSON.stringify(settings, null, indent)}\n`;
  // The policy file is created once and never rewritten: a team's rules belong to the team, not to kya.
  const policyChanges = guard || existsSync(policyFile) ? [] : [`+ ${POLICY_FILE} = empty policy (no rules yet; add tool ids to deny or requireApprove)`];
  const changes = [...settingsChanges, ...policyChanges];
  const diff = guard ? unifiedDiff(".claude/settings.json", before ?? "", content) : "";
  const base = {
    path: file, dryRun: opts.dryRun === true, changes, content, ref: releaseRef(opts.version), reformatted, guard, diff,
    badge: guard ? GUARD_BADGE : "",
  };
  if (base.dryRun || changes.length === 0) return { ...base, written: false };
  if (!existsSync(dir) && settingsChanges.length > 0) journalMkdir(dir); // journaled: `kya uninstall --project` removes it again
  // Re-check right before the rename that .claude and settings.json are still not symlinks and still the
  // project's. Residual: a same-user process can still swap them between this check and the rename (TOCTOU);
  // a planted temp file or symlink cannot be followed, since atomicWriteSync creates its temp with O_EXCL.
  const recheck = () => {
    const again = guardPaths(opts.cwd, opts.env ?? process.env);
    if (again.file !== file || again.policyFile !== policyFile) throw refuse(`${dir} changed while writing; nothing was written`);
  };
  if (settingsChanges.length > 0) atomicWriteSync(file, content, recheck);
  if (policyChanges.length > 0) {
    if (!existsSync(policyDir)) journalMkdir(policyDir);
    atomicWriteSync(policyFile, POLICY_SCAFFOLD, recheck);
  }
  return { ...base, written: true };
}

function formatGuardHuman(r: TeamInitResult): string {
  const lines: string[] = [];
  if (r.changes.length === 0) lines.push(`${r.path} already enables ${GUARD_PLUGIN_ID} at ${r.ref}; nothing to do.`);
  else lines.push(`${r.dryRun ? "Would write" : "Wrote"} ${r.path}:`, ...r.changes.map((c) => `  ${c}`), "", "Diff:", r.diff);
  if (r.changes.length > 0 && r.reformatted) {
    lines.push("Note: the existing file's layout is normalized to standard JSON (keys and values unchanged).");
  }
  lines.push(
    "",
    "README badge (paste it near the top of your README):",
    r.badge,
    "",
    "Next: commit .claude/settings.json. Teammates see Claude Code's folder trust prompt once;",
    `after they accept it, the ${MARKETPLACE} marketplace is added and ${GUARD_PLUGIN_ID} installs at the next session.`,
    `Pinned to tag ${r.ref} of ${PUBLIC_REPO}. Rerun kya team init --guard after upgrading kya to move the pin.`,
    `Verify the tag exists and ships the plugin (git ls-remote https://github.com/${PUBLIC_REPO} refs/tags/${r.ref}; the folder plugins/kya-guard must be in it);`,
    "if it is not, teammates will see the plugin skipped, not an error.",
    "The guard needs Node.js 22 or later on PATH. It checks every tool call locally, makes no network call, and fails open.",
    "Remove: kya uninstall --project (reverses this write), or delete the two keys by hand.",
  );
  return lines.join("\n");
}

export function formatTeamInitHuman(r: TeamInitResult): string {
  if (r.guard) return formatGuardHuman(r);
  const lines: string[] = [];
  if (r.changes.length === 0) lines.push(`${r.path} already enables ${PLUGIN_ID} at ${r.ref}; nothing to do.`);
  else lines.push(`${r.dryRun ? "Would write" : "Wrote"} ${r.path}:`, ...r.changes.map((c) => `  ${c}`));
  if (r.changes.length > 0 && r.reformatted) {
    lines.push("Note: the existing file's layout is normalized to standard JSON (keys and values unchanged).");
  }
  if (r.dryRun && r.changes.length > 0) lines.push("", "Resulting file:", r.content.trimEnd());
  lines.push(
    "",
    "Next: commit .claude/settings.json and .kya/policy.json. Teammates see Claude Code's folder trust prompt once;",
    `after they accept it, the ${MARKETPLACE} marketplace is added and ${PLUGIN_ID} installs at the next session.`,
    `Pinned to tag ${r.ref} of ${PUBLIC_REPO}. Rerun kya team init after upgrading kya to move the pin.`,
    `Verify the public tag ${r.ref} exists (git ls-remote https://github.com/${PUBLIC_REPO} refs/tags/${r.ref});`,
    "if it does not, teammates will see the plugin skipped, not an error.",
    "OSS plugin is advisory and fails open: it records tool calls and blocks the never-list and the guard pack.",
  );
  return lines.join("\n");
}
