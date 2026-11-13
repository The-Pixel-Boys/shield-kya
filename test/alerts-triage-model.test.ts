/**
 * Local triage model (src/alerts/triage-model.ts, triage-tokenizer.ts) and its use in the alert scan.
 * Plumbing runs in CI with a fake onnxruntime-node and a toy tokenizer (test/support/fake-triage-runtime.ts).
 * The real model is tested when KYA_TRIAGE_MODEL_PATH (packed model) and KYA_TEST_ORT_PREFIX (a folder with
 * node_modules/onnxruntime-node) are set: golden predictions and token ids, latency. CI has neither: it skips them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BpeTokenizer, BYTE_TO_UNICODE } from "../src/alerts/triage-tokenizer.js";
import { parsePack, scoreText, triageIncident } from "../src/alerts/triage-model.js";
import { renderState } from "../src/alerts/triage-prompt.js";
import type { TriageInput } from "../src/alerts/triage-input.js";
import { runAlertScan } from "../src/alerts/scan.js";
import { readAlertsState } from "../src/alerts/state.js";
import { triageModelInstallPath, triageRuntimeDir } from "../src/alerts/triage-status.js";
import { appendTrail, type TrailEvent } from "../src/trail.js";
import { runAlerts } from "../src/commands/alerts.js";
import { desktopBody, desktopCommand } from "../src/alerts/desktop.js";
import { resetNotifyState } from "../src/notify/index.js";
import { decodeToy, installFakeModel, installFakeOrt, packModel } from "./support/fake-triage-runtime.js";

const CASES = readFileSync(join(import.meta.dirname, "fixtures", "alerts", "triage-eval.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { id: string; input: TriageInput });
const INPUT = CASES[0]!.input;

let home: string;
let env: NodeJS.ProcessEnv;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kya-triage-model-"));
  env = { KYA_HOME: home, KYA_ALERTS_DESKTOP: "off" };
  resetNotifyState();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("triage tokenizer (byte-level BPE)", () => {
  // Toy vocabulary: all byte characters, merges "l l", "h e", "he ll", plus an added token.
  const vocab: Record<string, number> = {};
  BYTE_TO_UNICODE.forEach((ch, b) => (vocab[ch] = b));
  vocab["ll"] = 300;
  vocab["he"] = 301;
  vocab["hell"] = 302;
  vocab["Ġw"] = 303;
  const tok = new BpeTokenizer({ vocab, merges: ["l l", "h e", "he ll", "Ġ w"], added: [["<|x|>", 400]], cls: 500, sep: 501 });
  const b = (c: string): number => c.charCodeAt(0);

  it("applies merges by rank and adds CLS and SEP", () => {
    expect(tok.encode("hello", 64)).toEqual([500, 302, b("o"), 501]);
  });
  it("maps a leading space to the G-dot character, as GPT-2 does", () => {
    expect(tok.encode("a w", 64)).toEqual([500, b("a"), 303, 501]);
  });
  it("splits on added tokens and keeps their id", () => {
    expect(tok.encode("he<|x|>o", 64)).toEqual([500, 301, 400, b("o"), 501]);
  });
  it("NFC: a combining accent becomes one character before the byte map", () => {
    expect(tok.encode("é", 64)).toEqual(tok.encode("é", 64));
    expect(tok.encode("é", 64)).toHaveLength(2 + 2); // two bytes, no merge for them
  });
  it("cuts the sequence at maxLen and still ends with SEP", () => {
    const ids = tok.encode("abcdefghij", 5);
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe(500);
    expect(ids[4]).toBe(501);
  });
});

describe("triage model file", () => {
  it("parses a packed file", () => {
    const { meta, onnx } = parsePack(packModel());
    expect(meta.modelId).toBe("kya-triage-test");
    expect(onnx.length).toBe(4096);
  });
  it("refuses a bad magic, a truncated file and labels that differ from triage-schema.json", () => {
    expect(() => parsePack(Buffer.from("not a model at all"))).toThrow(/not a kya triage model/);
    expect(() => parsePack(packModel().subarray(0, 40))).toThrow();
    const bad = packModel({ labels: { category: ["x"], urgency: ["a"], action: ["a"], benign: ["yes", "no"] } });
    expect(() => parsePack(bad)).toThrow(/differ from triage-schema/);
    expect(() => parsePack(packModel({ temperature: { category: 0, urgency: 1, action: 1, benign: 1 } }))).toThrow(/temperature/);
  });
});

describe("triage inference (fake runtime)", () => {
  it("gives category, urgency, action and benign with probabilities and the model id", async () => {
    installFakeOrt(env);
    installFakeModel(env);
    const t = await triageIncident(INPUT, env);
    expect(t).toMatchObject({
      model: "kya-triage-test",
      category: { id: "credential-access" },
      urgency: { id: "within-hour" },
      action: { id: "rotate-secret" },
    });
    expect(t!.category.p).toBeGreaterThan(0.99);
    expect(t!.benign).toBeLessThan(0.01);
  });

  it("the model gets exactly renderState(input): the text the hosted model sees, nothing else", async () => {
    installFakeOrt(env);
    installFakeModel(env);
    const log = join(home, "ids.log");
    setEnv("FAKE_ORT_LOG", log);
    await scoreText(renderState(INPUT), env);
    const ids = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!) as number[];
    expect(ids[0]).toBe(256);
    expect(ids.at(-1)).toBe(257);
    expect(decodeToy(ids)).toBe(renderState(INPUT));
  });

  it("no network at triage time: nothing calls fetch", async () => {
    installFakeOrt(env);
    installFakeModel(env);
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is off"));
    try {
      expect(await triageIncident(INPUT, env)).toBeDefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns undefined, never throws, when the model is missing, broken or the runtime fails", async () => {
    // runtime but no model
    installFakeOrt(env);
    expect(await triageIncident(INPUT, env)).toBeUndefined();
    // model but a broken file
    mkdirSync(join(home, ".kya", "triage", "model"), { recursive: true });
    writeFileSync(triageModelInstallPath(env), "garbage");
    expect(await triageIncident(INPUT, env)).toBeUndefined();
    // good model, runtime throws at load
    installFakeModel(env);
    setEnv("FAKE_ORT_MODE", "throw");
    expect(await triageIncident(INPUT, env)).toBeUndefined();
    // runtime missing
    const other = mkdtempSync(join(tmpdir(), "kya-triage-model2-"));
    installFakeModel({ KYA_HOME: other });
    expect(await triageIncident(INPUT, { KYA_HOME: other })).toBeUndefined();
    rmSync(other, { recursive: true, force: true });
  });

  it("refuses a runtime that resolves outside the opt-in folder", async () => {
    const outside = mkdtempSync(join(tmpdir(), "kya-triage-outside-"));
    const marker = join(home, "marker.txt");
    setEnv("FAKE_ORT_MARKER", marker);
    installFakeOrt({ KYA_HOME: outside }); // a runtime in another home
    mkdirSync(join(triageRuntimeDir(env), "node_modules"), { recursive: true });
    symlinkSync(join(triageRuntimeDir({ KYA_HOME: outside }), "node_modules", "onnxruntime-node"), join(triageRuntimeDir(env), "node_modules", "onnxruntime-node"));
    installFakeModel(env);
    expect(await triageIncident(INPUT, env)).toBeUndefined();
    expect(existsSync(marker)).toBe(false); // its code never ran
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("lazy load: the hook path never reaches the model code", () => {
  const dist = join(import.meta.dirname, "..", "dist");
  /** Every file reachable from `entries` through static and dynamic relative imports of the built JS. */
  function reachable(entries: string[]): Set<string> {
    const seen = new Set<string>();
    const todo = [...entries];
    while (todo.length > 0) {
      const f = todo.pop()!;
      if (seen.has(f) || !existsSync(f)) continue;
      seen.add(f);
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.[^"']+\.js)["']/g)) todo.push(resolve(dirname(f), m[1]!));
    }
    return seen;
  }
  it("hook, hosted hook, telemetry and the notify dispatcher do not import triage-model, its tokenizer, the scan or the setup", () => {
    const seen = reachable(["commands/hook.js", "commands/hosted-hook.js", "telemetry.js", "notify/dispatch.js"].map((f) => join(dist, f)));
    expect(seen.size).toBeGreaterThan(10); // the walk really followed imports
    const rel = [...seen].map((f) => f.slice(dist.length + 1));
    for (const heavy of ["alerts/triage-model.js", "alerts/triage-tokenizer.js", "alerts/scan.js", "alerts/triage-setup.js"]) {
      expect(rel, heavy).not.toContain(heavy);
    }
  });
  it("the flush child does reach them (the walk can see them)", () => {
    const rel = [...reachable([join(dist, "commands", "notify-flush.js")])].map((f) => f.slice(dist.length + 1));
    expect(rel).toContain("alerts/scan.js");
  });
  it("only the scan imports the model code, and only on demand", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "alerts", "scan.ts"), "utf8");
    expect(src).not.toMatch(/^import\s+(?!type)[^;]*triage-model\.js/m);
    expect(src).toContain('await import("./triage-model.js")');
  });
});

