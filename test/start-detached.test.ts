/**
 * Integration: `kya start` must return the terminal while the live report
 * keeps running detached; `kya stop` must kill it. Requires `pnpm build`
 * first (spawns dist/cli.js exactly like an installed CLI would).
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const cliJs = join(root, "dist", "cli.js");

interface RunOut {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], cwd: string): Promise<RunOut> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        KYA_NO_BROWSER: "1",
        // CI/dev machines may run Node < engines; the gate is unit-tested
        // separately — keep these spawns on the detach behavior.
        KYA_SKIP_NODE_CHECK: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fetchStatus(url: string): Promise<number> {
  const res = await fetch(url);
  await res.arrayBuffer();
  return res.status;
}

describe("kya start — detached report server", () => {
  it(
    "start exits, report serves with token, stop kills it",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "kya-detach-"));
      try {
        const first = await runCli(["start"], cwd);
        expect(first.code).toBe(0);
        expect(first.stdout).toContain("report: http://127.0.0.1:");

        const url = /report: (\S+)/.exec(first.stdout)?.[1];
        expect(url).toBeTruthy();
        // Terminal returned but the server is up and token-gated.
        expect(await fetchStatus(url!)).toBe(200);
        const bare = new URL(url!);
        bare.searchParams.delete("t");
        expect(await fetchStatus(bare.toString())).toBe(401);

        const statePath = join(cwd, ".kya", "receipt-server.json");
        expect(existsSync(statePath)).toBe(true);
        const state = JSON.parse(readFileSync(statePath, "utf8")) as {
          pid: number;
          token: string;
        };
        expect(url).toContain(state.token);
        // State file carries the loopback token — must not be world-readable.
        if (process.platform !== "win32") {
          const { statSync } = await import("node:fs");
          expect(statSync(statePath).mode & 0o777).toBe(0o600);
        }

        // Second start reuses the running daemon instead of spawning another.
        const second = await runCli(["start"], cwd);
        expect(second.code).toBe(0);
        const state2 = JSON.parse(readFileSync(statePath, "utf8")) as { pid: number };
        expect(state2.pid).toBe(state.pid);

        const stop = await runCli(["stop"], cwd);
        expect(stop.code).toBe(0);
        expect(stop.stdout).toContain(`pid ${state.pid}`);
        expect(existsSync(statePath)).toBe(false);
        await expect(fetchStatus(url!)).rejects.toThrow();

        // stop with nothing running is a clean no-op
        const stopAgain = await runCli(["stop"], cwd);
        expect(stopAgain.code).toBe(0);
        expect(stopAgain.stdout).toContain("no report server running");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
