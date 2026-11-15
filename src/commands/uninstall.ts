/**
 * kya uninstall - undo what `kya start` / `kya connect` wrote, from
 * ~/.kya/manifest.json. Removes only the keys KYA added, deletes files KYA
 * created when they are unchanged, restores merged files byte for byte when
 * nothing touched them since, and lists what it left alone.
 *
 * The manifest drives deletes and writes, so it is not trusted blindly: it must
 * be a 0600 file owned by the user with a valid shape; every entry must name a
 * known KYA target path; backups must live under ~/.kya/undo/; project files go
 * through the project path guard; a symlink or hard link is refused.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteSync, projectWritePath, writeProjectFile } from "../fs-atomic.js";
import {
  readManifestStrict,
  resolvedOf,
  sha256,
  tomlHeaders,
  writeManifest,
  manifestPath,
  withManifestLock,
  type Added,
  type ManifestEntry,
} from "../manifest.js";
import { globalConfigDir } from "../config.js";
import { CONNECT_REGISTRY } from "./connect.js";

export interface UninstallLine {
  readonly path: string;
  readonly what: string;
}

export interface UninstallResult {
  readonly dryRun: boolean;
  readonly restored: readonly UninstallLine[];
  readonly keysRemoved: readonly UninstallLine[];
  readonly deleted: readonly UninstallLine[];
  readonly leftAlone: readonly UninstallLine[];
  readonly nothingToUndo: boolean;
}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

function getAt(doc: Json, path: readonly string[]): Json {
  let cur = doc;
  for (const k of path) {
    if (!isObj(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setAt(doc: Record<string, Json>, path: readonly string[], value: Json): void {
  let cur = doc;
  for (const k of path.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, Json>;
  }
  cur[path[path.length - 1]!] = value;
}

function deleteAt(doc: Json, path: readonly string[]): void {
  if (path.length === 0) return;
  const parent = getAt(doc, path.slice(0, -1));
  if (isObj(parent)) delete parent[path[path.length - 1]!];
}

/** Drop containers that became empty and that the original file did not have. */
function prune(doc: Json, orig: Json, path: readonly string[]): void {
  for (let n = path.length; n > 0; n--) {
    const p = path.slice(0, n);
    const v = getAt(doc, p);
    const empty = Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0;
    if (!empty || getAt(orig, p) !== undefined) return;
    deleteAt(doc, p);
  }
}

interface Surgery {
  readonly text: string;
  /** Removals KYA made that the backup could not put back. */
  readonly unrestored: string[];
}

function surgicalJson(text: string, entry: ManifestEntry, orig: Json): Surgery {
  const doc = JSON.parse(text) as Json;
  if (!isObj(doc)) throw new Error("not an object");
  const unrestored: string[] = [];
  for (const a of entry.added) {
    if (a.kind === "key") {
      const was = getAt(orig, a.path);
      if (was !== undefined) setAt(doc, a.path, was);
      else deleteAt(doc, a.path);
      prune(doc, orig, a.path.slice(0, -1));
    } else if (a.kind === "item") {
      const arr = getAt(doc, a.path);
      if (Array.isArray(arr)) {
        const keep = arr.filter((i) => !same(i, a.value));
        if (keep.length !== arr.length) setAt(doc, a.path, keep);
      }
      prune(doc, orig, a.path);
    }
  }
  for (const p of entry.removed) {
    const was = getAt(orig, p);
    if (getAt(doc, p) !== undefined) continue;
    if (was !== undefined) setAt(doc, p, was);
    else unrestored.push(p.join("."));
  }
  return { text: `${JSON.stringify(doc, null, 2)}\n`, unrestored };
}

function surgicalToml(text: string, entry: ManifestEntry, orig: string | undefined): Surgery {
  let out = text;
  for (const a of entry.added) {
    const blocks = tomlHeaders(out).filter((h) =>
      a.kind === "toml-table" ? !h.array && h.name === a.name : a.kind === "toml-hook" ? h.array && h.body.includes(a.identity) : false,
    );
    for (const b of blocks.reverse()) out = out.slice(0, b.start) + out.slice(b.end);
  }
  const unrestored: string[] = [];
  const origBlocks = orig === undefined ? [] : tomlHeaders(orig).filter((h) => !h.array);
  for (const name of entry.removedToml ?? []) {
    if (tomlHeaders(out).some((h) => !h.array && h.name === name)) continue;
    const block = origBlocks.find((h) => h.name === name);
    if (!block) {
      unrestored.push(`[${name}]`);
      continue;
    }
    const body = block.body.endsWith("\n") ? block.body : `${block.body}\n`;
    out = `${out}${out.length === 0 || out.endsWith("\n") ? "" : "\n"}${out.length === 0 ? "" : "\n"}${body}`;
  }
  return { text: out, unrestored };
}

function surgicalLines(text: string, adds: readonly Added[]): Surgery {
  const lines = text.split("\n");
  for (const a of adds) {
    if (a.kind !== "line") continue;
    const i = lines.lastIndexOf(a.text);
    if (i !== -1) lines.splice(i, 1);
  }
  return { text: lines.join("\n"), unrestored: [] };
}

