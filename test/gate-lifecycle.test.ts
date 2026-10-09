import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startGateSupervisor } from "../src/commands/gate-serve.js";
import { runGateRun, runGateStop, bindScopeFromYaml } from "../src/commands/gate.js";
import { resolveConfig } from "../src/config.js";
import { GATE_VERSION } from "../src/gate/binary.js";
import { readGateState, gateYamlPath, writeGateState } from "../src/gate/daemon.js";
import { generateGatewayYaml } from "../src/gate/config-gen.js";
import { readGateways } from "../src/gate/config.js";
import { pidAlive } from "../src/receipt/daemon.js";
import { readTrail } from "../src/trail.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-gate-life-"));
}

function env(home: string): NodeJS.ProcessEnv {
  return { KYA_HOME: home };
}

function fakeBinary(home: string): string {
  // Stand-in for the real gateway: stays alive, dies on SIGTERM (default).
  const path = join(home, "fake-kya-gate.sh");
  writeFileSync(path, "#!/bin/sh\nexec sleep 300\n", "utf8");
  chmodSync(path, 0o755);
  return path;
}

function writeGateways(home: string): void {
  const path = join(home, ".kya", "gateways.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port: 39930,
      servers: [{ id: "github", transport: "stdio", cmd: ["npx", "-y", "gh-mcp"] }],
    }),
    "utf8",
  );
}

