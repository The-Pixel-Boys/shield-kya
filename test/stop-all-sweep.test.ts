/**
 * `kya stop --all` ends every receipt-serve daemon of this user, in both
 * forms (`node cli.js receipt-serve` and `kya receipt-serve` through a bin
 * link), and never a look-alike process. Real processes and real ps; the
 * process list is narrowed to the pids this test spawned, so no process of
 * the owner is ever signaled. Spawns dist/cli.js - run `pnpm build` first.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findReceiptDaemonPids,
  listOwnedProcesses,
  pidAlive,
} from "../src/receipt/daemon.js";
import { runStop } from "../src/commands/stop.js";

const root = join(import.meta.dirname, "..");
const cliJs = join(root, "dist", "cli.js");
const children: ChildProcess[] = [];
const dirs: string[] = [];

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

async function waitForState(cwd: string, ms = 15_000): Promise<number> {
  const path = join(cwd, ".kya", "receipt-server.json");
  for (let t = 0; t < ms; t += 100) {
    if (existsSync(path)) {
      try {
        return (JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid;
      } catch {
        /* partially written - retry */
      }
    }
    await sleep(100);
  }
  throw new Error(`no state file at ${path}`);
}

function daemonEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    KYA_HOME: home,
    KYA_NO_BROWSER: "1",
    KYA_NODE_CHECKED: "1",
    KYA_SKIP_NODE_CHECK: "1",
    KYA_SEARCH_INDEX: join(home, "index.json"),
    KYA_RECEIPT_IDLE_MINUTES: "0",
  };
  return env;
}

describe("kya stop --all sweeps receipt-serve daemons only", () => {
  it(
    "ends a cli.js daemon and a kya-linked daemon from two project dirs, touches nothing else",
    async () => {
      const home = tempDir("kya-sweep-home-");
      const cwdA = tempDir("kya-sweep-a-");
      const cwdB = tempDir("kya-sweep-b-");
      const binDir = join(tempDir("kya-sweep-bin-"), "bin");
      mkdirSync(binDir, { recursive: true });
      const kyaLink = join(binDir, "kya");
      symlinkSync(cliJs, kyaLink);
      const savedHome = process.env.KYA_HOME;
      process.env.KYA_HOME = home;

      const daemonA = spawn(process.execPath, [cliJs, "receipt-serve", "--days", "1"], {
        cwd: cwdA,
        env: daemonEnv(home),
        stdio: "ignore",
      });
      children.push(daemonA);
      const daemonB = spawn(process.execPath, [kyaLink, "receipt-serve", "--days", "1"], {
        cwd: cwdB,
        env: daemonEnv(home),
        stdio: "ignore",
      });
      children.push(daemonB);
      try {
        const pidA = await waitForState(cwdA);
        const pidB = await waitForState(cwdB);
        expect(pidA).toBe(daemonA.pid);
        expect(pidB).toBe(daemonB.pid);

        // Phase 1: both daemons running; the sweep from cwd A must end both.
        const owned = listOwnedProcesses();
        const mine = new Set([pidA, pidB]);
        const procs = owned.filter((p) => mine.has(p.pid));
        expect(procs.map((p) => p.pid).sort()).toEqual([pidA, pidB].sort());
        expect(findReceiptDaemonPids(procs).sort()).toEqual([pidA, pidB].sort());

        const first = await runStop(cwdA, { all: true, procs });
        expect(first.stopped).toBe(true);
        expect(first.pid).toBe(pidA);
        expect(first.extraStopped).toEqual([pidB]);
        expect(await waitForExit(daemonA, 10_000)).toBe(true);
        expect(await waitForExit(daemonB, 10_000)).toBe(true);
        expect(pidAlive(pidB)).toBe(false);

        // Phase 2: a look-alike with the same argv shape must survive a sweep.
        // argv0 "kya" with the subcommand not in the first position, and a
        // token that only starts with receipt-serve.
        const lookalike = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)", "receipt-serve-not", "x", "receipt-serve"],
          { argv0: "kya", stdio: "ignore" },
        );
        children.push(lookalike);
        await sleep(300);
        const decoy = listOwnedProcesses().filter((p) => p.pid === lookalike.pid);
        expect(decoy).toHaveLength(1);
        expect(decoy[0]!.args).toContain("receipt-serve-not");
        expect(findReceiptDaemonPids(decoy)).toEqual([]);

        const second = await runStop(cwdA, { all: true, procs: decoy });
        expect(second.stopped).toBe(false);
        expect(second.extraStopped).toEqual([]);
        expect(hasExited(lookalike)).toBe(false);
        expect(pidAlive(lookalike.pid!)).toBe(true);
      } finally {
        for (const child of children) {
          if (!hasExited(child)) child.kill("SIGKILL");
        }
        if (savedHome === undefined) delete process.env.KYA_HOME;
        else process.env.KYA_HOME = savedHome;
      }
    },
    60_000,
  );
});
