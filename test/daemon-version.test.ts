/**
 * Daemon version handshake: /healthz carries the package version, and
 * ensureReceiptDaemon refuses to reuse a daemon reporting a different (or
 * no) version — it stops the stale one and respawns. Also covers
 * `kya stop --all` sweeping orphaned receipt daemons beyond the cwd state
 * file. Daemon tests spawn dist/cli.js — run `pnpm build` first.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import {
  ensureReceiptDaemon,
  findReceiptDaemonPids,
  pidAlive,
  readDaemonState,
  writeDaemonState,
} from "../src/receipt/daemon.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import { formatStopHuman, runStop } from "../src/commands/stop.js";
import { CLI_VERSION } from "../src/version.js";

let dir: string;
let config: ResolvedConfig;
const children: ChildProcess[] = [];
const daemonPids: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-daemonver-"));
  config = resolveConfig({
    cwd: dir,
    offline: true,
    allowMissingApiKey: true,
    env: { KYA_OFFLINE: "1" },
    flags: { offline: true },
  });
});

afterEach(async () => {
  for (const pid of daemonPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 150));
  rmSync(dir, { recursive: true, force: true });
});

const fixture = join(import.meta.dirname, "fixtures", "fake-old-daemon.mjs");

interface FakeDaemon {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly url: string;
}

/** Spawn a stand-in "old install" daemon and publish its state file. */
function startFakeOldDaemon(env: { FAKE_VERSION?: string } = {}): Promise<FakeDaemon> {
  const token = `fake-token-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { FAKE_TOKEN: token, ...env },
    });
    children.push(child);
    let buf = "";
    const timer = setTimeout(() => reject(new Error("fake daemon did not listen")), 10_000);
    child.stdout!.on("data", (d) => {
      buf += String(d);
      const m = /PORT (\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        const port = Number(m[1]);
        const url = `http://127.0.0.1:${port}/?t=${token}`;
        writeDaemonState(dir, {
          pid: child.pid!,
          url,
          token,
          port,
          startedAt: new Date().toISOString(),
        });
        resolve({ child, pid: child.pid!, port, token, url });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitDead(pid: number): Promise<void> {
  for (let waited = 0; waited < 3_000 && pidAlive(pid); waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("/healthz version payload", () => {
  it("reports the package version in the token-gated handshake", async () => {
    const live = await startLiveReceiptServer({ config, days: 3 });
    try {
      const res = await fetch(`http://127.0.0.1:${live.port}/healthz?t=${live.token}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; version?: string };
      expect(body.ok).toBe(true);
      expect(body.version).toBe(CLI_VERSION);
    } finally {
      await live.close();
    }
  });
});

describe("ensureReceiptDaemon — stale version is replaced, not reused", () => {
  it("stops a pre-0.4.1 daemon (no version in /healthz) and spawns a fresh one", async () => {
    const old = await startFakeOldDaemon();
    const handle = await ensureReceiptDaemon(config, { days: 3 });
    daemonPids.push(handle.pid);
    expect(handle.reused).toBe(false);
    expect(handle.pid).not.toBe(old.pid);
    await waitDead(old.pid);
    expect(pidAlive(old.pid)).toBe(false);
    expect(pidAlive(handle.pid)).toBe(true);
    expect(readDaemonState(dir)?.pid).toBe(handle.pid);
  }, 20_000);

  it("stops a daemon reporting a different version and spawns a fresh one", async () => {
    const old = await startFakeOldDaemon({ FAKE_VERSION: "0.2.0" });
    const handle = await ensureReceiptDaemon(config, { days: 3 });
    daemonPids.push(handle.pid);
    expect(handle.reused).toBe(false);
    expect(handle.pid).not.toBe(old.pid);
    await waitDead(old.pid);
    expect(pidAlive(old.pid)).toBe(false);
  }, 20_000);

  it("reuses a running daemon whose version matches", async () => {
    const first = await ensureReceiptDaemon(config, { days: 3 });
    daemonPids.push(first.pid);
    expect(first.reused).toBe(false);
    const second = await ensureReceiptDaemon(config, { days: 3 });
    expect(second.reused).toBe(true);
    expect(second.pid).toBe(first.pid);
    expect(second.url).toBe(first.url);
  }, 20_000);
});

describe("findReceiptDaemonPids", () => {
  it("matches cli.js receipt-serve command lines, nothing else", () => {
    const procs = [
      { pid: 100, args: "node /usr/local/lib/node_modules/@shield-agent/kya/dist/cli.js receipt-serve --days 3" },
      { pid: 101, args: "node /opt/homebrew/bin/cli.js receipt-serve --days 7" },
      { pid: 102, args: "node /usr/local/lib/node_modules/@shield-agent/kya/dist/cli.js stop" },
      { pid: 103, args: "node server.js" },
      { pid: 104, args: "vim receipt-serve-notes.txt" },
      { pid: 105, args: "vim cli.js receipt-serve-notes.txt" },
      { pid: 106, args: "node cli.js receipt-serve-old" },
    ];
    expect(findReceiptDaemonPids(procs)).toEqual([100, 101]);
  });
});

describe("kya stop --all", () => {
  it("stops every matched daemon and reports each pid", async () => {
    const killed: number[] = [];
    const procs = [
      { pid: 987001, args: "node /a/kya/dist/cli.js receipt-serve --days 3" },
      { pid: 987002, args: "node /b/kya/dist/cli.js receipt-serve --days 3" },
      { pid: 987003, args: "node /a/kya/dist/cli.js serve-mcp" },
    ];
    const res = await runStop(dir, {
      all: true,
      procs,
      kill: (pid) => {
        killed.push(pid);
      },
    });
    expect(res.stopped).toBe(false); // no state-file daemon in this cwd
    expect(res.extraStopped).toEqual([987001, 987002]);
    expect(killed).toEqual([987001, 987002]);
    const out = formatStopHuman(res);
    expect(out).toContain("pid 987001");
    expect(out).toContain("pid 987002");
    expect(out).not.toContain("pid 987003");
  });

  it("reports cleanly when nothing matches", async () => {
    const res = await runStop(dir, {
      all: true,
      procs: [{ pid: 987004, args: "node server.js" }],
      kill: () => {
        throw new Error("must not be called");
      },
    });
    expect(res.stopped).toBe(false);
    expect(res.extraStopped).toEqual([]);
    const out = formatStopHuman(res);
    expect(out).toContain("no report server running");
    expect(out).toContain("no other receipt daemons");
  });

  it("default stop without --all leaves other daemons alone", async () => {
    const res = await runStop(dir, {
      procs: [{ pid: 987005, args: "node /a/cli.js receipt-serve --days 3" }],
      kill: () => {
        throw new Error("must not be called");
      },
    });
    expect(res.stopped).toBe(false);
    expect(res.extraStopped).toBeUndefined();
    expect(formatStopHuman(res)).toBe("no report server running");
  });

  it("win32: --all says the sweep is unsupported instead of claiming none run", async () => {
    const res = await runStop(dir, {
      all: true,
      platform: "win32",
      procs: [{ pid: 987010, args: "node C:\\kya\\dist\\cli.js receipt-serve --days 3" }],
      kill: () => {
        throw new Error("must not be called");
      },
    });
    expect(res.stopped).toBe(false);
    expect(res.extraStopped).toEqual([]);
    expect(res.sweepUnsupported).toBe(true);
    const out = formatStopHuman(res);
    expect(out).toContain("not supported");
    expect(out).toContain("win32");
    expect(out).not.toContain("no other receipt daemons running");
  });
});