describe("desktop notification command", () => {
  const evil = 'x"; do shell script "touch /tmp/pwned"; "';
  it("macOS and Linux: the text is its own argv entry, never part of a script string", () => {
    const mac = desktopCommand("darwin", "T", evil)!;
    expect(mac.file).toBe("osascript");
    expect(mac.args.slice(-2)).toEqual([evil, "T"]);
    expect(mac.args.filter((a) => a !== "-e").slice(0, -2).join("\n")).not.toContain("touch");
    const lin = desktopCommand("linux", "T", evil)!;
    expect(lin.args.slice(-3)).toEqual(["--", "T", evil]);
  });
  it("Windows: the text goes through environment variables, not the script", () => {
    const win = desktopCommand("win32", "T", evil)!;
    expect(win.args.join(" ")).not.toContain("pwned");
    expect(win.env).toEqual({ KYA_TOAST_TITLE: "T", KYA_TOAST_BODY: evil });
  });
  it("an unknown platform does nothing", () => {
    expect(desktopCommand("freebsd", "T", "B")).toBeUndefined();
  });
  it("the body holds only the severity and safe detector ids", () => {
    expect(desktopBody({ severity: "high", detectorIds: ["never-repeat", "x; rm -rf /"], test: false })).toBe("Severity: high. Detectors: never-repeat. Open kya report.");
  });
});

