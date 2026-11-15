/**
 * Write journal: while one is active, every atomic file write (fs-atomic) is
 * recorded with the bytes before and after. A dry journal records and writes
 * nothing, so `kya start --dry-run` shows the exact plan the real run would
 * apply. A live journal feeds ~/.kya/manifest.json (see manifest.ts).
 *
 * One journal at a time (the CLI runs one command per process). Writers that
 * bypass fs-atomic (state files such as the trail) are not journaled on purpose.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEvent {
  readonly path: string;
  readonly before: Buffer | undefined;
  readonly after: Buffer;
}

export class WriteJournal {
  readonly events: JournalEvent[] = [];
  /** Directories this run created (top-most first per call). */
  readonly dirs: string[] = [];
  private readonly firstBefore = new Map<string, Buffer | undefined>();
  private readonly lastAfter = new Map<string, Buffer>();

  constructor(
    readonly dry: boolean,
    /** Live journal only: called once per path, before its first write (take a backup here). */
    private readonly onFirstTouch?: (path: string, before: Buffer | undefined) => void,
    /** Live journal only: called after every recorded write (before it lands) and every created directory. */
    private readonly onChange?: () => void,
  ) {}

  changed(): void {
    if (!this.dry) this.onChange?.();
  }

  record(path: string, content: string | Uint8Array): void {
    let before: Buffer | undefined;
    try {
      before = readFileSync(path);
    } catch {
      before = undefined;
    }
    const after = Buffer.from(content);
    if (!this.firstBefore.has(path)) {
      this.firstBefore.set(path, before);
      if (!this.dry) this.onFirstTouch?.(path, before);
    }
    this.lastAfter.set(path, after);
    this.events.push({ path, before, after });
    // Commit before the write lands: a crash leaves the record (and the backup) behind, never a write with none.
    this.changed();
  }

  /** One merged record per path: the bytes before the first write and after the last. */
  touched(): { path: string; before: Buffer | undefined; after: Buffer }[] {
    return [...this.lastAfter.entries()].map(([path, after]) => ({
      path,
      before: this.firstBefore.get(path),
      after,
    }));
  }
}

let current: WriteJournal | undefined;

export function activeJournal(): WriteJournal | undefined {
  return current;
}

/** True while a dry journal is active: callers skip every side effect (chmod, mkdir, spawn). */
export function journalIsDry(): boolean {
  return current?.dry === true;
}

export async function withJournal<T>(journal: WriteJournal, fn: () => T | Promise<T>): Promise<T> {
  const prev = current;
  current = journal;
  try {
    return await fn();
  } finally {
    current = prev;
  }
}

/** Run fn with no journal active (the manifest's own writes must not be journaled). */
export function withoutJournal<T>(fn: () => T): T {
  const prev = current;
  current = undefined;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** mkdir -p that is a no-op under a dry journal and records the directories it creates. */
export function journalMkdir(dir: string, mode?: number): void {
  const j = current;
  if (j?.dry) return;
  if (j) {
    const missing: string[] = [];
    for (let d = dir; !existsSync(d) && dirname(d) !== d; d = dirname(d)) missing.push(d);
    mkdirSync(dir, { recursive: true, mode });
    j.dirs.push(...missing);
    j.changed();
    return;
  }
  mkdirSync(dir, { recursive: true, mode });
}
