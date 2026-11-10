/**
 * Trail rotation (issue #641): trail.jsonl is renamed to trail.1.jsonl at TRAIL_ROTATE_BYTES, reads
 * fill the 1 MB view from the archive after a rotation, and parallel `kya hook` processes lose no
 * event across a rotation. The real-process case spawns dist/cli.js (`npm run build` first).
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendTrail,
  archivedTrailPath,
  globalTrailPath,
  MAX_TRAIL_BYTES,
  readTrail,
  rotateTrailIfNeeded,
  TRAIL_ROTATE_BYTES,
  trailScanPaths,
  trailTruncated,
} from "../src/trail.js";

const homes: string[] = [];
afterAll(() => {
  for (const d of homes) rmSync(d, { recursive: true, force: true });
});

function home(): NodeJS.ProcessEnv {
  const d = mkdtempSync(join(tmpdir(), "kya-rotate-"));
  homes.push(d);
  mkdirSync(join(d, ".kya"), { recursive: true });
  return { KYA_HOME: d };
}

const row = (sessionId: string, i: number) =>
  `${JSON.stringify({ ts: new Date(Date.UTC(2026, 10, 1, 0, 0, i % 60)).toISOString(), sessionId, toolId: "Read", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline", summary: `row ${i}`.padEnd(300, ".") })}\n`;

/** Writes whole rows until the file is at least `bytes` long. */
function seed(path: string, bytes: number, sessionId = "seed"): number {
  const parts: string[] = [];
  let size = 0;
  let n = 0;
  while (size < bytes) {
    const r = row(sessionId, n++);
    parts.push(r);
    size += Buffer.byteLength(r);
  }
  writeFileSync(path, parts.join(""));
  return n;
}

const live = (env: NodeJS.ProcessEnv) => globalTrailPath(env);
const archive = (env: NodeJS.ProcessEnv) => archivedTrailPath(env);
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []);
const event = { ts: "2026-11-10T10:00:00.000Z", sessionId: "new", toolId: "Bash", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" } as const;

describe("rotateTrailIfNeeded", () => {
  it("leaves a file under the limit alone", () => {
    const env = home();
    seed(live(env), 1024);
    expect(rotateTrailIfNeeded(env)).toBe(false);
    expect(existsSync(archive(env))).toBe(false);
  });

  it("does nothing when there is no trail yet", () => {
    expect(rotateTrailIfNeeded(home())).toBe(false);
  });

  it("appendTrail moves a full file to the archive and starts a new one", () => {
    const env = home();
    const n = seed(live(env), TRAIL_ROTATE_BYTES);
    appendTrail("/tmp/proj", event, env);
    expect(lines(archive(env))).toHaveLength(n);
    const now = lines(live(env));
    expect(now).toHaveLength(1);
    expect(JSON.parse(now[0]!).sessionId).toBe("new");
    expect(existsSync(join(env.KYA_HOME!, ".kya", "trail.rotate.lock"))).toBe(false);
  });

  it("replaces the old archive at the next rotation (one archive kept)", () => {
    const env = home();
    seed(archive(env), 2048, "oldest");
    seed(live(env), TRAIL_ROTATE_BYTES, "middle");
    expect(rotateTrailIfNeeded(env)).toBe(true);
    expect(lines(archive(env)).every((l) => JSON.parse(l).sessionId === "middle")).toBe(true);
    expect(existsSync(live(env))).toBe(false);
  });

  it("does not rotate while another process holds a fresh lock", () => {
    const env = home();
    seed(live(env), TRAIL_ROTATE_BYTES);
    writeFileSync(join(env.KYA_HOME!, ".kya", "trail.rotate.lock"), "");
    expect(rotateTrailIfNeeded(env)).toBe(false);
    expect(existsSync(archive(env))).toBe(false);
  });

  it("takes over a stale lock left by a killed process", () => {
    const env = home();
    seed(live(env), TRAIL_ROTATE_BYTES);
    const lock = join(env.KYA_HOME!, ".kya", "trail.rotate.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(rotateTrailIfNeeded(env)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("reading across a rotation", () => {
  it("fills the 1 MB view from the archive when the live file is small", () => {
    const env = home();
    seed(archive(env), 2 * MAX_TRAIL_BYTES, "archived");
    appendFileSync(live(env), `${JSON.stringify({ ...event, sessionId: "live" })}\n`);
    const events = readTrail("/tmp/proj", env);
    expect(events.at(-1)!.sessionId).toBe("live");
    expect(events.filter((e) => e.sessionId === "archived").length).toBeGreaterThan(1000);
    const bytes = events.reduce((s, e) => s + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(MAX_TRAIL_BYTES);
  });

  it("reads the archive alone when the live file does not exist yet", () => {
    const env = home();
    seed(archive(env), 4096, "archived");
    expect(readTrail("/tmp/proj", env).every((e) => e.sessionId === "archived")).toBe(true);
    expect(readTrail("/tmp/proj", env).length).toBeGreaterThan(0);
  });

  it("does not touch the archive when the live file fills the view", () => {
    const env = home();
    seed(archive(env), 4096, "archived");
    seed(live(env), 2 * MAX_TRAIL_BYTES, "live");
    expect(readTrail("/tmp/proj", env).some((e) => e.sessionId === "archived")).toBe(false);
  });

  it("trailTruncated is true once an archive exists", () => {
    const env = home();
    appendFileSync(live(env), row("live", 1));
    expect(trailTruncated("/tmp/proj", env)).toBe(false);
    seed(archive(env), 4096);
    expect(trailTruncated("/tmp/proj", env)).toBe(true);
  });

  it("trailScanPaths lists the archive before the live file, existing files only", () => {
    const env = home();
    expect(trailScanPaths(env)).toEqual([]);
    appendFileSync(live(env), row("live", 1));
    seed(archive(env), 100);
    expect(trailScanPaths(env)).toEqual([archive(env), live(env)]);
  });
});

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");

function hook(env: NodeJS.ProcessEnv, i: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliJs, "hook", "--host", "claude"], {
      env: { ...process.env, ...env, KYA_TELEMETRY: "0", DO_NOT_TRACK: "1", KYA_IOC_SCAN: "0" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("exit", (code) => resolve(code));
    child.stdin.end(
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: `par-${i}`, tool_name: "Read", tool_input: { file_path: `/tmp/f${i}` } }),
    );
  });
}

describe.skipIf(!existsSync(cliJs))("parallel kya hook processes across a rotation (real processes)", () => {
  it("loses no event and keeps exactly one archive", async () => {
    const env = home();
    // Just under the limit: the first appends cross it, the rest race the rename.
    const seeded = seed(live(env), TRAIL_ROTATE_BYTES - 2000);
    const N = 12;
    const codes = await Promise.all(Array.from({ length: N }, (_, i) => hook(env, i)));
    expect(codes.every((c) => c === 0)).toBe(true);
    const all = [...lines(archive(env)), ...lines(live(env))];
    const ids = new Set(all.map((l) => JSON.parse(l).sessionId));
    for (let i = 0; i < N; i++) expect(ids.has(`par-${i}`)).toBe(true);
    expect(all.filter((l) => JSON.parse(l).sessionId === "seed")).toHaveLength(seeded);
    expect(statSync(live(env)).size).toBeLessThan(TRAIL_ROTATE_BYTES);
  }, 60_000);
});
