/**
 * Real-process checks for `kya hook` (local mode): the answer and exit code stay as they were, a
 * host that never closes stdin gets the fail-open answer at the stdin timeout and the process exits
 * by itself, a detached spawn issued before the exit still runs, and a closed stdout pipe does not
 * throw. Requires `npm run build` first (spawns dist/cli.js).
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const homes: string[] = [];
afterAll(() => {
  for (const d of homes) rmSync(d, { recursive: true, force: true });
});

const payload = (tool: string, toolInput: unknown = { command: "echo hi" }) =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "hook-exit", tool_name: tool, tool_input: toolInput });
const ALLOW = payload("Bash");
const NEVER = payload("mcp__postgres__drop_table", { table: "users" });
const DENY_JSON = /"permissionDecision":"deny"/;

interface HookOpts {
  /** "closed": stdin ends after the payload. "open": the payload is written and stdin is never closed. */
  readonly stdin?: "closed" | "open";
  readonly env?: Record<string, string>;
  /** Keep the background spawns (IoC scan) on, as a real install has them. Off by default. */
  readonly iocOn?: boolean;
  /** Read side of stdout closed before the answer. */
  readonly closeStdout?: boolean;
  readonly killMs?: number;
  /** Close stdin this long after start (a slow host). */
  readonly delayMs?: number;
}
interface HookRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
  /** True when the test had to SIGKILL the hook: it did not exit by itself. */
  readonly killed: boolean;
  readonly home: string;
}

function runHook(input: string, opts: HookOpts = {}): Promise<HookRun> {
  const home = mkdtempSync(join(tmpdir(), "kya-hook-exit-"));
  homes.push(home);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliJs, "hook", "--host", "claude"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        KYA_HOME: home,
        KYA_OFFLINE: "1",
        KYA_NO_BROWSER: "1",
        KYA_SKIP_NODE_CHECK: "1",
        ...(opts.iocOn ? {} : { KYA_IOC: "0" }),
        ...opts.env,
      },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const killer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, opts.killMs ?? 20_000);
    child.stdout.on("error", () => undefined);
    child.stdin.on("error", () => undefined);
    if (opts.closeStdout) child.stdout.destroy();
    else child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - t0, killed, home });
    });
    if (opts.stdin === "open") child.stdin.write(input);
    else if (opts.delayMs) setTimeout(() => child.stdin.end(input), opts.delayMs);
    else child.stdin.end(input);
  });
}

describe("kya hook, stdin closed: same answer and exit code as before", () => {
  // Expected values were measured on the build before this change (same five payloads).
  it.each([
    ["allow", ALLOW, 0, ""],
    ["unknown tool", payload("SomeUnknownTool", {}), 0, ""],
    ["empty object", "{}", 0, ""],
    ["invalid JSON", "not json{", 0, ""],
  ])("%s exits %i with no output and does not hang", async (_name, input, code, stdout) => {
    const r = await runHook(input);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(code);
    expect(r.stdout).toBe(stdout);
    expect(r.ms).toBeLessThan(10_000);
  }, 30_000);

  it("never-list payload is denied with exit 2 and the deny JSON", async () => {
    const r = await runHook(NEVER);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(DENY_JSON);
    expect(r.stdout).toContain("NEVER_EVENT");
  }, 30_000);
});

describe("kya hook, stdin held open: the stdin timeout decides and the process exits", () => {
  it("a payload that never ends gets the fail-open answer at the timeout and the process exits", async () => {
    const r = await runHook(ALLOW, { stdin: "open", killMs: 18_000 });
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ms).toBeGreaterThanOrEqual(9000);
    expect(r.ms).toBeLessThan(16_000);
  }, 30_000);

  it("the env value KYA_HOOK_STDIN_TIMEOUT_MS has no effect: a slow never-list payload is still denied", async () => {
    const r = await runHook(NEVER, { delayMs: 400, env: { KYA_HOOK_STDIN_TIMEOUT_MS: "1" } });
    expect(r.killed).toBe(false);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(DENY_JSON);
  }, 30_000);

  it("never-list payload sent in full, stdin held open: still denied, at the timeout (not earlier)", async () => {
    const r = await runHook(NEVER, { stdin: "open", killMs: 18_000 });
    expect(r.killed).toBe(false);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(DENY_JSON);
    expect(r.ms).toBeGreaterThanOrEqual(9000);
  }, 30_000);

  it("an incomplete never-list payload at the timeout is unreadable, so it is allowed (fail open)", async () => {
    const cut = NEVER.slice(0, NEVER.indexOf("tool_input"));
    const r = await runHook(cut, { stdin: "open", killMs: 18_000 });
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  }, 30_000);
});

describe("kya hook: exit does not cut off spawns, and a closed stdout pipe does not throw", () => {
  it("a detached IoC scan issued before the exit still runs to completion", async () => {
    const r = await runHook(ALLOW, { iocOn: true });
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(5000);
    const marker = join(r.home, ".kya", "ioc-latest.json");
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((ok) => setTimeout(ok, 200));
    expect(existsSync(marker)).toBe(true);
  }, 40_000);

  it("closed stdout pipe: no unhandled error, exit code is still the verdict", async () => {
    const r = await runHook(NEVER, { closeStdout: true });
    expect(r.killed).toBe(false);
    expect(r.code).toBe(2);
    expect(r.stderr).not.toMatch(/Unhandled|EPIPE|node:events/);
  }, 30_000);
});
