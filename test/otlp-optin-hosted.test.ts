/**
 * OTLP map-attribute opt-in (otlpExport.mapAttrs, feature kya-otlp-map-attrs) for both hook modes.
 * - The opt-in file check uses the real project dir of the call, not the process cwd (the hosted hook spawns
 *   notify-flush from home), and refuses hard links.
 * - Wiring: both hook modes hand the project dir to notify-flush; a repo env value for it never survives.
 * - The B1 attack cases (env, KYA_HOME=., HOME=., planted dirs, project config) run against the real hook in both
 *   modes: spans arrive at a loopback sink, never with map attributes.
 * The positive case needs the passwd home, which a test cannot plant, so it uses the passwdHome function seam.
 */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, type Stats } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { optInHint, optInRefusal, readOptInConfig } from "../src/otel/map-attrs-optin.js";

const captured: Array<{ cwd: string; projectDir?: string }> = [];
vi.mock("../src/notify/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify/dispatch.js")>();
  return {
    ...actual,
    maybeSpawnNotifyFlush: (d: { cwd: string; projectDir?: string }) => {
      captured.push({ cwd: d.cwd, projectDir: d.projectDir });
      return false;
    },
  };
});

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const KEY = ["sk", "live", "OPTINTESTKEY0123456789abcdef"].join("_");
const AGENT = "0190f2a4-7c1e-7d3a-9b2c-123456789abc";
const RAW_SESSION = "raw-host-session-optin-4b2d";

const dirs: string[] = [];
const servers: Server[] = [];
function tmp(prefix: string, base = tmpdir()): string {
  const d = realpathSync(mkdtempSync(join(base, prefix)));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  // The hook's detached export helper can still write under $HOME/.kya after the hook exits:
  // rmSync then meets ENOTEMPTY. Node retries ENOTEMPTY/EBUSY with maxRetries.
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  captured.length = 0;
});

const OPT_IN = (endpoint: string) => JSON.stringify({ otlpExport: { endpoint, mapAttrs: true } });

/** A passwd-home stand-in with a valid 0600 opt-in file. */
function homeWithOptIn(base?: string): { home: string; file: string } {
  const home = tmp("kya-optin-home-", base);
  mkdirSync(join(home, ".kya"));
  const file = join(home, ".kya", "config.json");
  writeFileSync(file, OPT_IN("http://127.0.0.1:4318"), { mode: 0o600 });
  return { home, file };
}

describe("opt-in file check: project dir of the call, not the process cwd", () => {
  it("hosted shape: the home is the process cwd, the project is elsewhere: accepted", () => {
    // The home sits under process.cwd(), as for the hosted hook's notify-flush (cwd = home).
    const h = homeWithOptIn(process.cwd());
    const project = tmp("kya-optin-proj-");
    expect(optInRefusal(h.file, h.home, project)).toBeUndefined();
    expect(readOptInConfig(project, { passwdHome: () => h.home })).toMatchObject({ otlpExport: { mapAttrs: true } });
  });

  it("a repo checked out at the home (dotfiles in ~) with a committed .kya/config.json: refused", () => {
    const h = homeWithOptIn();
    expect(optInRefusal(h.file, h.home, h.home)).toBe("under the project dir");
    expect(readOptInConfig(h.home, { passwdHome: () => h.home })).toBeUndefined();
  });

  it("a symlink from the home into the project: refused", () => {
    const h = homeWithOptIn();
    const project = join(h.home, "work", "repo");
    mkdirSync(project, { recursive: true });
    const planted = join(project, "planted.json");
    writeFileSync(planted, OPT_IN("http://127.0.0.1:4318"), { mode: 0o600 });
    rmSync(h.file);
    symlinkSync(planted, h.file);
    expect(optInRefusal(h.file, h.home, project)).toBe("under the project dir");
  });

  it("a hard link (nlink 2) to a file in the project: refused", () => {
    const h = homeWithOptIn();
    const project = tmp("kya-optin-proj-");
    linkSync(h.file, join(project, "shared.json"));
    expect(optInRefusal(h.file, h.home, project)).toBe("hard link");
    expect(readOptInConfig(project, { passwdHome: () => h.home })).toBeUndefined();
  });

  it("no project dir, or a relative one: refused (fail closed)", () => {
    const h = homeWithOptIn();
    expect(optInRefusal(h.file, h.home, undefined)).toBe("no project dir");
    expect(optInRefusal(h.file, h.home, "")).toBe("no project dir");
    expect(optInRefusal(h.file, h.home, "./repo")).toBe("no project dir");
    expect(readOptInConfig(undefined, { passwdHome: () => h.home })).toBeUndefined();
  });
});

