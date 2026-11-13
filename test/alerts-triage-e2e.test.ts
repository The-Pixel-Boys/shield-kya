/**
 * Real-stack e2e for local triage and desktop alerts (N6): spawns the built dist/cli.js with a temp KYA_HOME,
 * a local HTTP receiver, a fake onnxruntime-node under the opt-in prefix, and a stub desktop notifier on PATH.
 * A never-list call repeated through `kya hook` writes the trail; the detached `kya notify-flush` runs the
 * detectors, loads the model and posts `incident.opened`. Happy path and every failure path.
 * Requires `npm run build` first.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installFakeModel, installFakeOrt } from "./support/fake-triage-runtime.js";
import { triageRuntimeDir } from "../src/alerts/triage-status.js";

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
  readonly body: Record<string, any>;
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
        hits.push({ body: JSON.parse(raw) as Record<string, any> });
      } catch {
        /* not JSON */
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    incidents: () => hits.filter((h) => h.body["event"] === "incident.opened"),
    denies: () => hits.filter((h) => h.body["kind"] === "kya.trail.verdict"),
  };
}

const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

function runCli(args: string[], opts: { home: string; cwd?: string; stdin?: string; env?: Record<string, string> }): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
        KYA_ALERTS_DESKTOP: "off",
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
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

interface Rig {
  readonly home: string;
  readonly cwd: string;
  readonly inc: Receiver;
  readonly all: Receiver;
  readonly env: Record<string, string>;
  readonly marker: string;
}

async function rig(alerts: Record<string, unknown> | undefined = { enabled: true }, extraEnv: Record<string, string> = {}): Promise<Rig> {
  const inc = await receiver();
  const all = await receiver();
  const home = temp("kya-triage-e2e-home-");
  const cwd = temp("kya-triage-e2e-proj-");
  mkdirSync(join(home, ".kya"), { recursive: true });
  writeFileSync(
    join(home, ".kya", "config.json"),
    JSON.stringify({
      ...(alerts ? { alerts } : {}),
      notify: { webhooks: [{ url: `${inc.url}/inc`, events: ["incident.opened"] }, { url: `${all.url}/all` }] },
    }),
  );
  const marker = join(home, "ort-marker.txt");
  return { home, cwd, inc, all, marker, env: { FAKE_ORT_MARKER: marker, ...extraEnv } };
}

/** Three never-list calls through the hook, then wait until the flush children have finished. */
async function fire(r: Rig): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const out = await runCli(["hook", "--host", "claude"], { home: r.home, cwd: r.cwd, stdin: NEVER, env: r.env });
    expect(out.code).toBe(2);
  }
  expect(await waitFor(() => r.all.denies().length >= 3, 15_000)).toBe(true);
  await new Promise((res) => setTimeout(res, 1_500));
}

const model = (r: Rig): NodeJS.ProcessEnv => ({ KYA_HOME: r.home });

describe("local triage e2e: model installed", () => {
  it("adds triage to the webhook body and the report; the hook process never loads the runtime", async () => {
    const r = await rig();
    installFakeOrt(model(r));
    installFakeModel(model(r));
    await fire(r);
    expect(r.inc.incidents()).toHaveLength(1);
    const inc = r.inc.incidents()[0]!.body["incident"] as Record<string, any>;
    expect(inc).toMatchObject({ severity: "high", detectorIds: ["never-repeat"], test: false });
    expect(inc.triage).toMatchObject({
      model: "kya-triage-test",
      category: { id: "credential-access" },
      urgency: { id: "within-hour" },
      action: { id: "rotate-secret" },
    });
    expect(inc.triage.category.p).toBeGreaterThan(0.99);
    expect(typeof inc.triage.benign).toBe("number");
    expect(JSON.stringify(inc)).not.toContain("E2E-SESSION-SECRET-42");
    // Lazy load: only the detached flush child loaded the runtime, never the hook.
    const loads = readFileSync(r.marker, "utf8").trim().split("\n");
    expect(loads.length).toBeGreaterThanOrEqual(1);
    for (const line of loads) {
      expect(line).toContain("notify-flush");
      expect(line).not.toMatch(/ hook( |$)/);
    }
    // state + report
    const state = JSON.parse(readFileSync(join(r.home, ".kya", "alerts-state.json"), "utf8")) as { entries: Array<Record<string, any>> };
    expect(state.entries[0]!.triage.category.id).toBe("credential-access");
    const out = join(r.home, "report-out");
    const rep = await runCli(["receipt", "--out", out], { home: r.home, cwd: r.cwd, env: r.env });
    expect(rep.code).toBe(0);
    const htmlFile = readdirSync(out).find((f) => f.endsWith(".html"));
    expect(htmlFile).toBeDefined();
    const html = readFileSync(join(out, htmlFile!), "utf8");
    expect(html).toContain("Incident alerts");
    expect(html).toContain("triage (local model, advisory): credential-access");
  }, 60_000);
});

