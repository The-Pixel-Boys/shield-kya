/**
 * ~/.kya/manifest.json: the record of every file `kya start` (and `kya connect`)
 * wrote, so `kya uninstall` can undo exactly that and nothing else.
 *
 * One entry per path: created or merged, the keys KYA added, the keys KYA
 * removed (gateway routing), a backup of the original bytes for merged files,
 * and the sha256 of what KYA last wrote (to tell "unchanged since" from "the
 * user or the host edited it since").
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import nodePath from "node:path";
import { basename, dirname, join } from "node:path";
import { KyaError } from "./errors.js";
import { atomicWriteSecretSync } from "./fs-atomic.js";
import { WriteJournal, withoutJournal } from "./write-journal.js";

export type Added =
  | { readonly kind: "key"; readonly path: readonly string[] }
  | { readonly kind: "item"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "toml-table"; readonly name: string }
  | { readonly kind: "toml-hook"; readonly identity: string };

export interface ManifestEntry {
  readonly path: string;
  readonly action: "created" | "merged";
  readonly scope: "home" | "project";
  /** Project root for scope "project". */
  readonly project?: string;
  readonly keys: readonly string[];
  readonly added: readonly Added[];
  /** JSON key paths KYA removed from the file (restored from the backup on undo). */
  readonly removed: readonly (readonly string[])[];
  /** TOML table names KYA removed from the file (restored from the backup on undo). */
  readonly removedToml?: readonly string[];
  /** realpath of the parent dir plus the file name at write time: undo refuses when it no longer matches. */
  readonly resolved?: string;
  readonly backup?: string;
  /**
   * Set when a later KYA write found the file changed since the previous KYA write.
   * The first backup no longer matches the file, so undo takes only KYA's keys, never the backup or a delete.
   */
  readonly stale?: boolean;
  readonly sha256: string;
  readonly at: string;
}

