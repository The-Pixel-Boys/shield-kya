// Real-stack e2e for `kya posture`: a loopback stub plays the hosted console, the real CLI
// functions and the real HTTP client run against it. Happy paths and denied paths.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { mapKey } from "../src/dash/input.js";
import { runPosture, type PostureIo } from "../src/commands/posture.js";
import { runPostureSend } from "../src/posture/send.js";
import { maybeSpawnPostureSend } from "../src/posture/spawn.js";
import { postureCard, setPostureShare } from "../src/posture/card.js";
import { readPostureConfig, readPostureState } from "../src/posture/store.js";
import { resolveConfig } from "../src/config.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import {
  DEVICE_ID,
  LABEL,
  NOW,
  PLANTED_ENV_NAME,
  PLANTED_ENV_VALUE,
  makePostureHome,
  writeHostedCredentials,
  type PostureHome,
} from "./support/posture-home.js";

interface Hit {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const stub = {
  hits: [] as Hit[],
  policy: { status: 200, body: { enabled: true } as unknown },
  report: { status: 204, body: undefined as unknown },
  server: undefined as Server | undefined,
  base: "",
};

function startStub(): Promise<void> {
  return new Promise((resolve) => {
    const s = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        stub.hits.push({ method: req.method ?? "", path: req.url ?? "", body });
        if (req.url === "/api/v1/kya/posture/policy") {
          res.writeHead(stub.policy.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(stub.policy.body));
          return;
        }
        if (req.url === "/api/v1/kya/posture") {
          res.writeHead(stub.report.status, { "Content-Type": "application/json" });
          res.end(stub.report.body === undefined ? "" : JSON.stringify(stub.report.body));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    stub.server = s;
    s.listen(0, "127.0.0.1", () => {
      stub.base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

const noNetwork = (() => {
  throw new Error("network must not be used on this path");
}) as unknown as typeof fetch;

function io(): PostureIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l) => out.push(l), error: (l) => err.push(l) };
}

const hits = (): Hit[] => stub.hits.splice(0);
const reportPosts = (): Hit[] => stub.hits.filter((h) => h.method === "POST");

let fx: PostureHome;

beforeAll(async () => {
  // The planted name also lives in the process environment, so a collector that reads it is caught.
  process.env[PLANTED_ENV_NAME] = PLANTED_ENV_VALUE;
  await startStub();
});
afterAll(async () => {
  delete process.env[PLANTED_ENV_NAME];
  await new Promise<void>((r) => stub.server?.close(() => r()));
});
afterEach(() => {
  if (fx) rmSync(fx.home, { recursive: true, force: true });
  stub.hits = [];
  stub.policy = { status: 200, body: { enabled: true } };
  stub.report = { status: 204, body: undefined };
});

function setup(hostedBaseUrl: string | undefined = stub.base): PostureHome {
  fx = makePostureHome({ hostedBaseUrl });
  return fx;
}

describe("posture toggle off: zero network", () => {
  it("status, dry run, send and the hook spawn make no request at all", async () => {
    const env = setup().env;
    const i = io();
    expect(await runPosture({ io: i, env, sub: "status", args: [], flags: {}, isTty: false, fetch: noNetwork })).toBe(0);
    expect(i.out.join("\n")).toContain("Posture sharing: off");
    expect(await runPosture({ io: i, env, sub: "send", args: [], flags: { "dry-run": true }, isTty: false, fetch: noNetwork })).toBe(0);
    expect(await runPosture({ io: i, env, sub: "send", args: [], flags: {}, isTty: false, fetch: noNetwork })).toBe(0);
    expect(i.out.join("\n")).toContain("Posture sharing is off. Nothing sent.");
    expect(await runPostureSend(env, { fetch: noNetwork })).toEqual({ outcome: "off" });
    const spawned: unknown[] = [];
    expect(maybeSpawnPostureSend({ env, entry: "/abs/cli.js", spawnImpl: (...a) => (spawned.push(a), { unref() {}, on() {} }) })).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(hits()).toHaveLength(0);
  });
});

describe("posture on: policy, body and denied paths", () => {
  it("sends one report whose body equals the golden report, with no planted or local value in it", async () => {
    const env = setup().env;
    expect(await runPosture({ io: io(), env, sub: "on", args: [], flags: { yes: true }, isTty: false })).toBe(0);
    expect(readPostureConfig(env).share).toBe(true);
    const result = await runPostureSend(env, { now: NOW });
    expect(result).toEqual({ outcome: "sent" });
    const sent = hits();
    expect(sent.map((h) => `${h.method} ${h.path}`)).toEqual([
      "GET /api/v1/kya/posture/policy",
      "POST /api/v1/kya/posture",
    ]);
    const body = JSON.parse(sent[1]!.body) as Record<string, unknown>;
    const golden = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "posture", "report.golden.json"), "utf8")) as Record<string, unknown>;
    // The stub login is stored, so the never-list mode is "hosted" here; the golden is the advisory case.
    expect(body["kyaVersion"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(body).toEqual({ ...golden, os: process.platform, arch: process.arch, kyaVersion: body["kyaVersion"], never: { listActive: true, mode: "hosted" } });
    expect(sent[1]!.body).not.toContain(PLANTED_ENV_VALUE);
    expect(sent[1]!.body).not.toContain(PLANTED_ENV_NAME);
    expect(sent[1]!.body).not.toContain("planted-url-secret");
    expect(sent[1]!.body).not.toContain("/Users/alice");
    expect(sent[1]!.body).not.toContain(fx.home);
    expect(readPostureState(env).lastSentAt).toBe(NOW.toISOString());
  });

  it("policy disabled: no report is posted, and the answer is cached", async () => {
    const env = setup().env;
    writeFileSync(join(fx.home, ".kya", "config.json"), JSON.stringify({ posture: { share: true, label: LABEL } }));
    stub.policy = { status: 200, body: { enabled: false } };
    expect(await runPostureSend(env, { now: NOW })).toEqual({ outcome: "policy-disabled" });
    expect(reportPosts()).toHaveLength(0);
    hits();
    expect(await runPostureSend(env, { now: new Date(NOW.getTime() + 3_600_000) })).toEqual({ outcome: "policy-disabled" });
    expect(hits()).toHaveLength(0);
  });

  it("a 403 from the report endpoint stops sending until the next daily policy check", async () => {
    const env = setup().env;
    writeFileSync(join(fx.home, ".kya", "config.json"), JSON.stringify({ posture: { share: true, label: LABEL } }));
    stub.report = { status: 403, body: { error: "posture_disabled" } };
    expect((await runPostureSend(env, { now: NOW })).outcome).toBe("rejected");
    expect(reportPosts()).toHaveLength(1);
    hits();
    expect((await runPostureSend(env, { now: new Date(NOW.getTime() + 3_600_000) })).outcome).toBe("policy-disabled");
    expect(hits()).toHaveLength(0);
    stub.report = { status: 204, body: undefined };
    expect((await runPostureSend(env, { now: new Date(NOW.getTime() + 25 * 3_600_000) })).outcome).toBe("sent");
    expect(hits().map((h) => h.method)).toEqual(["GET", "POST"]);
  });

  it("a non-loopback http console is refused: no request at all", async () => {
    const env = setup("http://example.com").env;
    writeFileSync(join(fx.home, ".kya", "config.json"), JSON.stringify({ posture: { share: true, label: LABEL } }));
    expect(await runPostureSend(env, { fetch: noNetwork, now: NOW })).toEqual({
      outcome: "no-credentials",
      detail: "no hosted login (kya login)",
    });
    expect(hits()).toHaveLength(0);
  });

  it("a report that fails the local check is never posted, and the CLI says why by path", async () => {
    const env = setup().env;
    writeFileSync(join(fx.home, ".kya", "config.json"), JSON.stringify({ posture: { share: true, label: LABEL } }));
    writeFileSync(join(fx.home, ".mcp.json"), JSON.stringify({ mcpServers: { [PLANTED_ENV_NAME]: { command: "x" } } }));
    const r = await runPostureSend(env, { now: NOW });
    expect(r.outcome).toBe("invalid");
    expect(r.detail).toContain("mcpServers[0].name");
    expect(reportPosts()).toHaveLength(0);
    expect(r.detail).not.toContain(PLANTED_ENV_NAME);
    const i = io();
    expect(await runPosture({ io: i, env, sub: "send", args: [], flags: {}, isTty: false, now: NOW })).toBe(1);
    expect(i.err.join("\n")).toContain("invalid");
  });

  it("the policy request timing out or failing leaves nothing sent and nothing cached", async () => {
    const env = setup().env;
    writeFileSync(join(fx.home, ".kya", "config.json"), JSON.stringify({ posture: { share: true, label: LABEL } }));
    stub.policy = { status: 500, body: {} };
    expect((await runPostureSend(env, { now: NOW })).outcome).toBe("policy-unavailable");
    expect(readPostureState(env).policy).toBeUndefined();
    expect(reportPosts()).toHaveLength(0);
  });
});

describe("kya posture on / off / label", () => {
  it("on without a terminal and without --yes refuses (exit 2) and changes nothing", async () => {
    const env = setup().env;
    const i = io();
    expect(await runPosture({ io: i, env, sub: "on", args: [], flags: {}, isTty: false, now: NOW })).toBe(2);
    expect(i.err.join("\n")).toContain("needs a terminal");
    expect(readPostureConfig(env).share).toBe(false);
  });

  it("on with a terminal asks first; a no keeps it off; off stops at once", async () => {
    const env = setup().env;
    const no = io();
    expect(await runPosture({ io: no, env, sub: "on", args: [], flags: {}, isTty: true, now: NOW, confirm: async () => false })).toBe(0);
    expect(readPostureConfig(env).share).toBe(false);
    const yes = io();
    expect(await runPosture({ io: yes, env, sub: "on", args: [], flags: {}, isTty: true, now: NOW, confirm: async () => true })).toBe(0);
    expect(readPostureConfig(env).share).toBe(true);
    const off = io();
    expect(await runPosture({ io: off, env, sub: "off", args: [], flags: {}, isTty: false })).toBe(0);
    expect(readPostureConfig(env).share).toBe(false);
    expect(await runPostureSend(env, { fetch: noNetwork, now: NOW })).toEqual({ outcome: "off" });
  });

  it("label keeps a plain name and refuses a user, host or environment name", async () => {
    const env = setup().env;
    const bad = io();
    expect(await runPosture({ io: bad, env, sub: "label", args: [PLANTED_ENV_NAME], flags: {}, isTty: false })).toBe(2);
    expect(readPostureConfig(env).label).toBe(LABEL);
    const ok = io();
    expect(await runPosture({ io: ok, env, sub: "label", args: ["desk-2"], flags: {}, isTty: false })).toBe(0);
    expect(readPostureConfig(env).label).toBe("desk-2");
  });
});

describe("live receipt server and the card", () => {
  it("the local toggle needs the live token; the card has no device id or label", async () => {
    const env = setup().env;
    const saved = process.env["KYA_HOME"];
    process.env["KYA_HOME"] = fx.home;
    try {
      const config = resolveConfig({ cwd: fx.home, offline: true, allowMissingApiKey: true, env: { KYA_OFFLINE: "1" }, flags: { offline: true } });
      const s = await startLiveReceiptServer({ config, days: 3 });
      try {
        const denied = await fetch(`http://127.0.0.1:${s.port}/action/posture`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ share: true }),
        });
        expect(denied.status).toBe(401);
        expect(readPostureConfig(env).share).toBe(false);

        const bad = await fetch(`http://127.0.0.1:${s.port}/action/posture?t=${s.token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ share: "yes" }),
        });
        expect(bad.status).toBe(400);

        const on = await fetch(`http://127.0.0.1:${s.port}/action/posture?t=${s.token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ share: true }),
        });
        expect(on.status).toBe(200);
        expect(readPostureConfig(env).share).toBe(true);
      } finally {
        await s.close();
      }
    } finally {
      if (saved === undefined) delete process.env["KYA_HOME"];
      else process.env["KYA_HOME"] = saved;
    }
    const card = JSON.stringify(postureCard(env, NOW));
    expect(card).not.toContain(DEVICE_ID);
    expect(card).not.toContain(LABEL);
    expect(card).not.toContain(fx.home);
    expect(setPostureShare(env, false)).toEqual({ ok: true, share: false });
  });
});

