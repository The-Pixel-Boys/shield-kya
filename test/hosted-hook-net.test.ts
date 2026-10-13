/**
 * Hosted hook transport against real loopback sockets, driven through the
 * built dist/cli.js (review of #388, HIGH-1 and L2/L3): self-signed TLS, TLS
 * and CA env overrides, env proxies, redirects, a lingering keep-alive socket,
 * a plane that never answers, a slow-loris body, and a DNS failure.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Spawned CLIs can be slow under parallel load (r4 MED-2): generous per-test timeout.
vi.setConfig({ testTimeout: 15_000 });
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshTestHome } from "./setup.js";

// Built at runtime: see hosted-hook.test.ts (a literal would trip GitHub push protection on the public mirror).
const KEY = ["sk", "live", "NETTESTKEY0123456789abcdef"].join("_");
const AGENT = "0190f2a4-7c1e-7d3a-9b2c-123456789abc";
const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const PAYLOAD = JSON.stringify({
  hook_event_name: "PreToolUse", session_id: "s-net", cwd: "/p",
  tool_name: "Read", tool_input: { file_path: "/p/a.ts" }, tool_use_id: "toolu_net",
});

interface Seen { requests: Array<{ headers: IncomingMessage["headers"] }>; connections: number }

function planeFile(baseUrl: string): string {
  const p = join(tmp("kya-plane-"), "hosted.json");
  writeFileSync(p, JSON.stringify({ baseUrl, apiKey: KEY, agentId: AGENT }));
  chmodSync(p, 0o600);
  return p;
}

function hook(baseUrl: string, extra: string[] = [], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string; ms: number }> {
  const cfg = planeFile(baseUrl);
  const t0 = Date.now();
  return new Promise((ok) => {
    const child = spawn(process.execPath, [cliJs, "hook", "--host", "claude", "--plane-config", cfg, "--plane-allow-http-loopback", ...extra], {
      cwd: tmp("kya-proj-"),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: freshTestHome(), KYA_SKIP_NODE_CHECK: "1", KYA_TELEMETRY: "0", ...env },
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => ok({ status, stdout, stderr, ms: Date.now() - t0 }));
    child.stdin.end(PAYLOAD);
  });
}

async function listen(server: Server | NetServer): Promise<number> {
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return (server.address() as { port: number }).port;
}

/** Plain-http stub (argv loopback mode) with a scripted handler. */
async function httpStub(handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ port: number; seen: Seen; server: Server }> {
  const seen: Seen = { requests: [], connections: 0 };
  const server = createHttpServer((req, res) => { seen.requests.push({ headers: req.headers }); handler(req, res); });
  server.on("connection", () => { seen.connections++; });
  return { port: await listen(server), seen, server };
}

const reason = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason as string;
const ALLOW_BODY = JSON.stringify({ verdict: "ALLOW", reasonCode: "ALLOW", toolId: "Read" });

let certDir = "";
let tlsPort = 0;
let tlsServer: Server;
const tlsSeen: Seen = { requests: [], connections: 0 };
const open: Array<Server | NetServer> = [];

beforeAll(async () => {
  expect(existsSync(cliJs), "dist/cli.js missing - run pnpm build first").toBe(true);
  certDir = tmp("kya-cert-");
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  tlsServer = createHttpsServer(
    { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) },
    (req, res) => { tlsSeen.requests.push({ headers: req.headers }); res.writeHead(200, { "content-type": "application/json" }); res.end(ALLOW_BODY); },
  );
  tlsServer.on("secureConnection", () => { tlsSeen.connections++; });
  tlsPort = await listen(tlsServer);
});

afterAll(() => {
  tlsServer?.close();
  for (const s of open) s.close();
});

