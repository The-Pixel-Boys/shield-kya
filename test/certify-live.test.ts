// test/certify-live.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeLiveCertify } from "../src/certify/live.js";
import { recordAttestation } from "../src/certify/attest.js";
import { runCertify } from "../src/commands/certify.js";
import { UsageError } from "../src/errors.js";
import { globalTrailPath } from "../src/trail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-certify-live-"));
  dirs.push(d);
  return d;
}

const NOW = new Date("2026-09-18T12:00:00.000Z");

const TRAIL_BASED = [
  "DP-02",
  "DP-03",
  "SEC-02",
  "SEC-03",
  "SEC-05",
  "SAFE-01",
  "REL-01",
  "REL-02",
];

/** Seed the global trail with one live event so trail checks see a non-empty window. */
function seedTrail(home: string): void {
  mkdirSync(join(home, ".kya"), { recursive: true });
  writeFileSync(
    globalTrailPath({ KYA_HOME: home }),
    `${JSON.stringify({
      ts: "2026-09-18T10:00:00.000Z",
      sessionId: "s1",
      toolId: "Read",
      verdict: "ALLOW",
      reasonCode: "LOW_RISK_READ",
      mode: "hold",
      product: "claude",
      project: "demo",
    })}\n`,
  );
}

describe("computeLiveCertify", () => {
  it("evaluates the full baseline in memory: empty trail home → insufficient_evidence, never a vacuous pass", () => {
    const cwd = tmp();
    const home = tmp(); // no trail, no ORR, no artifacts
    const report = computeLiveCertify(cwd, { KYA_HOME: home }, 30, NOW);
    expect(report.format).toBe("shield-kya-certify-report");
    expect(report.version).toBe(1);
    expect(report.catalog.id).toBe("agent-trust-baseline");
    expect(report.requirements).toHaveLength(30);
    // Empty trail: every trail-based check is insufficient_evidence
    for (const id of TRAIL_BASED) {
      expect(report.requirements.find((r) => r.id === id)?.status).toBe(
        "insufficient_evidence",
      );
    }
    // No machine check may claim pass with zero evidence (observe mode, no artifacts)
    expect(report.overall.pass).toBe(0);
    expect(report.requirements.every((r) => r.status !== "pass")).toBe(true);
    // Counts are consistent and fail-closed
    const o = report.overall;
    expect(o.pass + o.gap + o.insufficientEvidence + o.attested).toBe(30);
    expect(o.result).toBe("gap");
    // Window/trail stats mirror the runCertify report shape
    expect(report.window.days).toBe(30);
    expect(report.window.since).toBe("2026-08-19T12:00:00.000Z");
    expect(report.window.until).toBe(NOW.toISOString());
    expect(report.generatedAt).toBe(NOW.toISOString());
    expect(report.trail.eventCount).toBe(0);
    expect(report.trail.verdictMix).toEqual({ ALLOW: 0, DENY: 0, REQUIRE_APPROVE: 0 });
    expect(report.trail.modes).toEqual({ observe: 0, hold: 0, offline: 0 });
  });

  it("writes NO files — no .kya/certify, no .kya at all on a fresh project", () => {
    const cwd = tmp();
    const home = tmp();
    computeLiveCertify(cwd, { KYA_HOME: home }, 30, NOW);
    expect(existsSync(join(cwd, ".kya", "certify"))).toBe(false);
    expect(existsSync(join(cwd, ".kya"))).toBe(false);
  });

  it("KYA_HOLD=1 → SEC-01 passes (enforcing gate mode)", () => {
    const cwd = tmp();
    const home = tmp();
    const report = computeLiveCertify(
      cwd,
      { KYA_HOME: home, KYA_HOLD: "1" },
      30,
      NOW,
    );
    expect(report.requirements.find((r) => r.id === "SEC-01")?.status).toBe("pass");
    expect(report.overall.pass).toBeGreaterThanOrEqual(1);
  });

  it("respects attestations on disk without writing report files", () => {
    const cwd = tmp();
    const home = tmp();
    recordAttestation(cwd, "SOC-01", "AUP v1");
    const report = computeLiveCertify(cwd, { KYA_HOME: home }, 30, NOW);
    const soc01 = report.requirements.find((r) => r.id === "SOC-01");
    expect(soc01?.status).toBe("attested");
    expect(soc01?.attestation?.text).toBe("AUP v1");
    expect(report.overall.attested).toBe(1);
    // attestations.json is the operator's own file; the live report adds nothing
    expect(existsSync(join(cwd, ".kya", "certify"))).toBe(false);
  });

  it("rejects a non-integer or out-of-range windowDays (public SDK guard, CLI rule)", () => {
    const cwd = tmp();
    const home = tmp();
    for (const bad of [0, 367, 1.5, Number.NaN, -30]) {
      expect(() => computeLiveCertify(cwd, { KYA_HOME: home }, bad, NOW)).toThrow(UsageError);
      expect(() => computeLiveCertify(cwd, { KYA_HOME: home }, bad, NOW)).toThrow(
        "windowDays must be an integer between 1 and 366",
      );
    }
    expect(() => computeLiveCertify(cwd, { KYA_HOME: home }, 1, NOW)).not.toThrow();
    expect(() => computeLiveCertify(cwd, { KYA_HOME: home }, 366, NOW)).not.toThrow();
  });

  it("matches runCertify exactly for the same inputs (same evaluator, same report shape)", () => {    const cwd = tmp();
    const home = tmp();
    seedTrail(home);
    const env = { KYA_HOME: home, KYA_HOLD: "1" };
    const live = computeLiveCertify(cwd, env, 30, NOW);
    const cli = runCertify({
      cwd,
      env,
      windowDays: 30,
      out: ".kya/certify",
      formats: [],
      jsonStdout: false,
      open: false,
      quiet: true,
      failOn: "never",
      sign: false,
      now: NOW,
    });
    expect(live).toEqual(cli.report);
  });
});