describe("kya alerts status and test", () => {
  async function status(extra: Record<string, string> = {}): Promise<string> {
    const out: string[] = [];
    await runAlerts({ io: { log: (l) => out.push(l), error: (l) => out.push(l) }, env: { ...env, ...extra }, sub: "status", flags: {} });
    return out.join("\n");
  }
  it("status says whether the local triage model is installed and whether desktop notification is on", async () => {
    expect(await status()).toContain("Local triage model: not installed");
    installFakeOrt(env);
    installFakeModel(env);
    const text = await status();
    expect(text).toContain("Local triage model: installed (kya-triage-v1)");
    expect(text).toContain("Desktop notification: off");
    expect(await status({ KYA_ALERTS_DESKTOP: "on" })).toContain("Desktop notification: on");
  });
  it("test sends a desktop notification with static text, marked as a test", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const out: string[] = [];
    await runAlerts({
      io: { log: (l) => out.push(l), error: (l) => out.push(l) },
      env: { ...env, KYA_ALERTS_DESKTOP: "on" },
      sub: "test",
      flags: {},
      desktop: { platform: "linux", run: async (c) => (calls.push({ file: c.file, args: c.args }), true) },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("notify-send");
    expect(calls[0]!.args).toContain("KYA security alert");
    expect(calls[0]!.args.join(" ")).toContain("Test. Severity: high.");
    expect(out.join("\n")).toContain("sent: desktop notification");
  });
});

describe("alert scan with the local model", () => {
  const NOW = new Date("2026-11-11T12:00:00.000Z");
  const ev = (minAgo: number): TrailEvent => ({
    ts: new Date(NOW.getTime() - minAgo * 60_000).toISOString(),
    sessionId: "S-SECRET-1",
    toolId: "mcp__postgres__drop_table",
    verdict: "DENY",
    reasonCode: "NEVER_EVENT",
    mode: "offline",
    neverEvent: true,
    summary: "drop table users",
  });
  const bodies: string[] = [];
  const deps = (extra: Record<string, unknown> = {}) => ({
    now: () => NOW,
    sleep: async () => undefined,
    fetchImpl: async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return { ok: true, status: 200 };
    },
    ...extra,
  });
  beforeEach(() => {
    bodies.length = 0;
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(
      join(home, ".kya", "config.json"),
      JSON.stringify({ alerts: { enabled: true }, notify: { webhooks: [{ url: "http://127.0.0.1:9/h", events: ["incident.opened"] }] } }),
    );
    for (const m of [3, 2, 1]) appendTrail(home, ev(m), env);
  });
  const sent = (): Array<{ incident: Record<string, any> }> => bodies.map((b) => JSON.parse(b));

  it("adds triage to the body and to the state entry; the severity is unchanged", async () => {
    installFakeOrt(env);
    installFakeModel(env);
    const r = await runAlertScan(home, env, deps());
    expect(r.alerted).toHaveLength(1);
    const inc = sent()[0]!.incident;
    expect(inc.severity).toBe("high");
    expect(inc.triage).toMatchObject({ model: "kya-triage-test", category: { id: "credential-access" }, action: { id: "rotate-secret" } });
    expect(readAlertsState(env)[0]!.triage?.category.id).toBe("credential-access");
  });

  it("no model files: the alert is still sent, without triage", async () => {
    const r = await runAlertScan(home, env, deps());
    expect(r.alerted).toHaveLength(1);
    expect(sent()[0]!.incident.triage).toBeUndefined();
    expect(sent()[0]!.incident.severity).toBe("high");
  });

  it("a model that throws does not suppress the alert", async () => {
    const r1 = await runAlertScan(home, env, deps({ triage: async () => { throw new Error("boom"); } }));
    expect(r1.alerted).toHaveLength(1);
    expect(r1.delivered).toBe(1);
    expect(sent()[0]!.incident.triage).toBeUndefined();
  });

  it("a hanging model: the alert goes out after the timeout, without triage", async () => {
    const t0 = Date.now();
    const r = await runAlertScan(home, env, deps({ triage: () => new Promise(() => undefined), triageTimeoutMs: 60 }));
    expect(r.alerted).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(sent()[0]!.incident.triage).toBeUndefined();
  });

  it("after one timeout the rest of the scan skips triage: two incidents, one model call, both alerts sent", async () => {
    for (const m of [3, 2, 1]) appendTrail(home, { ...ev(m), toolId: "mcp__other__format_disk" }, env);
    let calls = 0;
    const t0 = Date.now();
    const r = await runAlertScan(home, env, deps({ triage: () => (calls++, new Promise(() => undefined)), triageTimeoutMs: 80 }));
    expect(r.alerted).toHaveLength(2);
    expect(r.delivered).toBe(2);
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("the desktop notification does not wait for the model: it is shown even when the model never answers", async () => {
    const order: string[] = [];
    const r = await runAlertScan(
      home,
      { ...env, KYA_ALERTS_DESKTOP: "on" },
      deps({
        triage: async () => (order.push("triage"), undefined),
        desktop: { platform: "darwin" as const, run: async () => (order.push("desktop"), true) },
      }),
    );
    expect(r.alerted).toHaveLength(1);
    expect(order).toEqual(["desktop", "triage"]);
  });

  it("the model can say benign and ignore: a never-list incident still alerts, at the detector severity", async () => {
    installFakeOrt(env);
    installFakeModel(env);
    setEnv("FAKE_ORT_MODE", "benign");
    const r = await runAlertScan(home, env, deps());
    expect(r.alerted).toHaveLength(1);
    const inc = sent()[0]!.incident;
    expect(inc.severity).toBe("high");
    expect(inc.triage).toMatchObject({ category: { id: "benign-noise" }, urgency: { id: "ignore" } });
    expect(inc.triage.benign).toBeGreaterThan(0.99);
  });

  it("a retry reuses the stored triage and never calls the model or the desktop again", async () => {
    let modelCalls = 0;
    let desktopCalls = 0;
    const triage = async () => {
      modelCalls++;
      return { model: "m", category: { id: "credential-access", p: 0.9 }, urgency: { id: "within-hour", p: 0.8 }, action: { id: "rotate-secret", p: 0.7 }, benign: 0.05 };
    };
    const desktop = { platform: "darwin" as const, run: async () => { desktopCalls++; return true; } };
    let ok = false; // the first delivery fails: the entry stays pending
    const flaky = {
      now: () => NOW,
      sleep: async () => undefined,
      triage,
      desktop,
      fetchImpl: async (_u: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return { ok, status: ok ? 200 : 500 };
      },
    };
    const desktopOn = { ...env, KYA_ALERTS_DESKTOP: "on" };
    await runAlertScan(home, desktopOn, flaky);
    expect(readAlertsState(env)[0]).toMatchObject({ status: "pending", attempts: 1, triage: { model: "m" } });
    expect(modelCalls).toBe(1);
    expect(desktopCalls).toBe(1);
    ok = true;
    const later = { ...flaky, now: () => new Date(NOW.getTime() + 61_000) };
    await runAlertScan(home, desktopOn, later);
    expect(modelCalls).toBe(1); // not again
    expect(desktopCalls).toBe(1); // not again
    expect(readAlertsState(env)[0]).toMatchObject({ status: "sent", attempts: 2, triage: { model: "m" } });
    expect(sent().at(-1)!.incident.triage.model).toBe("m"); // the retry still carries the stored triage
  });

  it("a new occurrence of an alerted incident is a fresh alert: model and desktop run again", async () => {
    let modelCalls = 0;
    let desktopCalls = 0;
    const d = {
      ...deps(),
      triage: async () => (modelCalls++, undefined),
      desktop: { platform: "darwin" as const, run: async () => (desktopCalls++, true) },
    };
    const desktopOn = { ...env, KYA_ALERTS_DESKTOP: "on" };
    await runAlertScan(home, desktopOn, d);
    expect([modelCalls, desktopCalls]).toEqual([1, 1]);
    const later = new Date(NOW.getTime() + 300 * 60_000);
    for (const m of [3, 2, 1]) appendTrail(home, ev(m - 300), env); // ev() counts back from NOW: a negative age is later
    await runAlertScan(home, desktopOn, { ...d, now: () => later });
    expect([modelCalls, desktopCalls]).toEqual([2, 2]);
    expect(readAlertsState(env)).toHaveLength(1);
  });

  it("alerts off: the model is not loaded", async () => {
    writeFileSync(join(home, ".kya", "config.json"), JSON.stringify({ alerts: { enabled: false } }));
    installFakeOrt(env);
    installFakeModel(env);
    const marker = join(home, "m.txt");
    setEnv("FAKE_ORT_MARKER", marker);
    expect((await runAlertScan(home, env, deps())).alerted).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });
});

// Real model: golden predictions made with onnxruntime (Python, x86) on the int8 file.
const REAL_MODEL = process.env.KYA_TRIAGE_MODEL_PATH;
const REAL_ORT = process.env.KYA_TEST_ORT_PREFIX;
describe.skipIf(!REAL_MODEL || !REAL_ORT || !existsSync(join(REAL_ORT, "node_modules", "onnxruntime-node")))("real triage model (local build)", () => {
  const loadGolden = () => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "alerts", "triage-model-golden.json"), "utf8")) as {
    cases: Array<{ id: string; text: string; tokenIds: number[]; probs: Record<string, number[]> }>;
    labels: Record<string, string[]>;
  };
  let realEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    realEnv = { KYA_HOME: home, KYA_ALERTS_DESKTOP: "off", KYA_TRIAGE_MODEL_PATH: REAL_MODEL };
    mkdirSync(join(home, ".kya"), { recursive: true });
    symlinkSync(REAL_ORT!, triageRuntimeDir(realEnv)); // the folder itself is the opt-in prefix
  });

  it("tokenizer parity: the JS tokenizer gives the Hugging Face token ids of the golden cases", () => {
    const golden = loadGolden();
    const { meta } = parsePack(readFileSync(REAL_MODEL!));
    const tok = new BpeTokenizer(meta.tokenizer);
    for (const c of golden.cases) expect(tok.encode(c.text, meta.maxLen), c.id).toEqual(c.tokenIds);
  });

  it("golden predictions for 5 fixed cases (same choice, probabilities within 0.10), each under 100 ms after warm-up (soft)", async () => {
    const golden = loadGolden();
    await scoreText(golden.cases[0]!.text, realEnv); // load and warm up
    for (const c of golden.cases) {
      const t0 = performance.now();
      const r = await scoreText(c.text, realEnv);
      const ms = performance.now() - t0;
      if (ms > 100) console.warn(`triage inference ${c.id}: ${ms.toFixed(0)} ms (soft limit 100 ms)`);
      expect(ms, `${c.id} took ${ms} ms`).toBeLessThan(2_000); // hard cap only guards against a hang; the 100 ms target is the soft warning above
      // The golden file comes from Python onnxruntime on x86. int8 kernels differ by CPU (measured drift up to 0.05 on arm64): same choice, close probabilities.
      for (const h of ["category", "urgency", "action", "benign"] as const) {
        const top = (a: readonly number[]): number => a.indexOf(Math.max(...a));
        expect(top(r.probs[h]), `${c.id} ${h} choice`).toBe(top(c.probs[h]!));
        r.probs[h].forEach((p, i) => expect(Math.abs(p - c.probs[h]![i]!), `${c.id} ${h}[${i}]`).toBeLessThan(0.1));
      }
    }
  }, 60_000);
});