function within(path: string, dir: string): boolean {
  const r = relative(resolve(dir), resolve(path));
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvedOf(p);
  }
}

/** The only files undo may touch: what start and connect write. */
function targetSet(home: string, project: string | undefined): Set<string> {
  const out = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p) out.add(canon(p));
  };
  for (const spec of Object.values(CONNECT_REGISTRY)) {
    add(spec.globalPath?.(home));
    if (project) add(spec.projectPath?.(project));
  }
  add(join(home, ".claude", "settings.json"));
  add(join(home, ".grok", "hooks", "shield-kya.json"));
  add(join(home, ".kimi-code", "config.toml"));
  add(join(home, ".kya", "bin", "kya-hook"));
  add(join(home, ".kya", "gateways.json"));
  if (project) {
    add(join(project, ".claude", "settings.json"));
    add(join(project, ".gitignore"));
    add(join(project, ".kya", "config.json"));
  }
  return out;
}

interface Ctx {
  readonly home: string;
  readonly globalDir: string;
  readonly undoDir: string;
}

function allowed(e: ManifestEntry, c: Ctx): boolean {
  const set = targetSet(c.home, e.project);
  return set.has(canon(e.path)) || set.has(e.path);
}

/** A reason to refuse this entry, or undefined when it is safe to touch. */
function refusal(e: ManifestEntry, c: Ctx): string | undefined {
  if (!allowed(e, c)) return "not a file kya start or kya connect writes (manifest entry refused)";
  if (e.backup !== undefined && existsSync(e.backup)) {
    if (lstatSync(e.backup).isSymbolicLink()) return "its backup is a symlink (refused)";
    if (!within(realpathSync(e.backup), canon(c.undoDir))) return "its backup is outside ~/.kya/undo (manifest entry refused)";
  } else if (e.backup !== undefined && !within(resolve(e.backup), c.undoDir)) {
    return "its backup path is outside ~/.kya/undo (manifest entry refused)";
  }
  if (!existsSync(e.path)) return undefined;
  if (e.resolved !== undefined && resolvedOf(e.path) !== e.resolved) return "its path no longer resolves to where KYA wrote it (a parent directory was replaced by a link)";
  const st = lstatSync(e.path);
  if (st.isSymbolicLink()) return "it is now a symlink (refused, not followed)";
  if (!st.isFile()) return "it is not a regular file";
  if (st.nlink > 1) return `it has other hard links (${st.nlink}); refused`;
  if (e.project !== undefined && within(e.path, e.project)) {
    try {
      projectWritePath(e.path, e.project);
    } catch (err) {
      return err instanceof Error ? err.message : "project path refused";
    }
  }
  return undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function runUninstall(opts: { env: NodeJS.ProcessEnv; cwd: string; project: boolean; dryRun?: boolean }): UninstallResult {
  const dryRun = opts.dryRun === true;
  const globalDir = globalConfigDir(opts.env);
  const manifest = readManifestStrict(globalDir);
  const result = (p: Partial<UninstallResult> & { nothingToUndo: boolean }): UninstallResult => ({
    dryRun,
    restored: [],
    keysRemoved: [],
    deleted: [],
    leftAlone: [],
    ...p,
  });
  if (!manifest) return result({ nothingToUndo: true });
  const ctx: Ctx = { home: dirname(globalDir), globalDir, undoDir: join(globalDir, "undo") };
  const inScope = (e: ManifestEntry): boolean => !opts.project || within(e.path, opts.cwd);
  const todo = manifest.entries.filter(inScope);
  const restored: UninstallLine[] = [];
  const keysRemoved: UninstallLine[] = [];
  const deleted: UninstallLine[] = [];
  const leftAlone: UninstallLine[] = [];
  const doneBackups: string[] = [];
  /** Entries that stay in the manifest: refused or failed, so a re-run can finish them. */
  const kept = new Set<string>();

  const put = (e: ManifestEntry, content: string | Buffer): void => {
    if (dryRun) return;
    if (e.project !== undefined && within(e.path, e.project)) writeProjectFile(e.path, content.toString(), e.project);
    else atomicWriteSync(e.path, content);
  };

  for (const e of todo) {
    const bk = e.backup ? ` (backup: ${e.backup})` : "";
    if (!existsSync(e.path)) {
      if (!allowed(e, ctx)) {
        kept.add(e.path);
        leftAlone.push({ path: e.path, what: `not a file kya start or kya connect writes (manifest entry refused)${bk}` });
        continue;
      }
      leftAlone.push({ path: e.path, what: `already gone${bk}` });
      if (e.backup) doneBackups.push(e.backup);
      continue;
    }
    const why = refusal(e, ctx);
    if (why !== undefined) {
      kept.add(e.path);
      leftAlone.push({ path: e.path, what: `${why}; left in place${bk}` });
      continue;
    }
    try {
      const bytes = readFileSync(e.path);
      const unchanged = sha256(bytes) === e.sha256 && !e.stale;
      if (e.action === "created") {
        if (!unchanged) {
          leftAlone.push({ path: e.path, what: `KYA created it, but it changed since (or before a later KYA write); left in place (delete it by hand if you want it gone)${bk}` });
          continue;
        }
        if (!dryRun) rmSync(e.path, { force: true });
        deleted.push({ path: e.path, what: "created by KYA, unchanged" });
        continue;
      }
      const backupBytes = e.backup && existsSync(e.backup) ? readFileSync(e.backup) : undefined;
      if (backupBytes && sha256(backupBytes) === sha256(bytes)) {
        restored.push({ path: e.path, what: "already in its original state" });
        doneBackups.push(e.backup!);
        continue;
      }
      if (unchanged && backupBytes) {
        put(e, backupBytes);
        restored.push({ path: e.path, what: "restored byte for byte from the backup" });
        doneBackups.push(e.backup!);
        continue;
      }
      const text = bytes.toString("utf8");
      const origText = backupBytes?.toString("utf8");
      let s: Surgery;
      if (e.path.endsWith(".json")) s = surgicalJson(text, e, origText !== undefined ? (JSON.parse(origText) as Json) : undefined);
      else if (e.path.endsWith(".toml")) s = surgicalToml(text, e, origText);
      else s = surgicalLines(text, e.added);
      put(e, s.text);
      keysRemoved.push({ path: e.path, what: `changed since KYA wrote it, so only KYA's entries were removed: ${e.keys.join(", ")}` });
      if (s.unrestored.length > 0) {
        // The backup is the only copy of what the gateway moved: keep it and the entry.
        kept.add(e.path);
        leftAlone.push({ path: e.path, what: `could not put back ${s.unrestored.join(", ")} (not found in the backup); backup kept${bk}` });
      } else if (e.backup) doneBackups.push(e.backup);
    } catch (err) {
      kept.add(e.path);
      leftAlone.push({ path: e.path, what: `could not undo it (${errMsg(err)}); left in place, run kya uninstall again after fixing${bk}` });
    }
  }

  if (!dryRun) {
    for (const b of doneBackups) {
      if (!todo.some((e) => kept.has(e.path) && e.backup === b)) rmSync(b, { force: true });
    }
    withManifestLock(globalDir, () => {
      const handled = new Set(todo.filter((e) => !kept.has(e.path)).map((e) => e.path));
      const rest = manifest.entries.filter((e) => !handled.has(e.path));
      const roots = [ctx.home, ...rest.map((e) => e.project).filter((p): p is string => p !== undefined), opts.cwd];
      const dirs = [...manifest.dirs].sort((a, b) => b.length - a.length);
      const keepDirs: string[] = [];
      for (const d of dirs) {
        const safe = isAbsolute(d) && roots.some((r) => within(d, r) && resolve(d) !== resolve(r));
        if (!safe || (opts.project && !within(d, opts.cwd))) {
          keepDirs.push(d);
          continue;
        }
        try {
          if (existsSync(d) && !lstatSync(d).isSymbolicLink() && readdirSync(d).length === 0) rmdirSync(d);
          else if (existsSync(d)) keepDirs.push(d);
        } catch {
          keepDirs.push(d);
        }
      }
      if (rest.length === 0) {
        rmSync(manifestPath(globalDir), { force: true });
        try {
          if (existsSync(ctx.undoDir) && readdirSync(ctx.undoDir).length === 0) rmdirSync(ctx.undoDir);
        } catch {
          /* not empty: leave it */
        }
      } else {
        writeManifest(globalDir, { version: 1, entries: rest, dirs: keepDirs });
      }
    });
    // The lock file is gone by now; remove the global dir only when nothing else lives there.
    try {
      if (existsSync(globalDir) && readdirSync(globalDir).length === 0) rmdirSync(globalDir);
    } catch {
      /* the global dir holds other KYA data: leave it */
    }
  }

  return { dryRun, restored, keysRemoved, deleted, leftAlone, nothingToUndo: todo.length === 0 };
}

export function formatUninstallHuman(r: UninstallResult, cwd: string): string {
  if (r.nothingToUndo) {
    return [
      "Nothing to undo: ~/.kya/manifest.json lists no files for this scope.",
      "Hooks and MCP entries written by an older kya (before the manifest) are not listed; remove the shield-kya entries by hand.",
    ].join("\n");
  }
  const verb = r.dryRun ? "Would" : "Did";
  const lines: string[] = [`KYA uninstall${r.dryRun ? " (dry run: nothing changed)" : ""}`];
  const show = (head: string, list: readonly UninstallLine[]): void => {
    if (list.length === 0) return;
    lines.push(`${head}:`);
    for (const l of list) {
      const rel = relative(cwd, l.path);
      lines.push(`  ${rel.startsWith("..") || rel === "" ? l.path : rel}: ${l.what}`);
    }
  };
  show(`${verb} restore`, r.restored);
  show(`${verb} remove KYA's entries from`, r.keysRemoved);
  show(`${verb} delete`, r.deleted);
  show("Left alone", r.leftAlone);
  lines.push(
    "Not touched: .kya/ (your activity trail and report files) and ~/.kya/ state. Delete them by hand if you want them gone.",
    "The background report server keeps running until you run: kya stop",
  );
  return lines.join("\n");
}
