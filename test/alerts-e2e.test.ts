/**
 * Real-stack e2e for kya-alerts (N3): spawns the built dist/cli.js with a temp KYA_HOME and a local
 * HTTP receiver on 127.0.0.1. A never-list call repeated through `kya hook` writes the trail, the
 * hook starts the detached `kya notify-flush`, the flush runs the detectors and posts
 * `incident.opened`. Happy path and denied paths. Requires `npm run build` first.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const dirs: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const NEVER = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "E2E-SESSION-SECRET-42",
  tool_name: "mcp__postgres__drop_table",
  tool_input: { table: "users" },
});

interface Hit {
  readonly path: string;
  readonly body: Record<string, unknown>;
}
interface Receiver {
  readonly url: string;
  readonly hits: Hit[];
  incidents(): Hit[];
  denies(): Hit[];
}

async function receiver(): Promise<Receiver> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += String(d)));
    req.on("end", () => {
      try {
        hits.push({ path: req.url ?? "", body: JSON.parse(raw) as Record<string, unknown> });
      } catch {
        /* not JSON */
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    hits,
    incidents: () => hits.filter((h) => h.body["event"] === "incident.opened"),
    denies: () => hits.filter((h) => h.body["kind"] === "kya.trail.verdict"),
  };
}

async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeConfig(root: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(root, ".kya"), { recursive: true });
  writeFileSync(join(root, ".kya", "config.json"), JSON.stringify(cfg));
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

function runCli(args: string[], opts: { home: string; cwd?: string; stdin?: string; env?: Record<string, string> }): Promise<Run> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd: opts.cwd ?? opts.home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: opts.home,
        KYA_HOME: opts.home,
        KYA_OFFLINE: "1",
        KYA_NO_BROWSER: "1",
        KYA_SKIP_NODE_CHECK: "1",
        KYA_IOC: "0",
        KYA_ALERTS_DESKTOP: "off", // never pop a real desktop notification from a test
        ...opts.env,
      },
    });
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.stdin.on("error", () => undefined);
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

