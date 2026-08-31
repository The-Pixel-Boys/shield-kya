import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { renderDash } from "../src/dash/dash.js";
import { resolveConfig } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    exit: () => undefined,
  };
  return { io, logs, errors };
}

describe("kya dash --once", () => {
  it("help lists dash", async () => {
    const { io, logs } = captureIo();
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("dash");
  });

  it("prints FREE home without API key and without secrets", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-dash-"));
    dirs.push(cwd);
    const { io, logs } = captureIo();
    const code = await runCli(["dash", "--once", "--offline"], io, {}, cwd);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("FREE");
    expect(out).toContain("pane=home");
    expect(out).not.toMatch(/npm_[A-Za-z0-9]{8,}/);
    expect(out).not.toMatch(/sk_live_/);
    expect(out).toMatch(/hidden on FREE|licensed/i);
  });

  it("sandbox pane is free and shows KYA_SANDBOX hint", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-dash-"));
    dirs.push(cwd);
    const { io, logs } = captureIo();
    const code = await runCli(
      ["dash", "--once", "--offline", "--pane", "sandbox"],
      io,
      {},
      cwd,
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/KYA_SANDBOX|Sandbox/);
  });


  it("policy offline shows DENY then REQUIRE_APPROVE", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-dash-"));
    dirs.push(cwd);
    const { io, logs } = captureIo();
    const code = await runCli(
      ["dash", "--once", "--offline", "--pane", "policy"],
      io,
      {},
      cwd,
    );
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/DENY/);
    expect(out).toMatch(/REQUIRE_APPROVE/);
    expect(out).toContain("not the production PEP");
  });

  it("FREE plan locks cases/metrics/edge/settings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-dash-"));
    dirs.push(cwd);
    const config = resolveConfig({
      cwd,
      env: {},
      requireApiKey: false,
      offline: true,
    });
    for (const pane of ["dashboard", "cases", "metrics", "edge", "settings"] as const) {
      const snap = await renderDash(
        config,
        { once: true, offline: true, pane },
        {},
      );
      expect(snap.plan).toBe("free");
      expect(snap.frame).toMatch(/enterprise_required|requires an enterprise license/i);
    }
  });

  it("enterprise env unlocks dashboard KPIs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-dash-"));
    dirs.push(cwd);
    const config = resolveConfig({
      cwd,
      env: { KYA_DASH_PLAN: "enterprise" },
      requireApiKey: false,
      offline: true,
    });
    const snap = await renderDash(
      config,
      { once: true, offline: true, pane: "dashboard" },
      { KYA_DASH_PLAN: "enterprise" },
    );
    expect(snap.plan).toBe("enterprise");
    expect(snap.frame).toContain("ENTERPRISE");
    expect(snap.frame).toMatch(/needs a control plane|KYA_API_KEY/i);
  });

  it("policy without --offline does not run the sample PEP", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-dash-"));
    dirs.push(cwd);
    const { io, logs } = captureIo();
    const code = await runCli(["dash", "--once", "--pane", "policy"], io, {}, cwd);
    expect(code).toBe(0);
    expect(logs.join("\n")).not.toMatch(/DENY/);
    expect(logs.join("\n")).toMatch(/control plane|KYA_API_KEY/i);
  });

  it("offline free panes name the CLI verbs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-dash-"));
    dirs.push(cwd);
    const cases = [
      ["policy", /wrap/i],
      ["agents", /register-agent/i],
      ["approvals", /approve/i],
      ["sessions", /shrink/i],
      ["mcp", /serve-mcp/i],
    ] as const;
    for (const [pane, re] of cases) {
      const { io, logs } = captureIo();
      const code = await runCli(["dash", "--once", "--offline", "--pane", pane], io, {}, cwd);
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(re);
      expect(logs.join("\n")).not.toMatch(/sk_live_/);
    }
  });

  it("dash --once policy still treats once as boolean", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-dash-"));
    dirs.push(cwd);
    const { io, logs } = captureIo();
    const code = await runCli(["dash", "--once", "policy"], io, {}, cwd);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("pane=policy");
  });
});
