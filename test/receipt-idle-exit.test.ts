/**
 * The report daemon exits by itself: after KYA_RECEIPT_IDLE_MINUTES with no
 * open request (an SSE stream counts as one), and once its project dir is
 * gone. Spawns dist/cli.js - run `pnpm build` first. Every daemon is killed
 * in afterEach if the test did not end it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { receiptIdleMs } from "../src/commands/receipt-serve.js";
import { pidAlive } from "../src/receipt/daemon.js";

const root = join(import.meta.dirname, "..");
const cliJs = join(root, "dist", "cli.js");
const SHORT_IDLE = "0.03"; // 1.8 s
const children: ChildProcess[] = [];
const dirs: string[] = [];

interface DaemonState {
  readonly pid: number;
  readonly url: string;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function daemonEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    KYA_HOME: home,
    KYA_NO_BROWSER: "1",
    KYA_NODE_CHECKED: "1",
    KYA_SKIP_NODE_CHECK: "1",
    KYA_SEARCH_INDEX: join(home, "index.json"),
  };
  delete env.KYA_RECEIPT_IDLE_MINUTES;
  delete env.KYA_RECEIPT_CWD_POLL_MS;
  return { ...env, ...extra };
}

function spawnDaemon(cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, [cliJs, "receipt-serve", "--days", "1"], {
    cwd,
    env,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 100) {
    if (hasExited(child)) return true;
    await sleep(100);
  }
  return hasExited(child);
}

async function waitForState(cwd: string, ms = 15_000): Promise<DaemonState> {
  const path = join(cwd, ".kya", "receipt-server.json");
  for (let t = 0; t < ms; t += 100) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as DaemonState;
      } catch {
        /* partially written - retry */
      }
    }
    await sleep(100);
  }
  throw new Error(`no state file at ${path}`);
}

function withToken(state: DaemonState, path: string): URL {
  const url = new URL(path, state.url);
  url.search = new URL(state.url).search;
  return url;
}

describe("receiptIdleMs", () => {
  it("defaults to 30 minutes when unset, empty, invalid or negative", () => {
    for (const raw of [undefined, "", "abc", "-3", "Infinity"]) {
      const env = raw === undefined ? {} : { KYA_RECEIPT_IDLE_MINUTES: raw };
      expect(receiptIdleMs(env)).toBe(30 * 60_000);
    }
  });

  it("never closes for 0 or off", () => {
    for (const raw of ["0", "0.0", "off", " OFF "]) {
      expect(receiptIdleMs({ KYA_RECEIPT_IDLE_MINUTES: raw })).toBeUndefined();
    }
  });

  it("takes fractional minutes and clamps to the 32-bit timer limit", () => {
    expect(receiptIdleMs({ KYA_RECEIPT_IDLE_MINUTES: "0.5" })).toBe(30_000);
    expect(receiptIdleMs({ KYA_RECEIPT_IDLE_MINUTES: "2" })).toBe(120_000);
    expect(receiptIdleMs({ KYA_RECEIPT_IDLE_MINUTES: "99999999" })).toBe(2_147_483_647);
  });
});

