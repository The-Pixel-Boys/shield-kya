/**
 * Telemetry from the gateway supervisor against the REAL gateway binary, through the real
 * `kya gate run` / `kya gate stop` commands and a real detached `gate-serve` process.
 *
 * Runs in the "kya gate e2e (real binary)" CI job (KYA_GATE_E2E=1, KYA_GATE_BINARY=<path>); skipped
 * anywhere that binary is not available. Hermetic otherwise: temp home, random ports, a local stub
 * standing in for the telemetry endpoint.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "dist", "cli.js");
const ID = "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c";
const binary = process.env["KYA_GATE_BINARY"] ?? join(process.env["KYA_HOME"] ?? "", ".kya/bin/kya-gate");
const real = process.env["KYA_GATE_E2E"] === "1" && existsSync(binary) && existsSync(CLI);

interface Recorded {
  readonly body: Record<string, unknown>;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let home: string;
let server: Server;
let base: string;
const requests: Recorded[] = [];

beforeEach(async () => {
  requests.length = 0;
  home = mkdtempSync(join(tmpdir(), "kya-tel-gate-"));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      } catch {
        /* ignore */
      }
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/telemetry/kya`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({
  PATH: process.env["PATH"] ?? "",
  KYA_HOME: home,
  KYA_SKIP_NODE_CHECK: "1",
  KYA_TELEMETRY_URL: base,
  KYA_TELEMETRY_INTERVAL_MS: "200",
});

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("gateway telemetry with the real gateway binary", () => {
  it.skipIf(!real)(
    "kya gate run reports start and heartbeats as the gateway surface, and kya gate stop sends end",
    async () => {
      mkdirSync(join(home, ".kya", "bin"), { recursive: true });
      symlinkSync(binary, join(home, ".kya", "bin", "kya-gate")); // the pinned binary is large: link, do not copy
      writeFileSync(
        join(home, ".kya", "gateways.json"),
        JSON.stringify({ port: await freePort(), otlpPort: await freePort(), servers: [] }),
      );
      writeFileSync(
        join(home, ".kya", "telemetry.json"),
        JSON.stringify({ enabled: true, installId: ID, askedAt: "2026-10-08T00:00:00.000Z" }),
      );

      try {
        await execFileAsync(process.execPath, [CLI, "gate", "run"], { env: env(), cwd: home, timeout: 60_000 });

        await waitFor(() => requests.some((r) => r.body["event"] === "start"), 15_000, "gateway start beacon");
        await waitFor(() => requests.some((r) => r.body["event"] === "heartbeat"), 15_000, "gateway heartbeat");
      } finally {
        await execFileAsync(process.execPath, [CLI, "gate", "stop"], { env: env(), cwd: home, timeout: 30_000 }).catch(
          () => undefined,
        );
      }

      await waitFor(() => requests.some((r) => r.body["event"] === "end"), 15_000, "gateway end beacon");
      const events = requests.map((r) => r.body);
      expect(events[0]).toMatchObject({ event: "start", surface: "gateway", installId: ID, schema: 1 });
      expect(events.every((e) => e["surface"] === "gateway" && e["installId"] === ID)).toBe(true);
      expect(new Set(events.map((e) => e["sessionId"])).size).toBe(1);
      expect(events.at(-1)).toMatchObject({ event: "end" });
    },
    90_000,
  );
});
