// test/certify.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import { parseArgs } from "../src/parse-args.js";
import { resolveConfig, resolveGateMode } from "../src/config.js";
import {
  certifyOptionsFromArgs,
  formatCertifySummary,
  runCertify,
  type CertifyOptions,
} from "../src/commands/certify.js";
import { globalTrailPath } from "../src/trail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-certify-"));
  dirs.push(d);
  return d;
}

const NOW = new Date("2026-09-18T12:00:00.000Z");

function baseOptions(cwd: string, home: string, over: Partial<CertifyOptions> = {}): CertifyOptions {
  return {
    cwd,
    env: { KYA_HOME: home },
    windowDays: 30,
    out: ".kya/certify",
    formats: ["json", "md"],
    jsonStdout: false,
    open: false,
    quiet: true,
    failOn: "gap",
    sign: false,
    now: NOW,
    ...over,
  };
}

/** Seed a trail with one live event so trail checks see a non-empty window. */
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

describe("certifyOptionsFromArgs", () => {
  it("parses defaults and flags", () => {
    const def = certifyOptionsFromArgs(parseArgs(["certify"]));
    expect(def.windowDays).toBe(30);
    expect(def.out).toBe(".kya/certify");
    expect(def.formats).toEqual(["json", "md", "html"]);
    expect(def.failOn).toBe("gap");
    expect(def.sign).toBe(false);
    const o = certifyOptionsFromArgs(
      parseArgs([
        "certify",
        "--window", "90",
        "--catalog", "/tmp/c.json",
        "--out", "/tmp/out",
        "--format", "json,html",
        "--json-stdout",
        "--fail-on", "never",
        "--sign",
        "--quiet",
      ]),
    );
    expect(o.windowDays).toBe(90);
    expect(o.catalogPath).toBe("/tmp/c.json");
    expect(o.formats).toEqual(["json", "html"]);
    expect(o.failOn).toBe("never");
    expect(o.sign).toBe(true);
    const att = certifyOptionsFromArgs(
      parseArgs(["certify", "--attest", "SOC-01", "--text", "AUP v1"]),
    );
    expect(att.attest).toEqual({ requirementId: "SOC-01", text: "AUP v1" });
  });

  it("rejects bad window, fail-on, format, and --attest without --text", () => {
    expect(() => certifyOptionsFromArgs(parseArgs(["certify", "--window", "0"]))).toThrow(UsageError);
    expect(() => certifyOptionsFromArgs(parseArgs(["certify", "--window", "367"]))).toThrow(UsageError);
    expect(() => certifyOptionsFromArgs(parseArgs(["certify", "--window", "30abc"]))).toThrow(UsageError);
    expect(() => certifyOptionsFromArgs(parseArgs(["certify", "--window", "7.5"]))).toThrow(UsageError);
    expect(() => certifyOptionsFromArgs(parseArgs(["certify", "--fail-on", "maybe"]))).toThrow(UsageError);
    expect(() => certifyOptionsFromArgs(parseArgs(["certify", "--format", "pdf"]))).toThrow(UsageError);
    expect(() => certifyOptionsFromArgs(parseArgs(["certify", "--format", "json,yaml"]))).toThrow(/json, md, html/);
    expect(() => certifyOptionsFromArgs(parseArgs(["certify", "--attest", "SOC-01"]))).toThrow(/--text/);
  });
});