describe("hook-side spawn", () => {
  it("with the toggle on, starts one detached send a day and never a second one", () => {
    const env = setup().env;
    writeFileSync(join(fx.home, ".kya", "config.json"), JSON.stringify({ posture: { share: true } }));
    const spawned: { cmd: string; args: readonly string[] }[] = [];
    const spawnImpl = vi.fn((cmd: string, args: readonly string[]) => {
      spawned.push({ cmd, args });
      return { unref() {}, on() {} };
    });
    const first = maybeSpawnPostureSend({ env, entry: "/abs/cli.js", spawnImpl, nowMs: NOW.getTime() });
    const second = maybeSpawnPostureSend({ env, entry: "/abs/cli.js", spawnImpl, nowMs: NOW.getTime() + 1000 });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(["/abs/cli.js", "posture-send"]);
  });
});

describe("hook-side spawn, real CLI", () => {
  const cli = join(import.meta.dirname, "..", "dist", "cli.js");
  it.skipIf(!existsSync(cli))("kya hook starts one detached send that posts the report to the stub", async () => {
    const env = setup().env;
    writeFileSync(join(fx.home, ".kya", "config.json"), JSON.stringify({ posture: { share: true, label: LABEL } }));
    const payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "posture-e2e-1",
      cwd: fx.home,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const r = spawnSync(process.execPath, [cli, "hook", "--host", "claude"], { input: payload, env, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && reportPosts().length === 0) {
      await new Promise((ok) => setTimeout(ok, 100));
    }
    expect(reportPosts()).toHaveLength(1);
    expect(JSON.parse(reportPosts()[0]!.body)).toMatchObject({ deviceLabel: LABEL, schema: 1 });
  });
});

describe("dash key", () => {
  it("P is the posture key; p stays the refresh key", () => {
    expect(mapKey("P")).toEqual({ type: "posture-toggle" });
    expect(mapKey("p")).toEqual({ type: "toggle-auto-refresh" });
  });
});
