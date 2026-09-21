// test/certify-context.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleEvidenceContext } from "../src/certify/context.js";
import { runCertify, type CertifyOptions } from "../src/commands/certify.js";
import { globalTrailPath, receiptsDir } from "../src/trail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-certify-ctx-"));
  dirs.push(d);
  return d;
}

const NOW = new Date("2026-09-18T12:00:00.000Z");

function line(ts: string, toolId: string): string {
  return `${JSON.stringify({
    ts,
    sessionId: "s1",
    toolId,
    verdict: "ALLOW",
    reasonCode: "LOW_RISK_READ",
    mode: "hold",
    product: "claude",
    project: "demo",
  })}\n`;
}

/** Two events in-window, one out-of-window, one with an unparseable ts. */
function seedTrail(home: string): void {
  mkdirSync(join(home, ".kya"), { recursive: true });
  writeFileSync(
    globalTrailPath({ KYA_HOME: home }),
    line("2026-09-18T10:00:00.000Z", "Read") +
      line("2026-09-17T10:00:00.000Z", "Write") +
      line("2026-08-01T10:00:00.000Z", "Bash") +
      line("not-a-date", "Edit"),
  );
}

function write(cwd: string, rel: string, content: string): void {
  const path = join(cwd, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

describe("assembleEvidenceContext", () => {
  it("populates every EvidenceContext field from the real readers", () => {
    const cwd = tmp();
    const home = tmp();
    seedTrail(home);
    write(
      cwd,
      "orr-report/report.json",
      JSON.stringify({
        overall: "amber",
        disposition: "conditional",
        primary_failure_mode: "secret handling",
        most_urgent_fix: "rotate leaked keys",
        generated_at: "2026-09-14T00:00:00.000Z",
        categories: [
          { id: "security_platform", label: "Security", rating: "amber", tldr: "x" },
          { id: "engineering_craft", label: "Craft", rating: "green", tldr: "y" },
        ],
      }),
    );
    write(
      cwd,
      ".kya/sandboxes.json",
      JSON.stringify([
        { sandboxId: "sbx-1", backend: "mock", createdAt: "t", status: "running" },
      ]),
    );
    mkdirSync(receiptsDir(cwd), { recursive: true });
    writeFileSync(join(receiptsDir(cwd), "r1.json"), "{}\n", "utf8");
    write(
      cwd,
      ".kya/usage.json",
      JSON.stringify([{ agentId: "refund-bot", runId: "run-1", tokensIn: 1000, tokensOut: 200 }]),
    );
    write(
      cwd,
      ".kya/attestations.json",
      JSON.stringify({
        version: 1,
        attestations: [
          { requirementId: "SOC-01", text: "AUP v1", at: "2026-09-18T00:00:00.000Z" },
        ],
      }),
    );

    const env = { KYA_HOME: home, KYA_HOLD: "1" };
    const ctx = assembleEvidenceContext(cwd, env, NOW);

    expect(ctx.now).toBe(NOW);
    // 0.6.0 parity: the full trail is passed through unfiltered — in-window,
    // out-of-window, and the unparseable-ts event (readTrail keeps it; it is
    // simply outside every window). ts-ascending, unparseable last.
    expect(ctx.events.map((e) => e.toolId)).toEqual(["Bash", "Write", "Read", "Edit"]);
    expect(ctx.gateMode).toBe("hold");
    expect(ctx.orr?.overall).toBe("amber");
    expect(ctx.orrCategories).toEqual({
      security_platform: "amber",
      engineering_craft: "green",
    });
    expect(ctx.sandboxCount).toBe(1);
    expect(ctx.receiptCount).toBe(1);
    expect(ctx.showbackPresent).toBe(true);
    expect(ctx.attestations.get("SOC-01")?.text).toBe("AUP v1");
    expect(typeof ctx.wiredHostCount).toBe("number");
    expect(ctx.wiredHostCount).toBeGreaterThanOrEqual(0);
  });

  it("empty evidence yields empty events, observe mode, and zero counts", () => {
    const cwd = tmp();
    const home = tmp();
    const ctx = assembleEvidenceContext(cwd, { KYA_HOME: home }, NOW);
    expect(ctx.events).toEqual([]);
    expect(ctx.gateMode).toBe("observe");
    expect(ctx.orr).toBeUndefined();
    expect(ctx.orrCategories).toBeUndefined();
    expect(ctx.sandboxCount).toBe(0);
    expect(ctx.receiptCount).toBe(0);
    expect(ctx.showbackPresent).toBe(false);
    expect(ctx.attestations.size).toBe(0);
  });
});

describe("assembleEvidenceContext windowing parity (0.6.0)", () => {
  it("per-check windows see beyond the command window: a 90d trail_min check passes on a 60d-old event with --window 30", () => {
    const cwd = tmp();
    const home = tmp();
    // 60 days before NOW: outside the 30d command window, inside the 90d check window.
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(
      globalTrailPath({ KYA_HOME: home }),
      line("2026-07-20T12:00:00.000Z", "Read"),
    );
    const catalogPath = join(cwd, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        id: "window-parity",
        version: "0.0.1",
        updated: "2026-09-18",
        domains: ["security"],
        requirements: [
          {
            id: "SEC-02",
            domain: "security",
            title: "90d trail activity",
            text: "x",
            severity: "high",
            check: { kind: "trail_min", windowDays: 90, match: {}, min: 1 },
          },
        ],
      }),
    );
    const options: CertifyOptions = {
      cwd,
      env: { KYA_HOME: home },
      windowDays: 30,
      out: ".kya/certify",
      formats: ["json"],
      jsonStdout: false,
      open: false,
      quiet: true,
      failOn: "gap",
      sign: false,
      now: NOW,
      catalogPath,
    };
    const result = runCertify(options);
    // The check owns its window: 0.6.0 behavior, not capped by --window 30.
    expect(result.report.requirements.find((r) => r.id === "SEC-02")?.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    // The report's own stats still use the 30d command window (empty here).
    expect(result.report.trail.eventCount).toBe(0);
  });
});