describe("report daemon exits by itself", () => {
  it(
    "exits after the idle minutes with no request",
    async () => {
      const cwd = tempDir("kya-idle-");
      const home = tempDir("kya-idle-home-");
      const child = spawnDaemon(
        cwd,
        daemonEnv(home, { KYA_RECEIPT_IDLE_MINUTES: SHORT_IDLE, KYA_RECEIPT_CWD_POLL_MS: "600000" }),
      );
      await waitForState(cwd);
      const started = Date.now();
      expect(await waitForExit(child, 15_000)).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_200);
      expect(existsSync(join(cwd, ".kya", "receipt-server.json"))).toBe(false);
    },
    30_000,
  );

  it(
    "an open SSE stream keeps it alive; closing the stream starts the idle count",
    async () => {
      const cwd = tempDir("kya-idle-sse-");
      const home = tempDir("kya-idle-home-");
      const child = spawnDaemon(
        cwd,
        daemonEnv(home, { KYA_RECEIPT_IDLE_MINUTES: SHORT_IDLE, KYA_RECEIPT_CWD_POLL_MS: "600000" }),
      );
      const state = await waitForState(cwd);
      const abort = new AbortController();
      const stream = await fetch(withToken(state, "/events"), { signal: abort.signal });
      expect(stream.status).toBe(200);
      await sleep(4_000); // more than two idle periods
      expect(hasExited(child)).toBe(false);
      abort.abort();
      expect(await waitForExit(child, 12_000)).toBe(true);
    },
    40_000,
  );

  it(
    "a request resets the idle count",
    async () => {
      const cwd = tempDir("kya-idle-req-");
      const home = tempDir("kya-idle-home-");
      const child = spawnDaemon(
        cwd,
        daemonEnv(home, { KYA_RECEIPT_IDLE_MINUTES: "0.05", KYA_RECEIPT_CWD_POLL_MS: "600000" }),
      ); // 3 s
      const state = await waitForState(cwd);
      for (let i = 0; i < 6; i++) {
        const res = await fetch(withToken(state, "/healthz"));
        expect(res.status).toBe(200);
        await res.arrayBuffer();
        await sleep(1_000);
      }
      expect(hasExited(child)).toBe(false);
      expect(await waitForExit(child, 12_000)).toBe(true);
    },
    40_000,
  );

  it(
    "exits when its project dir is removed, and not before",
    async () => {
      const cwd = tempDir("kya-cwd-");
      const home = tempDir("kya-idle-home-");
      const child = spawnDaemon(
        cwd,
        daemonEnv(home, { KYA_RECEIPT_IDLE_MINUTES: "0", KYA_RECEIPT_CWD_POLL_MS: "200" }),
      );
      await waitForState(cwd);
      await sleep(3_000); // past the 2 s force-close timer in closeAll
      expect(hasExited(child)).toBe(false);
      rmSync(cwd, { recursive: true, force: true });
      expect(await waitForExit(child, 10_000)).toBe(true);
    },
    40_000,
  );

  it(
    "KYA_RECEIPT_IDLE_MINUTES=0 never exits on idle",
    async () => {
      const cwd = tempDir("kya-never-");
      const home = tempDir("kya-idle-home-");
      const child = spawnDaemon(
        cwd,
        daemonEnv(home, { KYA_RECEIPT_IDLE_MINUTES: "0", KYA_RECEIPT_CWD_POLL_MS: "600000" }),
      );
      await waitForState(cwd);
      await sleep(3 * 1_800 + 500); // three short idle periods
      expect(hasExited(child)).toBe(false);
    },
    40_000,
  );

  it(
    "kya start after an idle exit starts a fresh daemon",
    async () => {
      const cwd = tempDir("kya-restart-");
      const home = tempDir("kya-restart-home-");
      const env = daemonEnv(home, { KYA_RECEIPT_IDLE_MINUTES: SHORT_IDLE, KYA_RECEIPT_CWD_POLL_MS: "600000" });
      const statePath = join(cwd, ".kya", "receipt-server.json");
      const runCli = (args: string[]): Promise<{ code: number | null; stdout: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [cliJs, ...args], { cwd, env });
          let stdout = "";
          child.stdout.on("data", (d) => (stdout += String(d)));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout }));
        });

      try {
        const first = await runCli(["start"]);
        expect(first.code).toBe(0);
        const oldPid = (JSON.parse(readFileSync(statePath, "utf8")) as { pid: number }).pid;

        let gone = false;
        for (let t = 0; t < 150 && !gone; t++) {
          gone = !pidAlive(oldPid);
          if (!gone) await sleep(100);
        }
        expect(gone).toBe(true);
        expect(existsSync(statePath)).toBe(false);

        const second = await runCli(["start"]);
        expect(second.code).toBe(0);
        expect(second.stdout).not.toContain("already running");
        const fresh = JSON.parse(readFileSync(statePath, "utf8")) as { pid: number; url: string };
        expect(fresh.pid).not.toBe(oldPid);
        expect(pidAlive(fresh.pid)).toBe(true);
        const res = await fetch(withToken(fresh, "/healthz"));
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      } finally {
        const leftover = existsSync(statePath)
          ? (JSON.parse(readFileSync(statePath, "utf8")) as { pid: number }).pid
          : undefined;
        if (leftover !== undefined && pidAlive(leftover)) process.kill(leftover, "SIGTERM");
      }
    },
    60_000,
  );
});