/** Three never-list calls, one after the other (the third makes the incident bigger, not new). */
async function repeatNever(home: string, cwd: string, env: Record<string, string> = {}): Promise<Run[]> {
  const runs: Run[] = [];
  for (let i = 0; i < 3; i++) runs.push(await runCli(["hook", "--host", "claude"], { home, cwd, stdin: NEVER, env }));
  return runs;
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The flush child posts the verdict first and scans after, so once the unfiltered receiver has all
 * three DENY posts the scan of that child is about to finish. Then wait a little more.
 */
async function drain(all: Receiver, n = 3): Promise<void> {
  expect(await waitFor(() => all.denies().length >= n, 15_000)).toBe(true);
  await settle(1_500);
}

function setup(alerts: Record<string, unknown> | undefined, inc: Receiver, all: Receiver) {
  const home = temp("kya-alerts-e2e-home-");
  const cwd = temp("kya-alerts-e2e-proj-");
  writeConfig(home, {
    ...(alerts ? { alerts } : {}),
    notify: {
      webhooks: [
        { url: `${inc.url}/inc`, events: ["incident.opened"] },
        { url: `${all.url}/all` },
      ],
    },
  });
  return { home, cwd };
}

describe("kya-alerts e2e: incident alerts through notify webhooks", () => {
  it("kya-alerts happy path: three never-list calls send exactly one incident.opened with no raw data", async () => {
    const inc = await receiver();
    const all = await receiver();
    const { home, cwd } = setup({ enabled: true }, inc, all);
    const runs = await repeatNever(home, cwd);
    for (const r of runs) {
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('"permissionDecision":"deny"');
    }
    expect(await waitFor(() => inc.incidents().length >= 1, 15_000)).toBe(true);
    await drain(all);
    expect(inc.incidents()).toHaveLength(1);
    expect(inc.denies()).toHaveLength(0); // an incident.opened-only webhook gets no verdict posts
    // the unfiltered webhook gets the verdicts and the incident
    expect(all.incidents()).toHaveLength(1);
    const body = inc.incidents()[0]!.body as { kind: string; incident: Record<string, unknown> };
    expect(body.kind).toBe("kya.incident.opened");
    expect(body.incident).toMatchObject({ severity: "high", detectorIds: ["never-repeat"], test: false, advisory: "Local KYA is advisory." });
    const text = JSON.stringify(body);
    expect(text).not.toContain("E2E-SESSION-SECRET-42");
    expect(text).not.toContain(home);
    expect(text).not.toContain("argsHash");
    expect(text).not.toContain("targetPath");
    expect(text).not.toContain("diffPreview");
    // state and ledger
    const state = JSON.parse(readFileSync(join(home, ".kya", "alerts-state.json"), "utf8")) as { entries: Array<{ status: string }> };
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.status).toBe("sent");
    const log = readFileSync(join(home, ".kya", "notify-log.jsonl"), "utf8");
    expect(log).toContain('"verdict":"incident.opened"');
    // kya alerts status sees it
    const st = await runCli(["alerts", "status", "--json"], { home });
    expect(st.code).toBe(0);
    expect(JSON.parse(st.stdout)).toMatchObject({ enabled: true, recent: [{ severity: "high", status: "sent" }] });
  }, 90_000);

  it("kya-alerts denied: alerts off (default) sends no incident", async () => {
    const inc = await receiver();
    const all = await receiver();
    const { home, cwd } = setup(undefined, inc, all);
    await repeatNever(home, cwd);
    await drain(all);
    expect(inc.hits).toHaveLength(0);
    expect(all.incidents()).toHaveLength(0);
    expect(existsSync(join(home, ".kya", "alerts-state.json"))).toBe(false);
  }, 90_000);

  it("kya-alerts denied: KYA_ALERTS=off beats an enabled config; KYA_ALERTS=on enables a config without the key", async () => {
    const inc = await receiver();
    const all = await receiver();
    const off = setup({ enabled: true }, inc, all);
    await repeatNever(off.home, off.cwd, { KYA_ALERTS: "off" });
    await drain(all);
    expect(inc.hits).toHaveLength(0);

    const inc2 = await receiver();
    const all2 = await receiver();
    const on = setup(undefined, inc2, all2);
    await repeatNever(on.home, on.cwd, { KYA_ALERTS: "on" });
    expect(await waitFor(() => inc2.incidents().length >= 1, 15_000)).toBe(true);
    await drain(all2);
    expect(inc2.incidents()).toHaveLength(1);
  }, 120_000);

  it("kya-alerts denied: an incident below the severity floor sends nothing", async () => {
    const inc = await receiver();
    const all = await receiver();
    const { home, cwd } = setup({ enabled: true, minSeverity: "critical" }, inc, all);
    await repeatNever(home, cwd);
    await drain(all);
    expect(inc.hits).toHaveLength(0);
  }, 90_000);

  it("kya-alerts denied: a project config cannot turn alerts off or redirect them", async () => {
    const inc = await receiver();
    const all = await receiver();
    const attacker = await receiver();
    const { home, cwd } = setup({ enabled: true }, inc, all);
    writeConfig(cwd, {
      alerts: { enabled: false, minSeverity: "critical" },
      notify: { webhooks: [{ url: `${attacker.url}/steal` }] },
    });
    await repeatNever(home, cwd);
    expect(await waitFor(() => inc.incidents().length >= 1, 15_000)).toBe(true);
    await waitFor(() => attacker.denies().length >= 3, 15_000);
    await settle(1_500);
    expect(inc.incidents()).toHaveLength(1);
    expect(attacker.incidents()).toHaveLength(0);
  }, 90_000);

  it("kya-alerts fail open: receiver down leaves the hook answer and speed unchanged and logs the failure", async () => {
    const dead = await deadUrl();
    const home = temp("kya-alerts-e2e-home-");
    const cwd = temp("kya-alerts-e2e-proj-");
    writeConfig(home, { alerts: { enabled: true }, notify: { webhooks: [{ url: `${dead}/inc`, events: ["incident.opened"] }] } });
    const runs = await repeatNever(home, cwd);
    for (const r of runs) {
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('"permissionDecision":"deny"');
      expect(r.ms).toBeLessThan(8_000);
    }
    const logPath = join(home, ".kya", "notify-log.jsonl");
    expect(
      await waitFor(() => existsSync(logPath) && /"verdict":"incident.opened","ok":false/.test(readFileSync(logPath, "utf8")), 30_000),
    ).toBe(true);
    // the failed alert stays pending (retry later), it is not marked as sent
    const state = JSON.parse(readFileSync(join(home, ".kya", "alerts-state.json"), "utf8")) as { entries: Array<{ status: string; delivered: number }> };
    expect(state.entries[0]).toMatchObject({ status: "pending", delivered: 0 });
    await settle(8_000); // let every detached flush child finish its retries before the temp dirs go
  }, 90_000);

  it("kya-alerts test reaches the receiver marked as a test; on and off write the user config", async () => {
    const inc = await receiver();
    const all = await receiver();
    const { home } = setup(undefined, inc, all);
    const t = await runCli(["alerts", "test"], { home });
    expect(t.code).toBe(0);
    expect(inc.incidents()).toHaveLength(1);
    expect(all.incidents()).toHaveLength(1);
    expect(inc.incidents()[0]!.body).toMatchObject({ incident: { test: true } });
    expect(JSON.stringify(inc.incidents()[0]!.body)).toContain("[TEST]");

    expect((await runCli(["alerts", "on"], { home })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".kya", "config.json"), "utf8")).alerts.enabled).toBe(true);
    expect((await runCli(["alerts", "off"], { home })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".kya", "config.json"), "utf8")).alerts.enabled).toBe(false);
    const st = await runCli(["alerts", "status"], { home });
    expect(st.stdout).toContain("Security alerts: off");
    expect(st.stdout).toContain("Local KYA is advisory.");
  }, 60_000);

  it("kya-alerts test exits 1 when no webhook is configured or the receiver is down", async () => {
    const home = temp("kya-alerts-e2e-home-");
    expect((await runCli(["alerts", "test"], { home })).code).toBe(1);
    const dead = await deadUrl();
    writeConfig(home, { notify: { webhooks: [{ url: `${dead}/x` }] } });
    expect((await runCli(["alerts", "test"], { home })).code).toBe(1);
  }, 60_000);
});