export interface Manifest {
  readonly version: 1;
  readonly entries: readonly ManifestEntry[];
  /** Directories KYA created (removed on undo when empty). */
  readonly dirs: readonly string[];
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function manifestPath(globalDir: string): string {
  return join(globalDir, "manifest.json");
}

const ADDED_KINDS = new Set(["key", "item", "line", "toml-table", "toml-hook"]);

function isStrArr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Strict shape check. Throws a plain Error naming the first problem. */
export function parseManifest(raw: unknown): Manifest {
  const bad = (m: string): never => {
    throw new Error(m);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not an object");
  const r = raw as Record<string, unknown>;
  if (r["version"] !== 1) bad("version is not 1");
  if (!Array.isArray(r["entries"])) bad("entries is not an array");
  if (r["dirs"] !== undefined && !isStrArr(r["dirs"])) bad("dirs is not a list of strings");
  for (const [i, e] of (r["entries"] as unknown[]).entries()) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) return bad(`entry ${i} is not an object`);
    const x = e as Record<string, unknown>;
    if (typeof x["path"] !== "string" || !nodePath.isAbsolute(x["path"])) bad(`entry ${i}: path is not an absolute string`);
    if (x["action"] !== "created" && x["action"] !== "merged") bad(`entry ${i}: action`);
    if (x["scope"] !== "home" && x["scope"] !== "project") bad(`entry ${i}: scope`);
    if (x["project"] !== undefined && (typeof x["project"] !== "string" || !nodePath.isAbsolute(x["project"]))) bad(`entry ${i}: project`);
    if (!isStrArr(x["keys"])) bad(`entry ${i}: keys`);
    if (!Array.isArray(x["added"])) bad(`entry ${i}: added`);
    for (const a of x["added"] as unknown[]) {
      const k = (a as { kind?: unknown } | null)?.kind;
      if (typeof k !== "string" || !ADDED_KINDS.has(k)) bad(`entry ${i}: added kind`);
      const aa = a as Record<string, unknown>;
      if ((k === "key" || k === "item") && !isStrArr(aa["path"])) bad(`entry ${i}: added path`);
      if (k === "line" && typeof aa["text"] !== "string") bad(`entry ${i}: added line`);
      if (k === "toml-table" && typeof aa["name"] !== "string") bad(`entry ${i}: added table`);
      if (k === "toml-hook" && typeof aa["identity"] !== "string") bad(`entry ${i}: added hook`);
    }
    if (!Array.isArray(x["removed"]) || !(x["removed"] as unknown[]).every(isStrArr)) bad(`entry ${i}: removed`);
    if (x["removedToml"] !== undefined && !isStrArr(x["removedToml"])) bad(`entry ${i}: removedToml`);
    if (x["backup"] !== undefined && typeof x["backup"] !== "string") bad(`entry ${i}: backup`);
    if (x["resolved"] !== undefined && typeof x["resolved"] !== "string") bad(`entry ${i}: resolved`);
    if (x["stale"] !== undefined && typeof x["stale"] !== "boolean") bad(`entry ${i}: stale`);
    if (typeof x["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(x["sha256"])) bad(`entry ${i}: sha256`);
    if (typeof x["at"] !== "string") bad(`entry ${i}: at`);
  }
  return { version: 1, entries: r["entries"] as ManifestEntry[], dirs: (r["dirs"] as string[] | undefined) ?? [] };
}

/**
 * Manifest for undo. Refuses (exit 1) a file that is not a regular 0600 file owned by this user, or
 * whose shape is wrong: a manifest someone else could write must never drive deletes and writes.
 */
export function readManifestStrict(globalDir: string): Manifest | undefined {
  const file = manifestPath(globalDir);
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return undefined;
  }
  const refuse = (why: string): never => {
    throw new KyaError(`${file}: ${why}; refusing to run kya uninstall. Check the file, or delete it if you wrote it by hand.`, "MANIFEST_UNTRUSTED", 1);
  };
  if (!st.isFile()) refuse("not a regular file");
  if (process.platform !== "win32") {
    if ((st.mode & 0o077) !== 0) refuse(`mode is ${(st.mode & 0o777).toString(8)}, expected 600`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) refuse("not owned by you");
  }
  try {
    return parseManifest(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    return refuse(`malformed (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Manifest for recording: a missing or unreadable file is empty; an invalid one is set aside, never overwritten. */
export function readManifest(globalDir: string): Manifest {
  const file = manifestPath(globalDir);
  if (!existsSync(file)) return { version: 1, entries: [], dirs: [] };
  try {
    return parseManifest(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    try {
      renameSync(file, `${file}.invalid-${Date.now()}`);
    } catch {
      /* best effort */
    }
    return { version: 1, entries: [], dirs: [] };
  }
}

export function writeManifest(globalDir: string, m: Manifest): void {
  mkdirSync(globalDir, { recursive: true });
  withoutJournal(() => atomicWriteSecretSync(manifestPath(globalDir), `${JSON.stringify(m, null, 2)}\n`));
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * O_EXCL lock file around a read-merge-write of the manifest. Bounded wait (about 10 s). A lock whose
 * owner pid is gone, or that is older than 30 s, is taken over. Runs fn without the lock after the
 * wait ends: a lost update is better than a hung start.
 */
export function withManifestLock<T>(globalDir: string, fn: () => T): T {
  mkdirSync(globalDir, { recursive: true });
  const lock = join(globalDir, "manifest.lock");
  let held = false;
  for (let waited = 0; waited <= 10_000; waited += 25) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break;
      try {
        const pid = Number(readFileSync(lock, "utf8").trim());
        const old = Date.now() - statSync(lock).mtimeMs > 30_000;
        if (old || !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) rmSync(lock, { force: true });
        else sleepMs(25);
      } catch {
        /* lock vanished between the calls: retry */
      }
    }
  }
  try {
    return fn();
  } finally {
    if (held) rmSync(lock, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Diff: what did a write add to a file?
// ---------------------------------------------------------------------------

export interface ChangeSummary {
  readonly keys: string[];
  readonly added: Added[];
  readonly removed: string[][];
  readonly removedToml: string[];
}

type Json = unknown;

function isObj(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function itemLabel(v: Json): string {
  const s = JSON.stringify(v);
  const m = /hook --host \w+/.exec(s);
  return m ? m[0] : s.length > 48 ? `${s.slice(0, 45)}...` : s;
}

function addKey(out: ChangeSummary, path: string[], value: Json): void {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      out.added.push({ kind: "item", path, value: item });
      out.keys.push(`${path.join(".")}[+] ${itemLabel(item)}`);
    });
    if (value.length === 0) {
      out.added.push({ kind: "key", path });
      out.keys.push(path.join("."));
    }
    return;
  }
  if (isObj(value) && path.length < 2 && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) addKey(out, [...path, k], v);
    return;
  }
  out.added.push({ kind: "key", path });
  out.keys.push(path.join("."));
}

function jsonDiff(out: ChangeSummary, before: Json, after: Json, path: string[]): void {
  if (isObj(after) && isObj(before)) {
    for (const [k, v] of Object.entries(after)) {
      if (!(k in before)) addKey(out, [...path, k], v);
      else jsonDiff(out, before[k], v, [...path, k]);
    }
    for (const k of Object.keys(before)) if (!(k in after)) out.removed.push([...path, k]);
    return;
  }
  if (Array.isArray(after) && Array.isArray(before)) {
    for (const item of after) {
      if (!before.some((b) => deepEqual(b, item))) {
        out.added.push({ kind: "item", path, value: item });
        out.keys.push(`${path.join(".")}[+] ${itemLabel(item)}`);
      }
    }
    return;
  }
  if (!deepEqual(before, after)) {
    // A value KYA replaced (--force): undo restores it from the backup.
    out.added.push({ kind: "key", path });
    out.keys.push(`${path.join(".")} (replaced)`);
  }
}

const TOML_HEADER = /^[^\S\n]*(\[\[?)\s*([^\]\n]+?)\s*\]\]?[^\S\n]*(?:#.*)?$/gm;

export function tomlHeaders(text: string): { array: boolean; name: string; body: string; start: number; end: number }[] {
  const out: { array: boolean; name: string; body: string; start: number; end: number }[] = [];
  const matches = [...text.matchAll(TOML_HEADER)];
  matches.forEach((m, i) => {
    const end = i + 1 < matches.length ? matches[i + 1]!.index : text.length;
    out.push({ array: m[1] === "[[", name: m[2]!, body: text.slice(m.index, end), start: m.index, end });
  });
  return out;
}

export function diffChange(path: string, before: string | undefined, after: string): ChangeSummary {
  const out: ChangeSummary = { keys: [], added: [], removed: [], removedToml: [] };
  if (path.endsWith(".json")) {
    try {
      const a = JSON.parse(after) as Json;
      let b: Json = {};
      if (before !== undefined) b = JSON.parse(before) as Json;
      jsonDiff(out, b, a, []);
      return out;
    } catch {
      /* not JSON after all: fall through to text */
    }
  }
  if (path.endsWith(".toml")) {
    const prior = new Set(tomlHeaders(before ?? "").map((h) => `${h.array}:${h.name}`));
    const now = new Set(tomlHeaders(after).map((h) => `${h.array}:${h.name}`));
    for (const h of tomlHeaders(before ?? "")) if (!h.array && !now.has(`false:${h.name}`)) out.removedToml.push(h.name);
    for (const h of tomlHeaders(after)) {
      if (prior.has(`${h.array}:${h.name}`) && !h.array) continue;
      if (h.array) {
        const id = /hook --host \w+/.exec(h.body)?.[0];
        if (id && !(before ?? "").includes(id)) {
          out.added.push({ kind: "toml-hook", identity: id });
          out.keys.push(`[[${h.name}]] ${id}`);
        }
      } else {
        out.added.push({ kind: "toml-table", name: h.name });
        out.keys.push(`[${h.name}]`);
      }
    }
    return out;
  }
  const beforeLines = new Set((before ?? "").split("\n"));
  for (const line of after.split("\n")) {
    if (line.trim() === "" || beforeLines.has(line)) continue;
    if (basename(path) === ".gitignore") {
      out.added.push({ kind: "line", text: line });
      out.keys.push(line);
    }
  }
  if (before === undefined && out.keys.length === 0) out.keys.push("(new file)");
  return out;
}

// ---------------------------------------------------------------------------
// Recording a run
// ---------------------------------------------------------------------------

export interface RecordContext {
  readonly globalDir: string;
  /** Project root of this run (scope "project" for paths under it). */
  readonly cwd: string;
}

type PathMod = Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "sep">;

function underDir(path: string, dir: string, p: PathMod = nodePath): boolean {
  const r = p.relative(p.resolve(dir), p.resolve(path));
  return r === "" || (r !== ".." && !r.startsWith(`..${p.sep}`) && !p.isAbsolute(r));
}

/**
 * Whether a write belongs in the manifest. KYA's own state (trail, receipts, telemetry,
 * report server files) is data, not wiring: only .kya/config.json in a project and
 * bin/ + gateways.json in the global dir count. `p` is a test seam (path.win32).
 */
export function isTracked(path: string, ctx: RecordContext, p: PathMod = nodePath): boolean {
  const abs = p.resolve(path);
  const g = p.resolve(ctx.globalDir);
  if (underDir(abs, g, p)) {
    const r = p.relative(g, abs);
    return r.startsWith(`bin${p.sep}`) || r === "gateways.json";
  }
  const k = p.resolve(ctx.cwd, ".kya");
  if (underDir(abs, k, p)) return p.relative(k, abs) === "config.json";
  return true;
}

/** Where a first-touch backup of `path` goes. Mode 0600: host configs can hold tokens. */
export function makeBackupWriter(globalDir: string, stamp: string): (path: string, before: Buffer | undefined) => string | undefined {
  let n = 0;
  return (path, before) => {
    if (before === undefined) return undefined;
    const dir = join(globalDir, "undo", stamp);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${String(++n).padStart(3, "0")}-${basename(path)}`);
    writeFileSync(file, before, { mode: 0o600 });
    return file;
  };
}

/** realpath of the parent plus the file name: what the path must still resolve to at undo time. */
export function resolvedOf(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

interface RecordState {
  /** Entries as they were when this run started (or when another run's entry for a path was first seen). */
  readonly base: Map<string, ManifestEntry>;
  readonly owned: Set<string>;
  readonly backups: Map<string, string>;
}

function dedupeAdded(list: Added[]): Added[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = JSON.stringify(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Fold the journal into the manifest under the manifest lock. Safe to call after every write: the result
 * depends only on the run-start entries and the journal, never on this run's earlier commits. Paths already
 * in the manifest keep their original action and backup; their sha256 and changes are refreshed.
 */
function commit(journal: WriteJournal, ctx: RecordContext, st: RecordState): void {
  const touched = journal.touched().filter((t) => isTracked(t.path, ctx));
  if (touched.length === 0 && journal.dirs.length === 0) return;
  withManifestLock(ctx.globalDir, () => {
    const cur = readManifest(ctx.globalDir);
    const entries = new Map(cur.entries.map((e) => [e.path, e] as const));
    for (const t of touched) {
      if (!st.owned.has(t.path)) {
        st.owned.add(t.path);
        const other = entries.get(t.path);
        if (!st.base.has(t.path) && other) {
          // Another kya run recorded this path first: its backup is the original; ours is redundant.
          st.base.set(t.path, other);
          const mine = st.backups.get(t.path);
          if (mine) {
            rmSync(mine, { force: true });
            st.backups.delete(t.path);
          }
        }
      }
      const prev = st.base.get(t.path);
      const change = diffChange(t.path, t.before?.toString("utf8"), t.after.toString("utf8"));
      const inProject = underDir(t.path, ctx.cwd);
      const editedSince =
        prev !== undefined &&
        (t.before !== undefined ? sha256(t.before) !== prev.sha256 : prev.action === "merged");
      const removedToml = [...new Set([...(prev?.removedToml ?? []), ...change.removedToml])];
      const next: ManifestEntry = prev
        ? {
            ...prev,
            ...(editedSince || prev.stale ? { stale: true } : {}),
            keys: [...new Set([...prev.keys, ...change.keys])],
            added: dedupeAdded([...prev.added, ...change.added]),
            removed: [...prev.removed, ...change.removed],
            ...(removedToml.length ? { removedToml } : {}),
            resolved: resolvedOf(t.path),
            sha256: sha256(t.after),
            at: new Date().toISOString(),
          }
        : {
            path: t.path,
            action: t.before === undefined ? "created" : "merged",
            scope: inProject ? "project" : "home",
            ...(inProject ? { project: nodePath.resolve(ctx.cwd) } : {}),
            keys: change.keys,
            added: change.added,
            removed: change.removed,
            ...(change.removedToml.length ? { removedToml: change.removedToml } : {}),
            ...(st.backups.get(t.path) ? { backup: st.backups.get(t.path)! } : {}),
            resolved: resolvedOf(t.path),
            sha256: sha256(t.after),
            at: new Date().toISOString(),
          };
      entries.set(t.path, next);
    }
    writeManifest(ctx.globalDir, {
      version: 1,
      entries: [...entries.values()],
      dirs: [...new Set([...cur.dirs, ...journal.dirs])],
    });
  });
}

/**
 * A live journal that backs up first-touched files and commits the manifest after every recorded write
 * (before the write lands), so an interrupted start still leaves a manifest `kya uninstall` can use.
 */
export function liveJournal(ctx: RecordContext): { journal: WriteJournal; finish: () => void } {
  const backups = new Map<string, string>();
  const writer = makeBackupWriter(ctx.globalDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  const base = new Map(readManifest(ctx.globalDir).entries.map((e) => [e.path, e] as const));
  const st: RecordState = { base, owned: new Set(), backups };
  const holder: { journal?: WriteJournal } = {};
  const journal = new WriteJournal(
    false,
    (path, before) => {
      if (base.has(path) || !isTracked(path, ctx)) return; // original already backed up by an earlier run
      const file = writer(path, before);
      if (file) backups.set(path, file);
    },
    () => commit(holder.journal!, ctx, st),
  );
  holder.journal = journal;
  return { journal, finish: () => commit(journal, ctx, st) };
}