// OTLP/JSON export carrying one tools/call span.
function otlpJson(spanId: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                spanId,
                name: "call_tool",
                attributes: [
                  { key: "mcp.method.name", value: { stringValue: "tools/call" } },
                  { key: "mcp.target", value: { stringValue: "github" } },
                  { key: "gen_ai.tool.name", value: { stringValue: "get_issue" } },
                  { key: "mcp.session.id", value: { stringValue: "sess-life" } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("gate supervisor lifecycle (fake kya-gate binary)", () => {
  it("publishes state, ingests spans to the trail, and stops cleanly with the child", async () => {
    const home = tmp();
    try {
      writeGateways(home);
      const e = env(home);
      const handle = await startGateSupervisor({
        cwd: home,
        env: e,
        binaryPath: fakeBinary(home),
        otlpPort: 0,
      });

      const state = readGateState(e);
      expect(state).toMatchObject({ pid: process.pid, port: 39930, url: "http://127.0.0.1:39930" });
      expect(state!.otlpPort).toBe(handle.otlpPort);
      expect(state!.childPid).toBe(handle.childPid);
      expect(pidAlive(handle.childPid!)).toBe(true);

      const res = await fetch(`http://127.0.0.1:${handle.otlpPort}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: otlpJson("span-life-1"),
      });
      expect(res.status).toBe(200);
      const trail = readTrail(home, e);
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        toolId: "github__get_issue",
        verdict: "ALLOW",
        mode: "observe",
        sessionId: "sess-life",
      });

      handle.stop();
      await handle.waitUntilClosed;
      expect(readGateState(e)).toBeUndefined();
      for (let waited = 0; waited < 3_000 && pidAlive(handle.childPid!); waited += 50) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pidAlive(handle.childPid!)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it("shuts down when the binary child exits on its own", async () => {
    const home = tmp();
    try {
      writeGateways(home);
      const dying = join(home, "dying-kya-gate.sh");
      writeFileSync(dying, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(dying, 0o755);
      const e = env(home);
      const handle = await startGateSupervisor({
        cwd: home,
        env: e,
        binaryPath: dying,
        otlpPort: 0,
      });
      await handle.waitUntilClosed;
      expect(readGateState(e)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it("a binary that cannot be started fails the supervisor cleanly instead of crashing it", async () => {
    const home = tmp();
    try {
      writeGateways(home);
      const e = env(home);
      const handle = await startGateSupervisor({
        cwd: home,
        env: e,
        binaryPath: join(home, "no-such-kya-gate"),
        otlpPort: 0,
      });

      // Used to be an uncaught 'error' event: the process died before any cleanup ran.
      await expect(handle.waitUntilClosed).rejects.toThrow(/gate binary could not be started/);
      expect(readGateState(e)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it("a non-executable binary fails the same way", async () => {
    const home = tmp();
    try {
      writeGateways(home);
      const plain = join(home, "not-executable");
      writeFileSync(plain, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(plain, 0o644);
      const handle = await startGateSupervisor({ cwd: home, env: env(home), binaryPath: plain, otlpPort: 0 });

      await expect(handle.waitUntilClosed).rejects.toThrow(/could not be started/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it("kya gate run YAML was written next to the state (sanity: config file exists for the child)", () => {
    // runGateRun owns YAML generation; the supervisor consumes gate.yaml.
    // Here we only assert the path helper the two sides share.
    expect(gateYamlPath(env("/tmp/kya-home-x"))).toBe("/tmp/kya-home-x/.kya/gate.yaml");
  });
});

describe("gate supervisor without gateways.json", () => {
  it("starts with defaults (empty servers, default ports)", async () => {
    const home = tmp();
    try {
      const e = env(home);
      const handle = await startGateSupervisor({
        cwd: home,
        env: e,
        binaryPath: fakeBinary(home),
        otlpPort: 0,
      });
      expect(readGateState(e)!.port).toBe(3930);
      handle.stop();
      await handle.waitUntilClosed;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});

/**
 * Node-based fake for full-flow tests: answers --version, and (unless
 * KYA_FAKE_NO_LISTEN=1) serves HTTP 200 on the port parsed from the -f YAML,
 * so runGateRun's listener probe can pass.
 */
function fakeNodeBinary(home: string): string {
  const path = join(home, ".kya", "bin", "kya-gate");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("fs");',
      'if (process.argv.includes("--version")) { console.log(JSON.stringify({ version: process.env.KYA_FAKE_VERSION || "0.0.0" })); process.exit(0); }',
      'if (process.env.KYA_FAKE_NO_LISTEN === "1") { setInterval(() => {}, 1000); } else {',
      '  const yaml = fs.readFileSync(process.argv[process.argv.indexOf("-f") + 1], "utf8");',
      '  const port = /- port: (\\d+)/.exec(yaml)[1];',
      '  require("http").createServer((req, res) => { res.writeHead(200).end("ok"); }).listen(Number(port), "127.0.0.1");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

function cfg(cwd: string) {
  return resolveConfig({ cwd, offline: true, allowMissingApiKey: true, flags: { offline: true } });
}

function writeGateways2(home: string, servers: unknown[]): void {
  const path = join(home, ".kya", "gateways.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ port: 39932, otlpPort: 39933, servers }),
    "utf8",
  );
}

describe("kya gate run (detached, fake listening binary)", () => {
  it("starts only after the listener answers, then reports config drift without rewriting", async () => {
    const home = tmp();
    try {
      fakeNodeBinary(home);
      writeGateways2(home, [{ id: "github", transport: "stdio", cmd: ["npx", "-y", "gh-mcp"] }]);
      const e = { ...env(home), KYA_FAKE_VERSION: GATE_VERSION };

      const first = await runGateRun(cfg(home), { env: e });
      expect(first.reused).toBe(false);
      expect(first.url).toBe("http://127.0.0.1:39932");
      expect(pidAlive(first.pid)).toBe(true);

      const second = await runGateRun(cfg(home), { env: e });
      expect(second.reused).toBe(true);
      expect(second.drift).toBeUndefined();

      // Change gateways.json: re-run must report drift, NOT rewrite gate.yaml.
      writeGateways2(home, [
        { id: "github", transport: "stdio", cmd: ["npx", "-y", "gh-mcp"] },
        { id: "context7", transport: "http", url: "https://mcp.context7.com/mcp" },
      ]);
      const before = readFileSync(gateYamlPath(e), "utf8");
      const third = await runGateRun(cfg(home), { env: e });
      expect(third.reused).toBe(true);
      expect(third.drift).toBe(true);
      expect(third.next).toContain("config changed since gateway started");
      expect(readFileSync(gateYamlPath(e), "utf8")).toBe(before);
      expect(before).not.toContain("context7");

      const state = readGateState(e)!;
      const stop = await runGateStop(e);
      expect(stop.stopped).toBe(true);
      for (let waited = 0; waited < 3_000 && (pidAlive(state.pid) || (state.childPid && pidAlive(state.childPid))); waited += 50) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(pidAlive(state.pid)).toBe(false);
      expect(state.childPid ? pidAlive(state.childPid) : false).toBe(false);
      expect(readGateState(e)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails with GATE_START_FAILED and reaps both processes when the listener never answers", async () => {
    const home = tmp();
    try {
      fakeNodeBinary(home);
      writeGateways2(home, []);
      const e = { ...env(home), KYA_FAKE_VERSION: GATE_VERSION, KYA_FAKE_NO_LISTEN: "1" };
      await expect(runGateRun(cfg(home), { env: e })).rejects.toThrow(/failed to start/);
      expect(readGateState(e)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("runGateStop pid guards", () => {
  it("never signals a foreign pid: planted state is cleared and reported stale", async () => {
    const home = tmp();
    const foreign = spawn("sleep", ["30"]);
    try {
      const e = env(home);
      writeGateState(
        { pid: foreign.pid!, url: "http://127.0.0.1:39932", port: 39932, otlpPort: 39933, startedAt: new Date().toISOString() },
        e,
      );
      const r = await runGateStop(e);
      expect(r.stale).toBe(true);
      expect(r.stopped).toBe(false);
      expect(pidAlive(foreign.pid!)).toBe(true);
      expect(readGateState(e)).toBeUndefined();
    } finally {
      try {
        foreign.kill("SIGKILL");
      } catch {
        /* gone */
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it("kills the gateway binary child even when the supervisor is already dead", async () => {
    const home = tmp();
    const child = spawn("sleep", ["30"]);
    const deadSupervisor = spawn("sleep", ["0"]);
    await new Promise((r) => deadSupervisor.once("exit", r));
    try {
      const e = env(home);
      writeGateState(
        {
          pid: deadSupervisor.pid!,
          childPid: child.pid!,
          url: "http://127.0.0.1:39932",
          port: 39932,
          otlpPort: 39933,
          startedAt: new Date().toISOString(),
        },
        e,
      );
      const r = await runGateStop(e);
      expect(r.stopped).toBe(true);
      expect(r.childPid).toBe(child.pid);
      for (let waited = 0; waited < 3_000 && pidAlive(child.pid!); waited += 50) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(pidAlive(child.pid!)).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("doctor bind scope", () => {
  it("reports loopback-only when the generated config carries the allowlist + offs", async () => {
    const home = tmp();
    try {
      const e = env(home);
      writeGateways2(home, []);
      expect(bindScopeFromYaml(e).loopbackOnly).toBe(false); // no config yet
      writeFileSync(gateYamlPath(e), generateGatewayYaml(readGateways(e)), "utf8");
      const scope = bindScopeFromYaml(e);
      expect(scope.loopbackOnly).toBe(true);
      expect(scope.detail).toContain("loopback-only");
      // corrupt the posture: removing the allowlist must flip the verdict
      writeFileSync(gateYamlPath(e), "binds: []\n", "utf8");
      expect(bindScopeFromYaml(e).loopbackOnly).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("e2e with the real gateway binary", () => {
  // Binary lookup: KYA_GATE_BINARY (CI installs to a temp dir), else the
  // standard `kya gate setup` location under KYA_HOME.
  const binary =
    process.env.KYA_GATE_BINARY ?? join(process.env.KYA_HOME ?? "", ".kya/bin/kya-gate");
  const real = process.env.KYA_GATE_E2E === "1" && existsSync(binary);
  it.skipIf(!real)(
    "starts the real binary and answers on the listener",
    async () => {
      const home = tmp();
      try {
        writeGateways2(home, []);
        const e = env(home);
        writeFileSync(gateYamlPath(e), generateGatewayYaml(readGateways(e)), "utf8");
        const handle = await startGateSupervisor({
          cwd: home,
          env: e,
          binaryPath: binary,
        });

        // Not "listening" until the listener answers (a bare GET gets a 406
        // from the real gateway - any HTTP answer means it is up).
        let answered = false;
        for (let waited = 0; waited < 10_000 && !answered; waited += 200) {
          try {
            const res = await fetch(`${handle.url}/mcp`, {
              signal: AbortSignal.timeout(1000),
              redirect: "error",
            });
            res.body?.cancel().catch(() => undefined);
            answered = true;
          } catch {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        expect(answered).toBe(true);
        expect(pidAlive(handle.childPid!)).toBe(true);

        handle.stop();
        await handle.waitUntilClosed;
        expect(readGateState(e)).toBeUndefined();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