describe("resolveGateMode", () => {
  it("honors a valid gateMode key in .kya/config.json; invalid values fall back to observe", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    const cfg = join(cwd, ".kya", "config.json");
    expect(resolveGateMode({ cwd, env: {} })).toBe("observe"); // no file
    writeFileSync(cfg, JSON.stringify({ gateMode: "hold" }));
    expect(resolveGateMode({ cwd, env: {} })).toBe("hold");
    writeFileSync(cfg, JSON.stringify({ gateMode: "offline" }));
    expect(resolveGateMode({ cwd, env: {} })).toBe("offline");
    writeFileSync(cfg, JSON.stringify({ gateMode: "Hold" }));
    expect(resolveGateMode({ cwd, env: {} })).toBe("observe"); // case-sensitive: silent fallback
    writeFileSync(cfg, JSON.stringify({ gateMode: 42 }));
    expect(resolveGateMode({ cwd, env: {} })).toBe("observe"); // non-string: silent fallback
    // env still beats the file key
    writeFileSync(cfg, JSON.stringify({ gateMode: "offline" }));
    expect(resolveGateMode({ cwd, env: { KYA_HOLD: "1" } })).toBe("hold");
    expect(resolveGateMode({ cwd, env: { KYA_OFFLINE: "1" } })).toBe("offline");
  });

  it("flags beat config; the gate's resolveConfig agrees with the resolver", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    writeFileSync(join(cwd, ".kya", "config.json"), JSON.stringify({ gateMode: "offline" }));
    // --hold flag outranks the config key (no env switches set)
    expect(resolveGateMode({ cwd, env: {}, flags: { hold: true } })).toBe("hold");
    // resolveConfig (what wrap/hook/eval actually run) reports the same mode
    const held = resolveConfig({
      cwd,
      env: {},
      flags: { hold: true },
      requireApiKey: false,
    });
    expect(held.holdEnabled).toBe(true);
    expect(held.offline).toBe(false);
    // offline outranks hold when both env switches are armed
    expect(resolveGateMode({ cwd, env: { KYA_HOLD: "1", KYA_OFFLINE: "1" } })).toBe("offline");
  });

  it("matches resolveConfig truthiness: only exact '1' or 'true' enable env modes", () => {
    const cwd = tmp();
    expect(resolveGateMode({ cwd, env: { KYA_HOLD: "true" } })).toBe("hold");
    expect(resolveGateMode({ cwd, env: { KYA_HOLD: " true " } })).toBe("observe");
    expect(resolveGateMode({ cwd, env: { KYA_HOLD: "True" } })).toBe("observe");
    expect(resolveGateMode({ cwd, env: { KYA_OFFLINE: "yes" } })).toBe("observe");
  });
});

