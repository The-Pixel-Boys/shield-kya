/**
 * CLI wiring tests for `kya discover`.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiscover } from "../src/commands/discover.js";

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) },
    out,
    err,
  };
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "kya-discover-cli-"));
}

describe("kya discover (command wiring)", () => {
  it("scans and prints JSON", async () => {
    const home = freshHome();
    const cwd = freshHome();
    const { io, out } = captureIo();
    const code = await runDiscover({ json: true, push: false, diff: undefined, file: undefined }, io, cwd, {
      KYA_HOME: home,
      PATH: "/usr/bin",
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.os).toBeDefined();
    expect(Array.isArray(parsed.inventory)).toBe(true);
  });

  it("writes a snapshot and prints summary", async () => {
    const home = freshHome();
    const cwd = freshHome();
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "claude"), "", "utf8");
    const { io, out } = captureIo();
    const code = await runDiscover({ json: false, push: false, diff: undefined, file: undefined }, io, cwd, {
      KYA_HOME: home,
      PATH: binDir,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Discovered");
    expect(out.join("\n")).toContain("latest.json");
  });

  it("--diff exits 1 when previous snapshot is missing", async () => {
    const home = freshHome();
    const cwd = freshHome();
    const { io, err } = captureIo();
    const code = await runDiscover(
      { json: false, push: false, diff: "/no/such/snapshot.json", file: undefined },
      io,
      cwd,
      { KYA_HOME: home, PATH: "/usr/bin" },
    );
    expect(code).toBe(1);
    expect(err[0]).toContain("could not read previous snapshot");
  });

  it("--push exits 2 with setup instructions when credentials are missing", async () => {
    const home = freshHome();
    const cwd = freshHome();
    const { io, err } = captureIo();
    const code = await runDiscover({ json: false, push: true, diff: undefined, file: undefined }, io, cwd, {
      KYA_HOME: home,
      PATH: "/usr/bin",
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("KYA_API_KEY");
    expect(err.join("\n")).toContain("KYA_BASE_URL");
  });

  it("--push --json pushes a scanned snapshot", async () => {
    const home = freshHome();
    const cwd = freshHome();
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "claude"), "", "utf8");
    const { io, out } = captureIo();
    let posted = false;
    const env = {
      KYA_HOME: home,
      PATH: binDir,
      KYA_BASE_URL: "https://shield-agent.com",
      KYA_API_KEY: "sk_test",
    };
    // Monkey-patch global fetch for this test; restored in finally.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      posted = true;
      return new Response("", { status: 202 });
    }) as typeof globalThis.fetch;
    try {
      const code = await runDiscover(
        { json: true, push: true, diff: undefined, file: undefined },
        io,
        cwd,
        env,
      );
      expect(code).toBe(0);
      expect(posted).toBe(true);
      expect(out.join("\n")).toContain("pushed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