describe("one open, one fd: the file read is the file checked", () => {
  it("the owner, mode and link checks run on fstat of the opened fd", () => {
    const h = homeWithOptIn();
    const project = tmp("kya-optin-proj-");
    const real = statSync(h.file);
    let calls = 0;
    const fstat = (fd: number): Stats => {
      calls += 1;
      expect(typeof fd).toBe("number");
      return { ...real, uid: real.uid + 1, isFile: () => true } as unknown as Stats;
    };
    // Path checks pass (real stat); the opened fd says another owner: refused.
    expect(readOptInConfig(project, { passwdHome: () => h.home, fstat })).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("a swap after the checks: a symlink is not followed, a group-writable file is refused", () => {
    const h = homeWithOptIn();
    const project = tmp("kya-optin-proj-");
    const evil = join(project, "evil.json");
    writeFileSync(evil, OPT_IN("https://collector.attacker.example"), { mode: 0o600 });
    const toLink = (p: string): void => {
      rmSync(p);
      symlinkSync(evil, p);
    };
    expect(readOptInConfig(project, { passwdHome: () => h.home, beforeOpen: toLink })).toBeUndefined();
    const h2 = homeWithOptIn();
    const toWide = (p: string): void => {
      rmSync(p);
      writeFileSync(p, OPT_IN("https://collector.attacker.example"));
      chmodSync(p, 0o666);
    };
    expect(readOptInConfig(project, { passwdHome: () => h2.home, beforeOpen: toWide })).toBeUndefined();
    // Control: no swap, same file, accepted.
    const h3 = homeWithOptIn();
    expect(readOptInConfig(project, { passwdHome: () => h3.home })).toMatchObject({ otlpExport: { mapAttrs: true } });
  });
});

describe("kya doctor hint (optInHint): one line when the opt-in is refused", () => {
  it("group-writable file: the hint names chmod 600; a valid file or no mapAttrs: no hint", () => {
    const h = homeWithOptIn();
    const project = tmp("kya-optin-proj-");
    expect(optInHint(project, { passwdHome: () => h.home })).toBeUndefined();
    chmodSync(h.file, 0o660);
    const hint = optInHint(project, { passwdHome: () => h.home })!;
    expect(hint).toContain("is ignored (group or world writable)");
    expect(hint).toContain(`Run "chmod 600 ${h.file}". See docs/otlp.md.`);
    expect(hint.split("\n")).toHaveLength(1);
    writeFileSync(h.file, JSON.stringify({ otlpExport: { endpoint: "http://127.0.0.1:4318" } }));
    expect(optInHint(project, { passwdHome: () => h.home })).toBeUndefined();
  });

  it("hard link: the hint names the reason", () => {
    const h = homeWithOptIn();
    const project = tmp("kya-optin-proj-");
    linkSync(h.file, join(project, "shared.json"));
    expect(optInHint(project, { passwdHome: () => h.home })).toContain("(hard link)");
  });
});

describe("dispatch: the project dir reaches notify-flush and a repo value never survives", () => {
  it("sets KYA_NOTIFY_PROJECT_DIR from the parent, over a repo env value; empty when unknown", async () => {
    const { maybeSpawnNotifyFlush, NOTIFY_PROJECT_DIR_VAR } = await vi.importActual<typeof import("../src/notify/dispatch.js")>("../src/notify/dispatch.js");
    const seen: NodeJS.ProcessEnv[] = [];
    const spawnImpl = ((_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      seen.push(opts.env);
      return { on: () => undefined, unref: () => undefined } as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    const env = { KYA_OTLP_EXPORT_ENDPOINT: "http://127.0.0.1:1", [NOTIFY_PROJECT_DIR_VAR]: "/evil/elsewhere" };
    const event = { ts: "2026-11-04T00:00:00.000Z", sessionId: "s", toolId: "Bash", verdict: "DENY", reasonCode: "NEVER_EVENT", mode: "offline" as const };
    const cwd = tmp("kya-disp-");
    expect(maybeSpawnNotifyFlush({ env, cwd, event, entry: "x.js", spawnImpl, projectDir: "/real/project" })).toBe(true);
    expect(maybeSpawnNotifyFlush({ env, cwd, event, entry: "x.js", spawnImpl })).toBe(true);
    expect(seen.map((e) => e[NOTIFY_PROJECT_DIR_VAR])).toEqual(["/real/project", ""]);
  });

  it("both hook modes pass the call's project dir; the hosted hook keeps cwd = home", async () => {
    const { runHook } = await import("../src/commands/hook.js");
    const home = tmp("kya-wire-home-");
    const project = tmp("kya-wire-proj-");
    const stdinText = JSON.stringify({ hook_event_name: "PreToolUse", session_id: RAW_SESSION, cwd: project, tool_name: "Bash", tool_input: { command: "rm -rf ~" }, tool_use_id: "t1" });
    await runHook({ host: "claude", strict: false, stdinText, env: { HOME: home, KYA_HOME: home }, cwd: tmp("kya-wire-other-") });
    const planeDir = tmp("kya-wire-plane-");
    const cfg = join(planeDir, "hosted.json");
    writeFileSync(cfg, JSON.stringify({ baseUrl: "https://plane.example.test", apiKey: KEY, agentId: AGENT }));
    chmodSync(cfg, 0o600);
    const fetch = (async () => new Response(JSON.stringify({ verdict: "DENY", reasonCode: "POLICY_DENY", toolId: "Read" }), { status: 200, headers: { "content-type": "application/json" } })) as never;
    const hostedStdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: RAW_SESSION, cwd: project, tool_name: "Read", tool_input: { file_path: join(project, "a.ts") }, tool_use_id: "t2" });
    await runHook({ host: "claude", strict: false, failClosed: false, stdinText: hostedStdin, env: { HOME: home }, cwd: project, plane: { configPath: cfg, shadow: false, budgetMs: 3000, allowHttpLoopback: false, fetch } });
    expect(captured).toEqual([
      { cwd: project, projectDir: project },
      { cwd: home, projectDir: project },
    ]);
  });
});

// ---- real processes: the B1 attack cases in both hook modes ----

async function sink(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

/** Loopback plane that denies every call (hosted mode). */
async function plane(): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ verdict: "DENY", reasonCode: "POLICY_DENY", toolId: "Read" })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function hook(args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "hook", "--host", "claude", ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", KYA_TELEMETRY: "0", KYA_UPDATE_CHECK: "0", KYA_SKIP_NODE_CHECK: "1", ...env },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin!.end(stdin);
  });
}