describe("runCertify", () => {
  it("writes report.json + report.md and exits 1 when gaps exist", () => {
    const cwd = tmp();
    const home = tmp();
    seedTrail(home);
    const result = runCertify(baseOptions(cwd, home));
    expect(result.exitCode).toBe(1); // unattested attest requirements are gaps
    expect(result.report.format).toBe("shield-kya-certify-report");
    expect(result.report.catalog.id).toBe("agent-trust-baseline");
    expect(result.report.requirements).toHaveLength(30);
    expect(result.report.trail.eventCount).toBe(1);
    expect(result.report.trail.verdictMix).toEqual({ ALLOW: 1, DENY: 0, REQUIRE_APPROVE: 0 });
    expect(result.report.trail.modes).toEqual({ observe: 0, hold: 1, offline: 0 });
    expect(result.report.window.since).toBe("2026-08-19T12:00:00.000Z");
    expect(result.report.overall.result).toBe("gap");
    expect(result.jsonPath).toBe(join(cwd, ".kya", "certify", "report.json"));
    expect(existsSync(result.jsonPath!)).toBe(true);
    expect(existsSync(result.mdPath!)).toBe(true);
    const md = readFileSync(result.mdPath!, "utf8");
    expect(md).toContain("# Certify: agent-trust-baseline");
    expect(md).toContain("## Gaps");
    expect(md).toMatch(/never a policy decision|never ALLOWs|evidence-only/i);
  });

  it("--fail-on never exits 0 even with gaps; empty trail yields insufficient_evidence not pass", () => {
    const cwd = tmp();
    const home = tmp(); // no trail at all
    const relaxed = runCertify(baseOptions(cwd, home, { failOn: "never" }));
    expect(relaxed.exitCode).toBe(0);
    const dp02 = relaxed.report.requirements.find((r) => r.id === "DP-02");
    expect(dp02?.status).toBe("insufficient_evidence");
    const rel01 = relaxed.report.requirements.find((r) => r.id === "REL-01");
    expect(rel01?.status).toBe("insufficient_evidence");
    // empty trail ⇒ no machine check may claim pass
    const machine = relaxed.report.requirements.filter(
      (r) => !["DP-01", "SEC-01", "SAFE-02", "REL-05", "ACC-04"].includes(r.id),
    );
    expect(machine.every((r) => r.status !== "pass")).toBe(true);
  });

  it("records --attest and re-runs: attested requirement stops being a gap", () => {
    const cwd = tmp();
    const home = tmp();
    seedTrail(home);
    const result = runCertify(
      baseOptions(cwd, home, { attest: { requirementId: "SOC-01", text: "AUP v1" } }),
    );
    expect(result.attestationRecorded?.requirementId).toBe("SOC-01");
    const soc01 = result.report.requirements.find((r) => r.id === "SOC-01");
    expect(soc01?.status).toBe("attested");
    expect(soc01?.attestation?.text).toBe("AUP v1");
    // persists for the next run
    const again = runCertify(baseOptions(cwd, home));
    expect(again.report.requirements.find((r) => r.id === "SOC-01")?.status).toBe("attested");
  });

  it("rejects --attest for unknown requirement ids", () => {
    const cwd = tmp();
    const home = tmp();
    expect(() =>
      runCertify(baseOptions(cwd, home, { attest: { requirementId: "XX-99", text: "x" } })),
    ).toThrow(/unknown requirement/);
  });

  it("respects --format subset and writes only requested artifacts", () => {
    const cwd = tmp();
    const home = tmp();
    const result = runCertify(baseOptions(cwd, home, { formats: ["json"] }));
    expect(result.jsonPath).toBeDefined();
    expect(result.mdPath).toBeUndefined();
    expect(result.htmlPath).toBeUndefined();
    expect(existsSync(join(cwd, ".kya", "certify", "report.md"))).toBe(false);
  });

  it("html format writes report.html alongside other artifacts", () => {
    const cwd = tmp();
    const home = tmp();
    const result = runCertify(baseOptions(cwd, home, { formats: ["json", "html"] }));
    expect(result.jsonPath).toBeDefined();
    expect(result.htmlPath).toBe(join(cwd, ".kya", "certify", "report.html"));
    expect(existsSync(join(cwd, ".kya", "certify", "report.html"))).toBe(true);
  });

  it("zero certifiable evidence is fail-closed: overall result gap, never a vacuous pass", () => {
    const cwd = tmp();
    const home = tmp(); // no trail, no ORR — everything evaluates insufficient_evidence
    const catalogPath = join(cwd, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        id: "zero-evidence",
        version: "0.0.1",
        updated: "2026-09-18",
        domains: ["security", "reliability"],
        requirements: [
          {
            id: "SEC-01",
            domain: "security",
            title: "Trail activity",
            text: "x",
            severity: "high",
            check: { kind: "trail_min", windowDays: 30, match: {}, min: 1 },
          },
          {
            id: "REL-01",
            domain: "reliability",
            title: "ORR posture",
            text: "x",
            severity: "high",
            check: { kind: "orr_overall", max: "amber" },
          },
        ],
      }),
    );
    const result = runCertify(baseOptions(cwd, home, { catalogPath }));
    expect(result.report.overall).toEqual({
      pass: 0,
      gap: 0,
      insufficientEvidence: 2,
      attested: 0,
      result: "gap",
    });
    expect(result.exitCode).toBe(1);
    const md = readFileSync(result.mdPath!, "utf8");
    expect(md).toContain("No certifiable evidence");
    expect(formatCertifySummary(result.report)).toContain("no certifiable evidence");
  });

  it("0 gaps with at least one pass yields pass", () => {
    const cwd = tmp();
    const home = tmp();
    const catalogPath = join(cwd, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        id: "one-pass",
        version: "0.0.1",
        updated: "2026-09-18",
        domains: ["security"],
        requirements: [
          {
            id: "SEC-01",
            domain: "security",
            title: "Gate mode enforced",
            text: "x",
            severity: "high",
            check: { kind: "config_mode", not: "observe" },
          },
        ],
      }),
    );
    const result = runCertify(
      baseOptions(cwd, home, { catalogPath, env: { KYA_HOME: home, KYA_HOLD: "1" } }),
    );
    expect(result.report.overall).toEqual({
      pass: 1,
      gap: 0,
      insufficientEvidence: 0,
      attested: 0,
      result: "pass",
    });
    expect(result.exitCode).toBe(0);
  });

  it("attestations only (0 gaps, 0 machine passes) still yield pass", () => {
    const cwd = tmp();
    const home = tmp();
    const catalogPath = join(cwd, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        id: "attest-only",
        version: "0.0.1",
        updated: "2026-09-18",
        domains: ["society"],
        requirements: [
          {
            id: "SOC-01",
            domain: "society",
            title: "Acceptable-use policy",
            text: "x",
            severity: "high",
            check: { kind: "attest", prompt: "AUP reference" },
          },
        ],
      }),
    );
    const result = runCertify(
      baseOptions(cwd, home, {
        catalogPath,
        attest: { requirementId: "SOC-01", text: "AUP v1" },
      }),
    );
    expect(result.report.overall).toEqual({
      pass: 0,
      gap: 0,
      insufficientEvidence: 0,
      attested: 1,
      result: "pass",
    });
    expect(result.exitCode).toBe(0);
  });

  it("escapes pipes from custom catalog titles in the Markdown output", () => {
    const cwd = tmp();
    const home = tmp();
    const catalogPath = join(cwd, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        id: "pipe-test",
        version: "0.0.1",
        updated: "2026-09-18",
        domains: ["security"],
        requirements: [
          {
            id: "SEC-01",
            domain: "security",
            title: "Gate a|b mode",
            text: "x",
            severity: "high",
            check: { kind: "config_mode", not: "observe" },
          },
        ],
      }),
    );
    const result = runCertify(baseOptions(cwd, home, { catalogPath }));
    const md = readFileSync(result.mdPath!, "utf8");
    expect(md).toContain("Gate a\\|b mode");
    expect(md).not.toContain("Gate a|b mode");
  });

  it("escapes pre-existing backslashes before other Markdown escapes", () => {
    const cwd = tmp();
    const home = tmp();
    const catalogPath = join(cwd, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        id: "backslash-test",
        version: "0.0.1",
        updated: "2026-09-18",
        domains: ["security"],
        requirements: [
          {
            id: "SEC-01",
            domain: "security",
            title: "Escape a\\`b and c\\\\d",
            text: "x",
            severity: "high",
            check: { kind: "config_mode", not: "observe" },
          },
        ],
      }),
    );
    const result = runCertify(baseOptions(cwd, home, { catalogPath }));
    const md = readFileSync(result.mdPath!, "utf8");
    expect(md).toContain("Escape a\\\\\\`b and c\\\\\\\\d");
  });

  it("hold gate mode from env passes SEC-01; observe gaps it", () => {
    const cwd = tmp();
    const home = tmp();
    seedTrail(home);
    const observing = runCertify(baseOptions(cwd, home));
    expect(observing.report.requirements.find((r) => r.id === "SEC-01")?.status).toBe("gap");
    const holding = runCertify(baseOptions(cwd, home, { env: { KYA_HOME: home, KYA_HOLD: "1" } }));
    expect(holding.report.requirements.find((r) => r.id === "SEC-01")?.status).toBe("pass");
  });

  it("config gateMode hold passes SEC-01 AND genuinely puts the gate in hold (same resolver)", () => {
    const cwd = tmp();
    const home = tmp();
    seedTrail(home);
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    writeFileSync(join(cwd, ".kya", "config.json"), JSON.stringify({ gateMode: "hold" }));
    const result = runCertify(baseOptions(cwd, home));
    expect(result.report.requirements.find((r) => r.id === "SEC-01")?.status).toBe("pass");
    // Not a paper pass: the shared resolver and the gate's own resolveConfig
    // agree the same config puts wrap/hook/eval in hold mode.
    expect(resolveGateMode({ cwd, env: {} })).toBe("hold");
    const gate = resolveConfig({ cwd, env: { KYA_API_KEY: "sk" }, requireApiKey: true });
    expect(gate.holdEnabled).toBe(true);
    expect(gate.offline).toBe(false);
  });

  it("formatCertifySummary renders a one-screen tally", () => {
    const cwd = tmp();
    const home = tmp();
    const result = runCertify(baseOptions(cwd, home));
    const s = formatCertifySummary(result.report);
    expect(s).toContain("agent-trust-baseline v0.1.0");
    expect(s).toMatch(/\d+ pass · \d+ gap · \d+ insufficient evidence · \d+ attested/);
    expect(s).toContain("GAP");
  });
});
