import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { globalTrailPath } from "../src/trail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-certify-cli-"));
  dirs.push(d);
  return d;
}

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    exit: () => {
      /* no-op */
    },
  };
  return { io, logs, errors };
}

/** Synthetic env for runCli MUST carry KYA_HOME (test/setup.ts policy). */
function env(home: string): NodeJS.ProcessEnv {
  return { KYA_SKIP_NODE_CHECK: "1", KYA_HOME: home };
}

describe("cli certify", () => {
  it("writes the gap report and exits 1 on gaps (CI default)", async () => {
    const cwd = tmp();
    const home = tmp();
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(
      globalTrailPath(env(home)),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        sessionId: "s1",
        toolId: "Read",
        verdict: "ALLOW",
        reasonCode: "LOW_RISK_READ",
        mode: "hold",
      })}\n`,
    );
    const { io, logs } = captureIo();
    const code = await runCli(["certify"], io, env(home), cwd);
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("agent-trust-baseline v0.1.0");
    expect(logs.join("\n")).toContain("evidence only");
    expect(existsSync(join(cwd, ".kya", "certify", "report.json"))).toBe(true);
    expect(existsSync(join(cwd, ".kya", "certify", "report.md"))).toBe(true);
    expect(existsSync(join(cwd, ".kya", "certify", "report.html"))).toBe(true);
  });

  it("--fail-on never exits 0; --json-stdout prints the report only", async () => {
    const cwd = tmp();
    const home = tmp();
    const { io, logs } = captureIo();
    const code = await runCli(
      ["certify", "--fail-on", "never", "--json-stdout"],
      io,
      env(home),
      cwd,
    );
    expect(code).toBe(0);
    const report = JSON.parse(logs.join("\n")) as { format: string; requirements: unknown[] };
    expect(report.format).toBe("shield-kya-certify-report");
    expect(report.requirements).toHaveLength(30);
  });

  it("--attest records and re-runs; usage errors exit 2", async () => {
    const cwd = tmp();
    const home = tmp();
    const { io, logs } = captureIo();
    const code = await runCli(
      ["certify", "--attest", "SOC-01", "--text", "AUP v1", "--fail-on", "never"],
      io,
      env(home),
      cwd,
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("attestation recorded: SOC-01");
    expect(existsSync(join(cwd, ".kya", "attestations.json"))).toBe(true);

    const bad = captureIo();
    const code2 = await runCli(["certify", "--window", "0"], bad.io, env(tmp()), tmp());
    expect(code2).toBe(2);
    expect(bad.errors.join("\n")).toContain("--window");
  });

  it("--sign writes a verifiable evidence bundle and surfaces the key fingerprint", async () => {
    const cwd = tmp();
    const home = tmp();
    const { io, logs } = captureIo();
    const code = await runCli(
      ["certify", "--sign", "--fail-on", "never", "--quiet"],
      io,
      env(home),
      cwd,
    );
    expect(code).toBe(0);
    const bundlePath = join(cwd, ".kya", "certify", "evidence-bundle.json");
    expect(existsSync(bundlePath)).toBe(true);
    // Key lifecycle output: fingerprint always printed; first run flags the new key.
    expect(logs.join("\n")).toMatch(/key fp=[0-9a-f]{16}/);
    expect(logs.join("\n")).toContain("new key created, continuity resets here");
    const { verifyBundleSignature } = await import("../src/sign/evidence-bundle.js");
    const bundle = JSON.parse(
      (await import("node:fs")).readFileSync(bundlePath, "utf8"),
    ) as Record<string, unknown>;
    expect(verifyBundleSignature(bundle)).toBe(true);

    // Same KYA_HOME → same key: fingerprint repeated, no "new key" notice.
    const again = captureIo();
    const code2 = await runCli(
      ["certify", "--sign", "--fail-on", "never", "--quiet"],
      again.io,
      env(home),
      cwd,
    );
    expect(code2).toBe(0);
    expect(again.logs.join("\n")).toMatch(/key fp=[0-9a-f]{16}/);
    expect(again.logs.join("\n")).not.toContain("new key created");
  });

  it("--sign --json-stdout keeps stdout pure JSON; key notice goes to stderr", async () => {
    const cwd = tmp();
    const home = tmp();
    const { io, logs, errors } = captureIo();
    const code = await runCli(
      ["certify", "--sign", "--fail-on", "never", "--json-stdout"],
      io,
      env(home),
      cwd,
    );
    expect(code).toBe(0);
    const report = JSON.parse(logs.join("\n")) as { format: string };
    expect(report.format).toBe("shield-kya-certify-report");
    expect(errors.join("\n")).toMatch(/key fp=[0-9a-f]{16}/);
    expect(errors.join("\n")).toContain("new key created, continuity resets here");
  });

  it("--attest --json-stdout routes the confirmation to stderr", async () => {
    const cwd = tmp();
    const home = tmp();
    const { io, logs, errors } = captureIo();
    const code = await runCli(
      ["certify", "--attest", "SOC-01", "--text", "AUP v1", "--fail-on", "never", "--json-stdout"],
      io,
      env(home),
      cwd,
    );
    expect(code).toBe(0);
    const report = JSON.parse(logs.join("\n")) as { format: string };
    expect(report.format).toBe("shield-kya-certify-report");
    expect(errors.join("\n")).toContain("attestation recorded: SOC-01");
  });

  it("--attest confirmation still prints under --quiet (safety-relevant)", async () => {
    const cwd = tmp();
    const home = tmp();
    const { io, logs } = captureIo();
    const code = await runCli(
      ["certify", "--attest", "SOC-01", "--text", "AUP v1", "--fail-on", "never", "--quiet"],
      io,
      env(home),
      cwd,
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("attestation recorded: SOC-01");
    // …but the summary stays suppressed.
    expect(logs.join("\n")).not.toContain("agent-trust-baseline v0.1.0");
  });

  it("HELP lists certify", async () => {
    const { io, logs } = captureIo();
    const code = await runCli(["--help"], io, env(tmp()), tmp());
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("certify");
  });
});