/** The detached notify-flush child sends after the hook exits: wait for n bodies. */
async function bodiesAfter(s: { bodies: string[] }, n: number): Promise<string[]> {
  for (let i = 0; i < 100 && s.bodies.length < n; i++) await new Promise((r) => setTimeout(r, 100));
  return s.bodies;
}

type Attr = { key: string; value: { stringValue?: string } };
const attrs = (body: string): Record<string, string> => {
  const p = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: { attributes: Attr[] }[] }[] }[] };
  return Object.fromEntries(p.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.map((a) => [a.key, a.value.stringValue ?? ""]));
};

function expectNoMapAttrs(bodies: string[], label: string): void {
  expect(bodies.length, label).toBeGreaterThanOrEqual(1);
  for (const b of bodies) {
    const a = attrs(b);
    expect(a["kya.device"], label).toBeUndefined();
    expect(a["kya.target.class"], label).toBeUndefined();
    // Opt-in off: the session id is the raw one, as before.
    expect(a["kya.session_id"], label).toBe(RAW_SESSION);
  }
}

describe("real hook, both modes: repo-controlled sources never turn the map attributes on", { timeout: 120_000 }, () => {
  it("OSS hook: env toggle, project config, KYA_HOME=., HOME=., planted absolute dir", async () => {
    const cases: Array<[string, (p: string, url: string) => NodeJS.ProcessEnv]> = [
      ["env endpoint + toggle", (_p, url) => ({ HOME: tmp("kya-h-"), KYA_HOME: tmp("kya-kh-"), KYA_OTLP_EXPORT_ENDPOINT: url, KYA_OTLP_MAP_ATTRS: "on" })],
      ["project config", () => ({ HOME: tmp("kya-h-"), KYA_HOME: tmp("kya-kh-") })],
      ["KYA_HOME=.", () => ({ HOME: tmp("kya-h-"), KYA_HOME: "." })],
      ["HOME=.", () => ({ HOME: "." })],
      ["planted absolute HOME and KYA_HOME", (_p, url) => {
        const planted = tmp("kya-planted-");
        mkdirSync(join(planted, ".kya"));
        writeFileSync(join(planted, ".kya", "config.json"), OPT_IN(url), { mode: 0o600 });
        return { HOME: planted, KYA_HOME: planted };
      }],
    ];
    for (const [label, envOf] of cases) {
      const s = await sink();
      const project = tmp("kya-repo-");
      mkdirSync(join(project, ".kya"));
      writeFileSync(join(project, ".kya", "config.json"), OPT_IN(s.url), { mode: 0o600 });
      const stdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: RAW_SESSION, cwd: project, tool_name: "Bash", tool_input: { command: "rm -rf ~" }, tool_use_id: `t-${label}` });
      expect(await hook([], envOf(project, s.url), project, stdin), label).toBe(2);
      expectNoMapAttrs(await bodiesAfter(s, 1), label);
    }
  });

  it("hosted hook: planted HOME config, KYA_HOME=. with project config, env toggle: spans without map attributes", async () => {
    const base = await plane();
    const planeDir = tmp("kya-plane-");
    const cfg = join(planeDir, "hosted.json");
    writeFileSync(cfg, JSON.stringify({ baseUrl: base, apiKey: KEY, agentId: AGENT }));
    chmodSync(cfg, 0o600);
    const cases: Array<[string, (url: string) => NodeJS.ProcessEnv]> = [
      ["planted HOME with endpoint + mapAttrs", () => ({})],
      ["KYA_HOME=. and project config", () => ({ KYA_HOME: "." })],
      ["env toggle and env endpoint", (url) => ({ KYA_OTLP_MAP_ATTRS: "on", KYA_OTLP_EXPORT_ENDPOINT: url })],
    ];
    for (const [label, extra] of cases) {
      const s = await sink();
      const home = tmp("kya-hosted-home-");
      mkdirSync(join(home, ".kya"));
      writeFileSync(join(home, ".kya", "config.json"), OPT_IN(s.url), { mode: 0o600 });
      const project = tmp("kya-repo-");
      mkdirSync(join(project, ".kya"));
      writeFileSync(join(project, ".kya", "config.json"), OPT_IN(s.url), { mode: 0o600 });
      const stdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: RAW_SESSION, cwd: project, tool_name: "Read", tool_input: { file_path: join(project, "a.ts") }, tool_use_id: `h-${label}` });
      expect(await hook(["--plane-config", cfg, "--plane-allow-http-loopback"], { HOME: home, ...extra(s.url) }, project, stdin), label).toBe(2);
      expectNoMapAttrs(await bodiesAfter(s, 1), label);
    }
  });

  it("hosted hook with HOME=.: no notify-flush runs, so a project config cannot pick the sink", async () => {
    const base = await plane();
    const planeDir = tmp("kya-plane-");
    const cfg = join(planeDir, "hosted.json");
    writeFileSync(cfg, JSON.stringify({ baseUrl: base, apiKey: KEY, agentId: AGENT }));
    chmodSync(cfg, 0o600);
    const s = await sink();
    const project = tmp("kya-repo-");
    mkdirSync(join(project, ".kya"));
    writeFileSync(join(project, ".kya", "config.json"), OPT_IN(s.url), { mode: 0o600 });
    const stdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: RAW_SESSION, cwd: project, tool_name: "Read", tool_input: { file_path: join(project, "a.ts") }, tool_use_id: "h-dot" });
    expect(await hook(["--plane-config", cfg, "--plane-allow-http-loopback"], { HOME: "." }, project, stdin)).toBe(2);
    await new Promise((r) => setTimeout(r, 2500));
    expect(s.bodies).toHaveLength(0);
  });
});
