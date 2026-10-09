/**
 * Opt-in telemetry, end to end: the REAL built CLI (`dist/cli.js`) as a real child process, talking
 * to a REAL local HTTP server. Covers every pathway the feature adds: opting in/out through the CLI,
 * the MCP stdio session lifecycle (start, heartbeat, end) with stdout kept pure JSON-RPC, each way of
 * switching it off, a dead endpoint, erasure, non-interactive setup, and the real readline consent
 * prompt. Needs `pnpm build` first (like the daemon and gate e2e tests).
 */
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "dist", "cli.js");
const TELEMETRY_JS = join(PKG, "dist", "telemetry.js");
const ID = "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown>;
}

interface Stub {
  readonly base: string;
  readonly requests: Recorded[];
  status: number;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const requests: Recorded[] = [];
  const stub: Stub = {
    base: "",
    requests,
    status: 204,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.statusCode = stub.status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (stub as { base: string }).base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/telemetry/kya`;
  return stub;
}

/** A clean env: never inherit CI, DO_NOT_TRACK or a developer's KYA_* settings from the runner. */
function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    KYA_HOME: home,
    KYA_SKIP_NODE_CHECK: "1",
    ...extra,
  };
}

async function waitFor(cond: () => boolean, ms = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCliOnce(args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

interface McpProc {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

function spawnMcp(env: NodeJS.ProcessEnv, cwd: string): McpProc {
  const child = spawn(process.execPath, [CLI, "serve-mcp", "--stdio"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, stdout: () => out, stderr: () => err, exited };
}

const INITIALIZE =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
  }) + "\n";

function mcpEnv(home: string, stub: Stub | undefined, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return cleanEnv(home, {
    KYA_API_KEY: "sk_e2e_dummy",
    // Exactly what `kya connect` writes into every host config: telemetry must still report.
    KYA_OFFLINE: "1",
    KYA_HOST: "ide",
    KYA_SESSION_ID: "mcp:claude",
    KYA_TELEMETRY_INTERVAL_MS: "200",
    ...(stub ? { KYA_TELEMETRY_URL: stub.base } : {}),
    ...extra,
  });
}

let home: string;
let cwd: string;
let stub: Stub;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js missing: run `pnpm build` before this e2e test");
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kya-tel-home-"));
  cwd = mkdtempSync(join(tmpdir(), "kya-tel-cwd-"));
  stub = await startStub();
});

afterEach(async () => {
  await stub.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function optIn(): void {
  mkdirSync(join(home, ".kya"), { recursive: true });
  writeFileSync(
    join(home, ".kya", "telemetry.json"),
    JSON.stringify({ enabled: true, installId: ID, askedAt: "2026-10-08T00:00:00.000Z" }),
  );
}

const state = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(home, ".kya", "telemetry.json"), "utf8")) as Record<string, unknown>;

describe("kya telemetry command (real process)", () => {
  it("on, status, show and off work end to end and never contact the server", async () => {
    const env = cleanEnv(home, { KYA_TELEMETRY_URL: stub.base });

    expect((await runCliOnce(["telemetry", "on"], env, cwd)).code).toBe(0);
    expect(state()["enabled"]).toBe(true);
    expect(state()["installId"]).toMatch(UUID);

    const status = await runCliOnce(["telemetry", "status"], env, cwd);
    expect(status.stdout).toContain("Telemetry: on");

    const show = await runCliOnce(["telemetry", "show", "--json"], env, cwd);
    const sample = JSON.parse(show.stdout) as Record<string, unknown>;
    expect(sample["installId"]).toBe(state()["installId"]);
    expect(Object.keys(sample)).toHaveLength(12);

    expect((await runCliOnce(["telemetry", "off"], env, cwd)).code).toBe(0);
    expect(state()["enabled"]).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  it("off --purge erases by POSTing the id in the body (never the URL) and removes it locally", async () => {
    optIn();

    const result = await runCliOnce(["telemetry", "off", "--purge"], cleanEnv(home, { KYA_TELEMETRY_URL: stub.base }), cwd);

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method: "POST", body: { installId: ID } });
    expect(stub.requests[0]!.url).toMatch(/\/telemetry\/kya\/erase$/);
    expect(stub.requests[0]!.url).not.toContain(ID);
    expect(state()).toEqual({ enabled: false, askedAt: "2026-10-08T00:00:00.000Z" });
  });

  it("off --purge fails with exit 1 and keeps the id when the server rejects it", async () => {
    optIn();
    stub.status = 500;

    const result = await runCliOnce(["telemetry", "off", "--purge"], cleanEnv(home, { KYA_TELEMETRY_URL: stub.base }), cwd);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Could not reach the server to erase your data");
    expect(state()["installId"]).toBe(ID);
  });

  it("reset rotates the id through the real CLI", async () => {
    optIn();

    expect((await runCliOnce(["telemetry", "reset"], cleanEnv(home), cwd)).code).toBe(0);

    expect(state()["installId"]).toMatch(UUID);
    expect(state()["installId"]).not.toBe(ID);
    expect(state()["enabled"]).toBe(true);
  });
});

describe("MCP stdio session lifecycle (real process, real socket)", () => {
  it("reports start, heartbeats and end while stdout stays pure JSON-RPC, even with KYA_OFFLINE=1", async () => {
    optIn();
    const mcp = spawnMcp(mcpEnv(home, stub), cwd);
    mcp.child.stdin?.write(INITIALIZE);

    await waitFor(() => stub.requests.some((r) => r.body["event"] === "start"), 8000, "start beacon");
    await waitFor(() => stub.requests.some((r) => r.body["event"] === "heartbeat"), 8000, "heartbeat beacon");
    await waitFor(() => mcp.stdout().includes('"id":1'), 8000, "initialize response");
    mcp.child.stdin?.end();
    expect(await mcp.exited).toBe(0);
    await waitFor(() => stub.requests.some((r) => r.body["event"] === "end"), 8000, "end beacon");

    const events = stub.requests.map((r) => r.body);
    const start = events.find((e) => e["event"] === "start")!;
    expect(start).toMatchObject({
      schema: 1,
      installId: ID,
      surface: "mcp-stdio",
      hostId: "claude",
      gateMode: "offline",
      hostedLinked: true,
      os: process.platform,
      arch: process.arch,
    });
    expect(Object.keys(start)).toHaveLength(12);
    expect(new Set(events.map((e) => e["sessionId"])).size).toBe(1);
    expect(stub.requests.every((r) => r.method === "POST" && /\/api\/v1\/telemetry\/kya$/.test(r.url))).toBe(true);
    expect(events.at(-1)!["event"]).toBe("end");

    // The protocol channel carries only JSON-RPC: no telemetry text, nothing unparsable.
    const lines = mcp.stdout().split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect((JSON.parse(line) as { jsonrpc: string }).jsonrpc).toBe("2.0");
    }
    expect(mcp.stdout() + mcp.stderr()).not.toMatch(/telemetry|anonymous usage/i);
  }, 40_000);

  it("never sends the API key, paths or other environment values", async () => {
    optIn();
    const mcp = spawnMcp(mcpEnv(home, stub, { USER: "some-person" }), cwd);
    mcp.child.stdin?.write(INITIALIZE);
    await waitFor(() => stub.requests.some((r) => r.body["event"] === "start"));
    mcp.child.stdin?.end();
    await mcp.exited;

    const wire = JSON.stringify(stub.requests);
    expect(wire).not.toContain("sk_e2e_dummy");
    expect(wire).not.toContain(cwd);
    expect(wire).not.toContain(home);
    expect(wire).not.toContain("some-person");
  }, 40_000);

  it("keeps serving and exits cleanly when the telemetry endpoint is unreachable", async () => {
    optIn();
    const dead = await startStub();
    const deadBase = dead.base;
    await dead.close();
    const mcp = spawnMcp(mcpEnv(home, undefined, { KYA_TELEMETRY_URL: deadBase }), cwd);
    mcp.child.stdin?.write(INITIALIZE);

    await waitFor(() => mcp.stdout().includes('"id":1'), 8000, "initialize response with endpoint down");
    await sleep(700);
    mcp.child.stdin?.end();

    expect(await mcp.exited).toBe(0);
    expect(mcp.stderr()).toBe("");
  }, 40_000);
});

describe("every way of switching it off holds in a real process", () => {
  async function runAndExpectSilence(env: NodeJS.ProcessEnv) {
    const mcp = spawnMcp(env, cwd);
    mcp.child.stdin?.write(INITIALIZE);
    await waitFor(() => mcp.stdout().includes('"id":1'), 8000, "initialize response");
    await sleep(900); // several heartbeat intervals at 200ms
    mcp.child.stdin?.end();
    expect(await mcp.exited).toBe(0);
    expect(stub.requests).toHaveLength(0);
  }

  it("sends nothing without an opt-in", async () => {
    await runAndExpectSilence(mcpEnv(home, stub));
  }, 40_000);

  it("sends nothing after an explicit opt-out", async () => {
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(join(home, ".kya", "telemetry.json"), JSON.stringify({ enabled: false, askedAt: "2026-10-08T00:00:00.000Z" }));

    await runAndExpectSilence(mcpEnv(home, stub));
  }, 40_000);

  it("sends nothing with DO_NOT_TRACK=1 even after opt-in", async () => {
    optIn();

    await runAndExpectSilence(mcpEnv(home, stub, { DO_NOT_TRACK: "1" }));
  }, 40_000);

  it("sends nothing with KYA_TELEMETRY=0 even after opt-in", async () => {
    optIn();

    await runAndExpectSilence(mcpEnv(home, stub, { KYA_TELEMETRY: "0" }));
  }, 40_000);

  it("sends nothing in CI even after opt-in", async () => {
    optIn();

    await runAndExpectSilence(mcpEnv(home, stub, { CI: "true" }));
  }, 40_000);
});

/** Drives a command under a REAL pseudo-terminal (python3's pty module), answering the consent prompt. */
const PTY_DRIVER = `
import json, os, pty, select, sys, time
cfg = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cfg["cwd"])
    os.execvpe(cfg["argv"][0], cfg["argv"], cfg["env"])
buf = b""
answered = False
deadline = time.time() + 40
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        if not answered and b"[y/N]" in buf:
            os.write(fd, cfg["answer"].encode())
            answered = True
_, status = os.waitpid(pid, 0)
print(json.dumps({"output": buf.decode("utf8", "replace"), "exit": os.waitstatus_to_exitcode(status), "answered": answered}))
`;

const hasPython = (() => {
  try {
    return spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0 && process.platform !== "win32";
  } catch {
    return false;
  }
})();

async function runInPty(args: string[], env: NodeJS.ProcessEnv, cwd: string, answer: string) {
  const cfg = JSON.stringify({ argv: [process.execPath, CLI, ...args], env, cwd, answer });
  const { stdout } = await execFileAsync("python3", ["-I", "-c", PTY_DRIVER, cfg], { timeout: 60_000 });
  return JSON.parse(stdout) as { output: string; exit: number; answered: boolean };
}

describe("consent prompt on a real terminal (pseudo-tty)", () => {
  it.skipIf(!hasPython)("`kya init` asks on a real tty, an explicit y opts in, and it never asks again", async () => {
    const env = cleanEnv(home, { KYA_TELEMETRY_URL: stub.base });

    const first = await runInPty(["init"], env, cwd, "y\n");

    expect(first.exit).toBe(0);
    expect(first.answered).toBe(true);
    expect(first.output).toContain("Share anonymous usage stats");
    expect(first.output).toContain("[y/N]");
    expect(state()["enabled"]).toBe(true);
    expect(state()["installId"]).toMatch(UUID);

    const second = await runInPty(["init"], env, cwd, "y\n");

    expect(second.answered).toBe(false);
    expect(second.output).not.toContain("Share anonymous usage stats");
  }, 90_000);

  it.skipIf(!hasPython)("pressing Enter, or anything but y/yes, keeps telemetry off and creates no install id", async () => {
    const env = cleanEnv(home, { KYA_TELEMETRY_URL: stub.base });

    const result = await runInPty(["init"], env, cwd, "\n");

    expect(result.answered).toBe(true);
    expect(state()["enabled"]).toBe(false);
    expect(state()["installId"]).toBeUndefined();
    expect(stub.requests).toHaveLength(0);
  }, 60_000);

  it.skipIf(!hasPython)("never asks on a real tty with --json, DO_NOT_TRACK or CI", async () => {
    for (const [args, extra] of [
      [["init", "--json"], {}],
      [["init"], { DO_NOT_TRACK: "1" }],
      [["init"], { CI: "true" }],
    ] as const) {
      const h = mkdtempSync(join(tmpdir(), "kya-tel-pty-"));
      try {
        const result = await runInPty([...args], cleanEnv(h, extra), cwd, "y\n");

        expect(result.answered, JSON.stringify(args) + JSON.stringify(extra)).toBe(false);
        expect(result.output).not.toContain("Share anonymous usage stats");
        expect(existsSync(join(h, ".kya", "telemetry.json"))).toBe(false);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    }
  }, 120_000);
});

describe("setup commands (real process)", () => {
  it("a non-interactive `kya init` neither prompts nor saves a choice nor calls the server", async () => {
    const result = await runCliOnce(["init"], cleanEnv(home, { KYA_TELEMETRY_URL: stub.base }), cwd);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("Share anonymous usage stats");
    expect(existsSync(join(home, ".kya", "telemetry.json"))).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  it("the real readline prompt: an explicit y opts in, anything else does not, and it asks only once", async () => {
    const script = (answerHome: string) => `
      import { maybePromptConsent } from ${JSON.stringify(pathToFileURL(TELEMETRY_JS).href)};
      const r = await maybePromptConsent({ error: (m) => process.stderr.write(m + "\\n"), isTty: true },
        { KYA_HOME: ${JSON.stringify(answerHome)} });
      process.stdout.write(r);
    `;
    const ask = (h: string, answer: string) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script(h)], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("close", () => resolve({ stdout, stderr }));
        child.stdin.end(answer);
      });

    const yes = await ask(home, "y\n");
    expect(yes.stdout).toBe("yes");
    expect(yes.stderr).toContain("Share anonymous usage stats? [y/N]");
    expect(state()["enabled"]).toBe(true);
    expect(state()["installId"]).toMatch(UUID);

    const again = await ask(home, "y\n");
    expect(again.stdout).toBe("skipped");

    const otherHome = mkdtempSync(join(tmpdir(), "kya-tel-home2-"));
    try {
      const declined = await ask(otherHome, "\n");
      expect(declined.stdout).toBe("no");
      const saved = JSON.parse(readFileSync(join(otherHome, ".kya", "telemetry.json"), "utf8")) as Record<string, unknown>;
      expect(saved["enabled"]).toBe(false);
      expect(saved["installId"]).toBeUndefined();
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("other long-lived surfaces (real process)", () => {
  it("the report daemon (receipt-serve) reports itself as the `report` surface", async () => {
    optIn();
    const child = spawn(process.execPath, [CLI, "receipt-serve"], {
      env: mcpEnv(home, stub),
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    try {
      await waitFor(() => stub.requests.some((r) => r.body["event"] === "start"), 10_000, "report start beacon");
      await waitFor(() => stub.requests.some((r) => r.body["event"] === "heartbeat"), 10_000, "report heartbeat");

      expect(stub.requests[0]!.body).toMatchObject({ surface: "report", installId: ID, event: "start" });
    } finally {
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(5000)]);
      child.kill("SIGKILL");
    }
  }, 40_000);

  it("the gateway supervisor (gate-serve) reports start and end as the `gateway` surface even when it fails to start", async () => {
    optIn();
    // A corrupt gateways.json makes the supervisor fail the same way on every machine. Relying on a missing
    // binary or a busy port is environment-dependent (a free port + missing binary crashes on an unhandled
    // spawn 'error' before any `finally` runs; a developer's own running gate holds the default port).
    writeFileSync(join(home, ".kya", "gateways.json"), "{ not json");

    const result = await runCliOnce(["gate-serve"], mcpEnv(home, stub), cwd);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("gateways.json");
    await waitFor(() => stub.requests.some((r) => r.body["event"] === "end"), 5000, "gateway end beacon");
    const events = stub.requests.map((r) => r.body);
    expect(events[0]).toMatchObject({ surface: "gateway", event: "start", installId: ID });
    expect(events.at(-1)).toMatchObject({ surface: "gateway", event: "end" });
  }, 40_000);
});

describe("gate-serve with a gateway binary that cannot start (real process)", () => {
  it("still reports start and end, and exits non-zero, when the port is free and the binary is missing", async () => {
    optIn();
    const freePort = async (): Promise<number> => {
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((r) => probe.close(() => r()));
      return port;
    };
    writeFileSync(
      join(home, ".kya", "gateways.json"),
      JSON.stringify({ port: await freePort(), otlpPort: await freePort(), servers: [] }),
    );

    const result = await runCliOnce(["gate-serve"], mcpEnv(home, stub), cwd);

    // Used to die on an unhandled spawn 'error' before any cleanup, so no `end` was ever sent.
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("gate binary could not be started");
    await waitFor(() => stub.requests.some((r) => r.body["event"] === "end"), 5000, "gateway end beacon");
    const events = stub.requests.map((r) => r.body);
    expect(events[0]).toMatchObject({ surface: "gateway", event: "start", installId: ID });
    expect(events.at(-1)).toMatchObject({ surface: "gateway", event: "end" });
    expect(existsSync(join(home, ".kya", "gate-server.json"))).toBe(false);
  }, 40_000);
});

describe("kya hook (spawn-per-tool-call) reports through a once-a-day detached ping", () => {
  const hookEnv = (extra: Record<string, string> = {}) => mcpEnv(home, stub, extra);
  const hookOnce = (env: NodeJS.ProcessEnv) => runCliOnce(["hook", "--host", "claude"], env, cwd, "{}");
  const pings = () => stub.requests.filter((r) => r.body["event"] === "ping");

  it("sends exactly one ping as surface hook after opt-in, and not again on the next tool calls", async () => {
    optIn();

    await hookOnce(hookEnv());
    await waitFor(() => pings().length === 1, 10_000, "the hook ping");
    await hookOnce(hookEnv());
    await hookOnce(hookEnv());
    await sleep(1200);

    expect(pings()).toHaveLength(1);
    expect(pings()[0]?.body).toMatchObject({ schema: 1, event: "ping", surface: "hook", installId: ID });
    expect(String(pings()[0]?.body["sessionId"])).toMatch(UUID);
    expect(stub.requests).toHaveLength(1);
  }, 40_000);

  it("reports which host fired the hook (from --host) when no session id is set", async () => {
    optIn();
    const env = cleanEnv(home, { KYA_TELEMETRY_URL: stub.base, KYA_TELEMETRY_INTERVAL_MS: "200" });

    await runCliOnce(["hook", "--host", "grok"], env, cwd, "{}");

    await waitFor(() => pings().length === 1, 10_000, "the hook ping");
    expect(pings()[0]?.body["hostId"]).toBe("grok");
  }, 40_000);

  it("pings again on the first hook after a day has passed", async () => {
    optIn();
    await hookOnce(hookEnv());
    await waitFor(() => pings().length === 1, 10_000, "the first hook ping");
    const stamp = join(home, ".kya", "telemetry-ping");
    const yesterday = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(stamp, yesterday, yesterday);

    await hookOnce(hookEnv());

    await waitFor(() => pings().length === 2, 10_000, "the next-day hook ping");
  }, 40_000);

  it("leaves the hook's own answer and exit code exactly as they are without telemetry", async () => {
    const withoutOptIn = await hookOnce(hookEnv());
    optIn();

    const withOptIn = await hookOnce(hookEnv());

    expect(withOptIn.code).toBe(withoutOptIn.code);
    expect(withOptIn.stdout).toBe(withoutOptIn.stdout);
    expect(withOptIn.stderr).toBe(withoutOptIn.stderr);
  }, 40_000);

  it("sends nothing without an opt-in, after an opt-out, with DO_NOT_TRACK, or in CI", async () => {
    await hookOnce(hookEnv());
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(join(home, ".kya", "telemetry.json"), JSON.stringify({ enabled: false, askedAt: "2026-10-08T00:00:00.000Z" }));
    await hookOnce(hookEnv());
    optIn();
    await hookOnce(hookEnv({ DO_NOT_TRACK: "1" }));
    await hookOnce(hookEnv({ CI: "true" }));
    await sleep(1500);

    expect(stub.requests).toHaveLength(0);
    expect(existsSync(join(home, ".kya", "telemetry-ping"))).toBe(false);
  }, 60_000);

  it("never makes the hook wait on the network: an endpoint that never answers adds no delay", async () => {
    const blackhole = createServer(() => {
      /* accept the connection, never respond */
    });
    await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(blackhole.address() as AddressInfo).port}/t`;
    optIn();
    try {
      const startedAt = Date.now();
      const result = await hookOnce(hookEnv({ KYA_TELEMETRY_URL: url }));
      const elapsed = Date.now() - startedAt;

      // The helper has a 3 s send timeout; if the hook were waiting on it, this would take >= 3 s.
      expect(result.code).toBe(0);
      expect(elapsed).toBeLessThan(2500);
    } finally {
      blackhole.closeAllConnections();
      await new Promise<void>((r) => blackhole.close(() => r()));
    }
  }, 40_000);
});

describe("module hygiene", () => {
  it("the SDK surface does not import telemetry (it promises no telemetry or network clients)", async () => {
    // An import of the telemetry module, not the word: src/sdk/index.ts itself says it starts no telemetry.
    const { stdout } = await execFileAsync("grep", ["-rEln", "(from|import)\\s*\\(?\\s*[\"'][^\"']*telemetry", join(PKG, "src", "sdk")])
      .catch(() => ({ stdout: "" }));

    expect(stdout.trim()).toBe("");
  });
});
