/**
 * The report daemon exits when its RSS passes KYA_RECEIPT_MAX_RSS_MB, so the next
 * `kya start` or `kya receipt` starts a fresh one. Spawns dist/cli.js - run
 * `pnpm build` first. Every daemon is stopped in a finally block.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { receiptMaxRssMb } from "../src/commands/receipt-serve.js";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function runDaemon(
  maxRssMb: string,
  check: (child: ChildProcess, cwd: string, stderr: () => string) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "kya-memcap-"));
  const home = mkdtempSync(join(tmpdir(), "kya-memcap-home-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    KYA_HOME: home,
    KYA_NO_BROWSER: "1",
    KYA_NODE_CHECKED: "1",
    KYA_SKIP_NODE_CHECK: "1",
    KYA_SEARCH_INDEX: join(home, "index.json"),
    KYA_RECEIPT_IDLE_MINUTES: "0",
    KYA_RECEIPT_CWD_POLL_MS: "600000",
    KYA_RECEIPT_MAX_RSS_MB: maxRssMb,
    KYA_RECEIPT_MEM_POLL_MS: "200",
  };
  const child = spawn(process.execPath, [cliJs, "receipt-serve", "--days", "1"], {
    cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (d: Buffer) => {
    err += d.toString();
  });
  try {
    await check(child, cwd, () => err);
  } finally {
    if (!exited(child)) {
      child.kill("SIGTERM");
      for (let t = 0; t < 30 && !exited(child); t++) await sleep(100);
      if (!exited(child)) child.kill("SIGKILL");
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  for (let t = 0; t < ms && !cond(); t += 100) await sleep(100);
  return cond();
}

describe("receiptMaxRssMb", () => {
  it("defaults to 512 MB when unset, empty, invalid or negative", () => {
    for (const raw of [undefined, "", "abc", "-1", "Infinity"]) {
      // KYA_HOME points at an empty dir: a search runtime installed in the real home would raise the default.
      const env: NodeJS.ProcessEnv = { KYA_HOME: join(tmpdir(), "kya-no-such-home") };
      if (raw !== undefined) env.KYA_RECEIPT_MAX_RSS_MB = raw;
      expect(receiptMaxRssMb(env)).toBe(512);
    }
  });

  it("0 turns the ceiling off; other values are used as given", () => {
    expect(receiptMaxRssMb({ KYA_RECEIPT_MAX_RSS_MB: "0" })).toBeUndefined();
    expect(receiptMaxRssMb({ KYA_RECEIPT_MAX_RSS_MB: " 256 " })).toBe(256);
  });
});

describe("report daemon memory ceiling", () => {
  it(
    "exits by itself above the ceiling, logs one line and removes its state file",
    async () => {
      await runDaemon("1", async (child, cwd, stderr) => {
        const state = join(cwd, ".kya", "receipt-server.json");
        expect(await waitFor(() => existsSync(state) || exited(child), 15_000)).toBe(true);
        expect(await waitFor(() => exited(child), 10_000)).toBe(true);
        expect(existsSync(state)).toBe(false);
        expect(stderr()).toMatch(/memory ceiling: rss \d+ MB above 1 MB, exiting/);
      });
    },
    40_000,
  );

  it(
    "stays up with the ceiling off",
    async () => {
      await runDaemon("0", async (child, cwd, stderr) => {
        const state = join(cwd, ".kya", "receipt-server.json");
        expect(await waitFor(() => existsSync(state), 15_000)).toBe(true);
        await sleep(1_500);
        expect(exited(child)).toBe(false);
        expect(existsSync(state)).toBe(true);
        expect(stderr()).not.toContain("memory ceiling");
      });
    },
    40_000,
  );
});

describe("receiptMaxRssMb default", () => {
  it("is 512 without the search runtime and 2048 with it; an explicit value wins; 0 turns it off", () => {
    const dir = mkdtempSync(join(tmpdir(), "kya-ceiling-"));
    try {
      const bare = { KYA_HOME: join(dir, "a") } as NodeJS.ProcessEnv;
      expect(receiptMaxRssMb(bare)).toBe(512);
      const sem = join(dir, "b", ".kya", "semantic", "node_modules", "@shield-agent", "fastembed");
      mkdirSync(sem, { recursive: true });
      writeFileSync(join(sem, "package.json"), "{}");
      expect(receiptMaxRssMb({ KYA_HOME: join(dir, "b") } as NodeJS.ProcessEnv)).toBe(2048);
      expect(receiptMaxRssMb({ KYA_HOME: join(dir, "b"), KYA_RECEIPT_MAX_RSS_MB: "300" } as NodeJS.ProcessEnv)).toBe(300);
      expect(receiptMaxRssMb({ KYA_HOME: join(dir, "b"), KYA_RECEIPT_MAX_RSS_MB: "0" } as NodeJS.ProcessEnv)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