describe("hosted hook transport (real sockets, dist/cli.js)", () => {
  it("(a) self-signed plane cert: fails closed, the server never sees a request or the key", async () => {
    const before = tlsSeen.requests.length;
    const r = await hook(`https://127.0.0.1:${tlsPort}`, ["--plane-budget-ms", "800"]);
    expect(r.status).toBe(2);
    expect(reason(r.stdout)).toContain("PLANE_UNREACHABLE");
    expect(tlsSeen.requests.length).toBe(before);
  });

  it("(b) NODE_TLS_REJECT_UNAUTHORIZED=0 is refused before any network: PLANE_ENV_REFUSED", async () => {
    const before = { ...tlsSeen, requests: tlsSeen.requests.length };
    const r = await hook(`https://127.0.0.1:${tlsPort}`, [], { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    expect(r.status).toBe(2);
    expect(reason(r.stdout)).toContain("PLANE_ENV_REFUSED");
    expect(reason(r.stdout)).toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    expect(tlsSeen.requests.length).toBe(before.requests);
    expect(tlsSeen.connections).toBe(before.connections);
  });

  it("(c) NODE_EXTRA_CA_CERTS trusting the plane cert is refused: the server receives nothing", async () => {
    const before = { requests: tlsSeen.requests.length, connections: tlsSeen.connections };
    const ca = join(certDir, "cert.pem");
    const r = await hook(`https://127.0.0.1:${tlsPort}`, [], { NODE_EXTRA_CA_CERTS: ca });
    expect(r.status).toBe(2);
    expect(reason(r.stdout)).toContain("PLANE_ENV_REFUSED");
    expect(r.stdout + r.stderr).not.toContain(ca);
    expect(tlsSeen.requests.length).toBe(before.requests);
    expect(tlsSeen.connections).toBe(before.connections);
  });

  it("(d) env proxy: the switch is refused; a bare HTTPS_PROXY is ignored and the proxy sees nothing", async () => {
    let proxyConnections = 0;
    const proxy = createNetServer((s) => { proxyConnections++; s.destroy(); });
    open.push(proxy);
    const proxyPort = await listen(proxy);
    const plane = await httpStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(ALLOW_BODY); });
    open.push(plane.server);
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const refused = await hook(`http://127.0.0.1:${plane.port}`, [], { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NODE_USE_ENV_PROXY: "1" });
    expect(refused.status).toBe(2);
    expect(reason(refused.stdout)).toContain("PLANE_ENV_REFUSED");
    expect(plane.seen.requests).toHaveLength(0);

    const viaOpt = await hook(`http://127.0.0.1:${plane.port}`, [], { HTTPS_PROXY: proxyUrl, NODE_OPTIONS: "--use-env-proxy" });
    expect(viaOpt.status).toBe(2);
    expect(reason(viaOpt.stdout)).toContain("PLANE_ENV_REFUSED");

    const bare = await hook(`http://127.0.0.1:${plane.port}`, [], { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl });
    expect(bare.status).toBe(0);
    expect(plane.seen.requests).toHaveLength(1);
    expect(proxyConnections).toBe(0);
  });

  it("(e) a 307 to a second server fails closed; the second server never sees the key", async () => {
    const second = await httpStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(ALLOW_BODY); });
    open.push(second.server);
    const first = await httpStub((_q, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${second.port}/api/v1/kya/policy/evaluate` }); res.end(); });
    open.push(first.server);
    const r = await hook(`http://127.0.0.1:${first.port}`);
    expect(r.status).toBe(2);
    expect(reason(r.stdout)).toMatch(/redirect/);
    expect(first.seen.requests).toHaveLength(1);
    expect(second.seen.connections).toBe(0);
  });

  it("(HIGH-A) NODE_DEBUG=https / * / HTTP* is refused: exit 2, no key on stderr, the plane sees nothing", async () => {
    const plane = await httpStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(ALLOW_BODY); });
    open.push(plane.server);
    for (const v of ["https", "*", "HTTP*", "http,net"]) {
      const r = await hook(`http://127.0.0.1:${plane.port}`, [], { NODE_DEBUG: v });
      expect(r.status, v).toBe(2);
      expect(reason(r.stdout), v).toContain("PLANE_ENV_REFUSED");
      expect(reason(r.stdout), v).toContain("NODE_DEBUG");
      expect(r.stdout + r.stderr, v).not.toContain("NETTESTKEY");
    }
    expect(plane.seen.requests).toHaveLength(0);
  });

  it("(MED-1) an endless response body is cut at 64 KiB and fails closed fast", async () => {
    const timers: NodeJS.Timeout[] = [];
    const plane = await httpStub((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      const pump = () => { while (res.write(chunk)) { /* fill */ } };
      res.on("drain", pump);
      pump();
      const t = setInterval(() => undefined, 1000);
      timers.push(t);
      res.on("close", () => clearInterval(t));
    });
    open.push(plane.server);
    const r = await hook(`http://127.0.0.1:${plane.port}`, ["--plane-budget-ms", "3000"]);
    timers.forEach(clearInterval);
    expect(r.status).toBe(2);
    expect(reason(r.stdout)).toMatch(/too large/);
    expect(r.ms).toBeLessThan(2500);
  });

  /**
   * Real wiring of the cli.ts crash handler and output guard. The preload is TEST-ONLY node argv
   * (`node --require <file> dist/cli.js`), never env. No fixed timers (r4 MED-2): it polls every
   * 20 ms until the hosted crash handler is registered (process.listenerCount) AND, unless
   * `beforeStdin`, the plane stub has written its "request received" marker (so the key is
   * loaded). Then it writes the key to stderr (exact, split across two writes, base64) and throws
   * or rejects. 10 s cap, then PRELOAD_TIMEOUT. With `beforeStdin` the test sends stdin only
   * after the preload has fired.
   */
  function crashHook(opts: { tool?: string; shadow?: boolean; mode: "throw" | "reject"; beforeStdin?: boolean }) {
    return (async () => {
      const key = KEY;
      const dir = tmp("kya-preload-");
      const marker = join(dir, "plane-hit");
      const fired = join(dir, "fired");
      const plane = await httpStub((_q, res) => {
        writeFileSync(marker, "1");
        setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(ALLOW_BODY); }, 12_000);
      });
      open.push(plane.server);
      const preload = join(dir, "preload.cjs");
      const b64 = Buffer.from(key).toString("base64");
      writeFileSync(preload, `const fs = require("fs");
const start = Date.now();
const ready = () => process.listenerCount("uncaughtException") > 0 && ${opts.beforeStdin ? "true" : `fs.existsSync(${JSON.stringify(marker)})`};
const tick = () => {
  if (ready()) {
    fs.writeFileSync(${JSON.stringify(fired)}, "1");
    process.stderr.write("preload exact ${key}\\n");
    process.stderr.write("split ${key.slice(0, 9)}");
    process.stderr.write("${key.slice(9)} end\\n");
    process.stderr.write("b64 ${b64}\\n");
    ${opts.mode === "throw" ? `throw new Error("boom ${key}");` : `Promise.reject(new Error("boom ${key}")); return;`}
  }
  if (Date.now() - start > 10000) { process.stderr.write("PRELOAD_TIMEOUT\\n"); return; }
  setTimeout(tick, 20);
};
setTimeout(tick, 20);
`);
      const cfgPath = join(tmp("kya-plane-"), "hosted.json");
      writeFileSync(cfgPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${plane.port}`, apiKey: key, agentId: AGENT }));
      chmodSync(cfgPath, 0o600);
      const stdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: opts.tool ?? "Read", tool_input: {}, tool_use_id: "toolu_c" });
      const t0 = Date.now();
      const r = await new Promise<{ status: number | null; stdout: string; stderr: string; ms: number }>((ok) => {
        const child = spawn(process.execPath, ["--require", preload, cliJs, "hook", "--host", "claude", "--plane-config", cfgPath, "--plane-allow-http-loopback", "--plane-budget-ms", "4000", ...(opts.shadow ? ["--plane-shadow"] : [])], {
          cwd: tmp("kya-proj-"),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: freshTestHome(), KYA_SKIP_NODE_CHECK: "1", KYA_TELEMETRY: "0" },
        });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (c) => { stdout += c; });
        child.stderr.on("data", (c) => { stderr += c; });
        child.stdin.on("error", () => undefined); // EPIPE once the crashed child is gone
        child.on("close", (status) => ok({ status, stdout, stderr, ms: Date.now() - t0 }));
        if (!opts.beforeStdin) {
          child.stdin.end(stdin);
        } else {
          const waitFired = () => {
            if (existsSync(fired) || Date.now() - t0 > 10_000) child.stdin.end(stdin);
            else setTimeout(waitFired, 20);
          };
          waitFired();
        }
      });
      // A preload that never fired would make the assertions meaningless: fail clearly instead.
      expect(r.stderr, "preload never reached its trigger").not.toContain("PRELOAD_TIMEOUT");
      expect(existsSync(fired), "preload never fired").toBe(true);
      return r;
    })();
  }

  const noKey = (r: { stdout: string; stderr: string }, key = KEY) => {
    for (const t of [r.stdout, r.stderr]) {
      expect(t).not.toContain(key);
      expect(t).not.toContain(Buffer.from(key).toString("base64"));
    }
  };

  it("(MED-1 wiring) hosted + uncaught throw mid-call: exit 2 with deny JSON; the guard redacts every key form", async () => {
    const r = await crashHook({ mode: "throw" });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.stderr).toContain("FAIL_CLOSED");
    expect(r.stderr).toContain("[redacted]");
    noKey(r);
  });

  it("(MED-1 wiring) hosted + unhandled rejection mid-call: exit 2", async () => {
    const r = await crashHook({ mode: "reject" });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    noKey(r);
  });

  it("(HIGH-1) shadow + never-list tool + crash: exit 2 NEVER_EVENT (shadow never relaxes the never-list)", async () => {
    const r = await crashHook({ mode: "throw", shadow: true, tool: "mcp__postgres__drop_table" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("NEVER_EVENT");
    noKey(r);
  });

  it("(HIGH-1) shadow + harmless tool + crash: exit 0 as designed", async () => {
    const r = await crashHook({ mode: "throw", shadow: true, tool: "Read" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    noKey(r);
  });

  it("(HIGH-1) shadow + crash before the payload is parsed: exit 2 (not provably off the never-list)", async () => {
    const r = await crashHook({ mode: "throw", shadow: true, beforeStdin: true });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("FAIL_CLOSED");
    // The guard only knows the key once the config file is loaded; this crash happens before that,
    // so only the hook's own output is asserted (it never contains the key).
    expect(r.stdout).not.toContain(KEY);
  });

  it("(HIGH-1 reproduction) a non-ASCII key is refused at load; a never-list tool in shadow still exits 2", async () => {
    const key = "sk_live_caf\u00e9caf\u00e9caf\u00e9caf\u00e9";
    const plane = await httpStub((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(ALLOW_BODY); });
    open.push(plane.server);
    const cfgPath = join(tmp("kya-plane-"), "hosted.json");
    writeFileSync(cfgPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${plane.port}`, apiKey: key, agentId: AGENT }));
    chmodSync(cfgPath, 0o600);
    const r = await new Promise<{ status: number | null; stdout: string }>((ok) => {
      const child = spawn(process.execPath, [cliJs, "hook", "--host", "claude", "--plane-config", cfgPath, "--plane-allow-http-loopback", "--plane-shadow"], {
        cwd: tmp("kya-proj-"), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: freshTestHome(), KYA_SKIP_NODE_CHECK: "1", KYA_TELEMETRY: "0" },
      });
      let stdout = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.on("close", (status) => ok({ status, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: "mcp__postgres__drop_table", tool_input: {}, tool_use_id: "t" }));
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("NEVER_EVENT");
    expect(plane.seen.requests).toHaveLength(0);
  });

  it("(L3) ALLOW with a lingering keep-alive socket: the process exits promptly", async () => {
    const plane = await httpStub((_q, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "keep-alive", "keep-alive": "timeout=60" });
      res.end(ALLOW_BODY);
    });
    plane.server.keepAliveTimeout = 60_000;
    open.push(plane.server);
    const r = await hook(`http://127.0.0.1:${plane.port}`);
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(2500);
  });

  it("wall time: a plane that never answers ends PLANE_TIMEOUT within budget plus one attempt", async () => {
    const plane = await httpStub(() => { /* never answers */ });
    open.push(plane.server);
    const r = await hook(`http://127.0.0.1:${plane.port}`, ["--plane-budget-ms", "1000"]);
    expect(r.status).toBe(2);
    expect(reason(r.stdout)).toContain("PLANE_TIMEOUT");
    expect(r.ms).toBeLessThan(1000 + 500 + 1500); // budget + one capped attempt + node start
  });

  it("wall time: a slow-loris body (one byte per second) is cut at the budget", async () => {
    const timers: NodeJS.Timeout[] = [];
    const plane = await httpStub((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write(" "), 1000);
      timers.push(t);
      res.on("close", () => clearInterval(t));
    });
    open.push(plane.server);
    const r = await hook(`http://127.0.0.1:${plane.port}`, ["--plane-budget-ms", "1000"]);
    timers.forEach(clearInterval);
    expect(r.status).toBe(2);
    expect(reason(r.stdout)).toContain("PLANE_TIMEOUT");
    expect(r.ms).toBeLessThan(1000 + 500 + 1500);
  });

  it("wall time: a host that does not resolve ends PLANE_UNREACHABLE inside the budget", async () => {
    const r = await hook("https://kya-hosted-hook-test.invalid", ["--plane-budget-ms", "1000"]);
    expect(r.status).toBe(2);
    expect(reason(r.stdout)).toMatch(/PLANE_UNREACHABLE|PLANE_TIMEOUT/);
    expect(r.ms).toBeLessThan(1000 + 500 + 1500);
  });
});