describe("local triage e2e: failure paths still alert (advisory, fail open)", () => {
  async function expectAlertWithoutTriage(r: Rig): Promise<void> {
    await fire(r);
    expect(r.inc.incidents()).toHaveLength(1);
    const inc = r.inc.incidents()[0]!.body["incident"] as Record<string, any>;
    expect(inc.severity).toBe("high");
    expect(inc.triage).toBeUndefined();
    const state = JSON.parse(readFileSync(join(r.home, ".kya", "alerts-state.json"), "utf8")) as { entries: Array<Record<string, any>> };
    expect(state.entries[0]!.status).toBe("sent");
    expect(state.entries[0]!.triage).toBeUndefined();
  }

  it("runtime installed, model file missing: alert sent without triage", async () => {
    const r = await rig();
    installFakeOrt(model(r));
    await expectAlertWithoutTriage(r);
    expect(existsSync(r.marker)).toBe(false); // nothing to load
  }, 60_000);

  it("model file present, runtime missing: alert sent without triage", async () => {
    const r = await rig();
    installFakeModel(model(r));
    await expectAlertWithoutTriage(r);
  }, 60_000);

  it("neither installed (the default): alert sent without triage", async () => {
    await expectAlertWithoutTriage(await rig());
  }, 60_000);

  it("the runtime throws while loading the model: alert sent without triage", async () => {
    const r = await rig(undefined, { KYA_ALERTS: "on", FAKE_ORT_MODE: "throw" });
    installFakeOrt(model(r));
    installFakeModel(model(r));
    await expectAlertWithoutTriage(r);
    expect(existsSync(r.marker)).toBe(true); // it was tried
  }, 60_000);

  it("a corrupt model file: alert sent without triage", async () => {
    const r = await rig();
    installFakeOrt(model(r));
    const file = installFakeModel(model(r));
    writeFileSync(file, "this is not a model file");
    await expectAlertWithoutTriage(r);
  }, 60_000);

  it("the model says benign and ignore: the never-list incident still alerts at the detector severity", async () => {
    const r = await rig(undefined, { KYA_ALERTS: "on", FAKE_ORT_MODE: "benign" });
    installFakeOrt(model(r));
    installFakeModel(model(r));
    await fire(r);
    expect(r.inc.incidents()).toHaveLength(1);
    const inc = r.inc.incidents()[0]!.body["incident"] as Record<string, any>;
    expect(inc.severity).toBe("high");
    expect(inc.triage).toMatchObject({ category: { id: "benign-noise" }, urgency: { id: "ignore" }, action: { id: "none" } });
  }, 60_000);

  it("alerts off: no incident alert, the model is never loaded", async () => {
    const r = await rig({ enabled: false });
    installFakeOrt(model(r));
    installFakeModel(model(r));
    await fire(r);
    expect(r.inc.incidents()).toHaveLength(0);
    expect(existsSync(r.marker)).toBe(false);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("desktop notification e2e (stub notifier on PATH)", () => {
  /** A stub notifier: writes every argument on its own line, then a separator line. */
  function stub(dir: string): string {
    const bin = join(dir, "stub-bin");
    mkdirSync(bin, { recursive: true });
    const log = join(dir, "notifier-args.log");
    const name = process.platform === "darwin" ? "osascript" : "notify-send";
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\necho '----' >> "${log}"\n`);
    chmodSync(file, 0o755);
    return bin;
  }
  const calls = (log: string): string[][] =>
    existsSync(log)
      ? readFileSync(log, "utf8").split("----\n").filter(Boolean).map((c) => c.split("\n").filter(Boolean))
      : [];

  it("one notification per new incident, argv only, static text: no summary, tool, session or path", async () => {
    const r = await rig({ enabled: true }, {});
    const bin = stub(r.home);
    const env = { ...r.env, KYA_ALERTS_DESKTOP: "on", PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    await fire({ ...r, env });
    const log = join(r.home, "notifier-args.log");
    const got = calls(log);
    expect(got).toHaveLength(1); // a repeat and a refresh of the same incident do not notify again
    const args = got[0]!;
    const all = args.join("\n");
    expect(all).toContain("KYA security alert");
    expect(all).toContain("Severity: high. Detectors: never-repeat.");
    for (const secret of ["postgres", "drop_table", "drop table", "E2E-SESSION", r.home, r.cwd, "users"]) expect(all).not.toContain(secret);
    // the text is its own argv entry (not spliced into a script string)
    expect(args).toContain("KYA security alert");
    expect(args).toContain("Severity: high. Detectors: never-repeat. Open kya report.");
    // the webhook alert was sent as well
    expect(r.inc.incidents()).toHaveLength(1);
  }, 60_000);

  it("alerts.desktop false in the user config: no notification, the webhook alert still goes out", async () => {
    const r = await rig({ enabled: true, desktop: false });
    const bin = stub(r.home);
    await fire({ ...r, env: { ...r.env, KYA_ALERTS_DESKTOP: "on", PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } });
    expect(calls(join(r.home, "notifier-args.log"))).toHaveLength(0);
    expect(r.inc.incidents()).toHaveLength(1);
  }, 60_000);

  it("KYA_ALERTS_DESKTOP=off: no notification", async () => {
    const r = await rig({ enabled: true });
    const bin = stub(r.home);
    await fire({ ...r, env: { ...r.env, KYA_ALERTS_DESKTOP: "off", PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } });
    expect(calls(join(r.home, "notifier-args.log"))).toHaveLength(0);
  }, 60_000);

  it("alerts off: no notification", async () => {
    const r = await rig({ enabled: false });
    const bin = stub(r.home);
    await fire({ ...r, env: { ...r.env, KYA_ALERTS_DESKTOP: "on", PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } });
    expect(calls(join(r.home, "notifier-args.log"))).toHaveLength(0);
  }, 60_000);

  it("the model code crashes the flush child (native crash), no webhook set: the desktop notification was already shown, once", async () => {
    const home = temp("kya-triage-e2e-home-");
    const cwd = temp("kya-triage-e2e-proj-");
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(join(home, ".kya", "config.json"), JSON.stringify({ alerts: { enabled: true } })); // no webhook: the claim is final at once
    installFakeOrt({ KYA_HOME: home });
    installFakeModel({ KYA_HOME: home });
    const bin = stub(home);
    const env = { KYA_ALERTS_DESKTOP: "on", FAKE_ORT_MODE: "crash", PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    for (let i = 0; i < 3; i++) expect((await runCli(["hook", "--host", "claude"], { home, cwd, stdin: NEVER, env })).code).toBe(2);
    const log = join(home, "notifier-args.log");
    expect(await waitFor(() => calls(log).length >= 1, 15_000)).toBe(true);
    await new Promise((res) => setTimeout(res, 1_500));
    expect(calls(log)).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(home, ".kya", "alerts-state.json"), "utf8")) as { entries: Array<Record<string, any>> };
    expect(state.entries).toHaveLength(1); // not alerted again by the later flushes
  }, 60_000);

  it("no notifier installed: the alert still goes out and nothing fails", async () => {
    const r = await rig({ enabled: true });
    await fire({ ...r, env: { ...r.env, KYA_ALERTS_DESKTOP: "on", PATH: "/nonexistent-dir" } });
    expect(r.inc.incidents()).toHaveLength(1);
  }, 60_000);
});

// Real model + real onnxruntime-node, when a local build is given (CI has neither and skips this block).
const REAL_MODEL = process.env.KYA_TRIAGE_MODEL_PATH;
const REAL_ORT = process.env.KYA_TEST_ORT_PREFIX;
describe.skipIf(!REAL_MODEL || !REAL_ORT || !existsSync(join(REAL_ORT, "node_modules", "onnxruntime-node")))("real model e2e (local build)", () => {
  it("built CLI, real int8 model, real onnxruntime-node: hook to webhook body with triage", async () => {
    const r = await rig(undefined, { KYA_TRIAGE_MODEL_PATH: REAL_MODEL! });
    mkdirSync(join(r.home, ".kya"), { recursive: true });
    symlinkSync(REAL_ORT!, triageRuntimeDir({ KYA_HOME: r.home })); // the folder itself is the opt-in prefix
    await fire(r);
    // The first flush loads the model (about 1.5 s) before it sends: wait for the alert.
    expect(await waitFor(() => r.inc.incidents().length >= 1, 20_000)).toBe(true);
    expect(r.inc.incidents()).toHaveLength(1);
    const inc = r.inc.incidents()[0]!.body["incident"] as Record<string, any>;
    expect(inc.severity).toBe("high");
    expect(inc.triage.model).toBe("kya-triage-v1");
    for (const h of ["category", "urgency", "action"]) {
      expect(typeof inc.triage[h].id).toBe("string");
      expect(inc.triage[h].p).toBeGreaterThan(0);
      expect(inc.triage[h].p).toBeLessThanOrEqual(1);
    }
    expect(inc.triage.benign).toBeGreaterThanOrEqual(0);
    expect(inc.triage.benign).toBeLessThanOrEqual(1);
    console.log("real model triage:", JSON.stringify(inc.triage));
  }, 90_000);
});
