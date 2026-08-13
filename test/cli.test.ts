import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    exit: () => {
      /* no-op in tests */
    },
  };
  return { io, logs, errors };
}

describe("runCli", () => {
  it("shows help with no command", async () => {
    const { io, logs } = captureIo();
    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("init");
    expect(logs.join("\n")).toContain("serve-mcp");
    expect(logs.join("\n")).toContain("dash");
  });

  it("init succeeds without API key", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-cli-"));
    dirs.push(cwd);
    const { io, logs } = captureIo();
    const code = await runCli(
      ["init", "--base-url", "http://127.0.0.1:8090"],
      io,
      {},
      cwd,
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/scaffold ready/i);
  });

  it("eval-tool fails closed with empty API key (non-zero)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-cli-"));
    dirs.push(cwd);
    const { io, errors } = captureIo();
    const code = await runCli(
      ["eval-tool", "--tool-id", "org.sample.safe.read"],
      io,
      { KYA_BASE_URL: "http://127.0.0.1:8090", KYA_API_KEY: "" },
      cwd,
    );
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toMatch(/KYA_API_KEY|AUTH/i);
  });

  it("eval-tool --offline DENY then REQUIRE_APPROVE without API key", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-cli-"));
    dirs.push(cwd);
    const { io, logs } = captureIo();
    const deny = await runCli(
      [
        "eval-tool",
        "--offline",
        "--tool-id",
        "org.sample.never.event",
        "--irreversible",
      ],
      io,
      {},
      cwd,
    );
    expect(deny).toBe(0);
    expect(logs.join("\n")).toMatch(/verdict: DENY/);

    const logs2: string[] = [];
    const io2: CliIo = {
      log: (m) => logs2.push(m),
      error: () => {
        /* */
      },
      exit: () => {
        /* */
      },
    };
    const ra = await runCli(
      [
        "eval-tool",
        "--offline",
        "--tool-id",
        "org.sample.data.write",
        "--irreversible",
      ],
      io2,
      {},
      cwd,
    );
    expect(ra).toBe(0);
    expect(logs2.join("\n")).toMatch(/REQUIRE_APPROVE/);
  });

  it("register-agent fails closed without key", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-cli-"));
    dirs.push(cwd);
    const { io } = captureIo();
    const code = await runCli(
      ["register-agent", "--name", "x"],
      io,
      { KYA_BASE_URL: "http://127.0.0.1:8090" },
      cwd,
    );
    expect(code).toBe(1);
  });

  it("unknown command returns 2", async () => {
    const { io } = captureIo();
    const code = await runCli(["nope"], io);
    expect(code).toBe(2);
  });
});
