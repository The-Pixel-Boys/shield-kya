/**
 * Opt-in telemetry: host detection, the plugin's hosted-linked flag and the internal marker, end to
 * end. The REAL built CLI (`dist/cli.js`, and the real Claude plugin shim around it) runs as a child
 * process against a REAL local HTTP collector, with a temp KYA_HOME. Needs `pnpm build` first.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "dist", "cli.js");
const SHIM = join(PKG, "plugins", "kya", "scripts", "kya.mjs");
const ID = "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c";
const SECRET = "sk_live_E2E_SECRET_KEY_123";

type Body = Record<string, unknown>;

let home: string;
let cwd: string;
let data: string;
let server: Server;
let raw: string[];
let pings: Body[];
let base: string;
const children: ChildProcess[] = [];

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js missing: run `pnpm build` before this e2e test");
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kya-host-home-"));
  cwd = mkdtempSync(join(tmpdir(), "kya-host-cwd-"));
  data = mkdtempSync(join(tmpdir(), "kya-host-data-"));
  raw = [];
  pings = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      raw.push(text);
      try {
        pings.push(JSON.parse(text) as Body);
      } catch {
        /* keep raw only */
      }
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/telemetry/kya`;
  mkdirSync(join(home, ".kya"), { recursive: true });
  writeFileSync(
    join(home, ".kya", "telemetry.json"),
    JSON.stringify({ enabled: true, installId: ID, askedAt: "2026-10-08T00:00:00.000Z" }),
  );
});

afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const d of [home, cwd, data]) rmSync(d, { recursive: true, force: true });
});

/** A clean env: never inherit CI, DO_NOT_TRACK, CLAUDECODE or a developer's KYA_* settings. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    KYA_HOME: home,
    KYA_SKIP_NODE_CHECK: "1",
    KYA_OFFLINE: "1",
    KYA_TELEMETRY_URL: base,
    ...extra,
  };
}

const initialize = (name: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name, version: "1" } },
  }) + "\n";

/** Runs `node <entry> serve-mcp --stdio`, sends `input`, closes stdin, resolves on exit. */
function serveMcp(entry: string, e: NodeJS.ProcessEnv, input: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, "serve-mcp", "--stdio"], { env: e, cwd, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.write(input);
    // Give the initialize reply and the first ping time to go out before the clean shutdown.
    setTimeout(() => child.stdin.end(), 700);
  });
}

/** The Claude plugin shim, pointed at the real built package the way bootstrap.mjs would install it. */
function pluginData(): string {
  const scope = join(data, "node_modules", "@shield-agent");
  mkdirSync(scope, { recursive: true });
  symlinkSync(PKG, join(scope, "kya"));
  return data;
}

describe("host from the MCP client (real process, real collector)", () => {
  it("claude-code initialize: later events carry host claude, stdout stays pure JSON-RPC", async () => {
    const r = await serveMcp(CLI, env(), initialize("claude-code"));

    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n").every((l) => (JSON.parse(l) as Body)["jsonrpc"] === "2.0")).toBe(true);
    expect(pings.map((p) => p["event"])).toEqual(["start", "heartbeat", "end"]);
    expect(pings.map((p) => p["hostId"])).toEqual(["unknown", "claude", "claude"]);
    expect(new Set(pings.map((p) => p["sessionId"])).size).toBe(1);
  });

  it("an unknown client name is sent as other, never as typed", async () => {
    await serveMcp(CLI, env(), initialize("ACME-private-agent for jane@example.com"));

    expect(pings.at(-1)?.["hostId"]).toBe("other");
    expect(raw.join("")).not.toMatch(/acme|jane|example/i);
  });

  it("the CLAUDECODE marker names the host before any initialize arrives", async () => {
    await serveMcp(CLI, env({ CLAUDECODE: "1" }), "");

    expect(pings.length).toBeGreaterThan(0);
    expect(pings.every((p) => p["hostId"] === "claude")).toBe(true);
    expect(raw.join("")).not.toContain("CLAUDECODE");
  });

  it("a connect-written session id wins over the client name", async () => {
    await serveMcp(CLI, env({ KYA_SESSION_ID: "mcp:cursor" }), initialize("claude-code"));

    expect(pings.every((p) => p["hostId"] === "cursor")).toBe(true);
  });
});

describe("Claude plugin shim and hostedLinked (real process)", () => {
  it("a plugin user with KYA_API_KEY reports hostedLinked true and the key never leaves", async () => {
    const e = env({ CLAUDE_PLUGIN_DATA: pluginData(), KYA_API_KEY: SECRET, SHIELD_API_KEY: SECRET });

    const r = await serveMcp(SHIM, e, initialize("claude-code"));

    expect(r.code).toBe(0);
    expect(pings.length).toBeGreaterThan(0);
    expect(pings.every((p) => p["hostedLinked"] === true)).toBe(true);
    expect(pings.at(-1)?.["hostId"]).toBe("claude");
    expect(raw.join("")).not.toContain(SECRET);
    expect(raw.join("")).not.toContain("sk_live");
  });

  it("a plugin user without any key reports hostedLinked false", async () => {
    await serveMcp(SHIM, env({ CLAUDE_PLUGIN_DATA: pluginData() }), initialize("claude-code"));

    expect(pings.length).toBeGreaterThan(0);
    expect(pings.every((p) => p["hostedLinked"] === false)).toBe(true);
  });

  it("an empty key does not count as linked", async () => {
    await serveMcp(SHIM, env({ CLAUDE_PLUGIN_DATA: pluginData(), KYA_API_KEY: "  " }), initialize("claude-code"));

    expect(pings.every((p) => p["hostedLinked"] === false)).toBe(true);
  });
});

describe("internal marker and the off switches (real process)", () => {
  it("KYA_TELEMETRY_INTERNAL=1 puts internal:true on every ping", async () => {
    await serveMcp(CLI, env({ KYA_TELEMETRY_INTERNAL: "1" }), initialize("claude-code"));

    expect(pings.length).toBeGreaterThan(0);
    expect(pings.every((p) => p["internal"] === true)).toBe(true);
  });

  it("without it no ping has an internal field", async () => {
    await serveMcp(CLI, env(), initialize("claude-code"));

    expect(pings.length).toBeGreaterThan(0);
    expect(pings.every((p) => !("internal" in p))).toBe(true);
  });

  it("DO_NOT_TRACK sends nothing, even with the internal marker and a known client", async () => {
    const r = await serveMcp(CLI, env({ DO_NOT_TRACK: "1", KYA_TELEMETRY_INTERNAL: "1" }), initialize("claude-code"));

    expect(r.code).toBe(0);
    expect(raw).toEqual([]);
  });

  it("no opt-in sends nothing", async () => {
    rmSync(join(home, ".kya", "telemetry.json"));

    await serveMcp(CLI, env({ KYA_TELEMETRY_INTERNAL: "1" }), initialize("claude-code"));

    expect(raw).toEqual([]);
  });
});
