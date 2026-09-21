import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/hash.js";
import {
  buildEvidenceBundle,
  EVIDENCE_BUNDLE_FORMAT,
  evidenceKeyPath,
  loadOrCreateEvidenceKey,
  verifyBundleSignature,
  type BundleAgent,
} from "../src/sign/evidence-bundle.js";
import { runCertify } from "../src/commands/certify.js";
import type { CertifyReport } from "../src/certify/evaluate.js";
import type { TrailEvent } from "../src/trail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-bundlesign-"));
  dirs.push(d);
  return d;
}

const REPORT: CertifyReport = {
  format: "shield-kya-certify-report",
  version: 1,
  generatedAt: "2026-09-18T12:00:00.000Z",
  catalog: { id: "agent-trust-baseline", version: "0.1.0", updated: "2026-09-18" },
  window: { days: 30, since: "2026-08-19T12:00:00.000Z", until: "2026-09-18T12:00:00.000Z" },
  trail: {
    eventCount: 1,
    verdictMix: { ALLOW: 1, DENY: 0, REQUIRE_APPROVE: 0 },
    modes: { observe: 1, hold: 0, offline: 0 },
  },
  requirements: [
    {
      id: "DP-02",
      domain: "data-privacy",
      title: "No high-stakes writes allowed in hold mode",
      severity: "critical",
      status: "pass",
      evidence: "0/1 events match verdict=ALLOW reason=HIGH_STAKES_WRITE mode=hold in 30d",
    },
    {
      id: "SOC-01",
      domain: "society",
      title: "Acceptable-use policy",
      severity: "high",
      status: "attested",
      evidence: "attested 2026-09-01T00:00:00.000Z",
      attestation: { text: "AUP at https://example.com/aup", at: "2026-09-01T00:00:00.000Z" },
    },
  ],
  overall: { pass: 1, gap: 0, insufficientEvidence: 0, attested: 1, result: "pass" },
};

const EVENTS: TrailEvent[] = [
  {
    ts: "2026-09-18T10:00:00.000Z",
    sessionId: "s1",
    toolId: "Read",
    verdict: "ALLOW",
    reasonCode: "LOW_RISK_READ",
    mode: "observe",
    product: "claude",
    project: "demo",
  },
];

describe("buildEvidenceBundle", () => {
  it("emits the hard-contract v1 shape and a verifiable signature", () => {
    const key = loadOrCreateEvidenceKey({ KYA_HOME: tmp() });
    const agent: BundleAgent = { agentId: "ag_1", agentName: "demo", host: "ide" };
    const bundle = buildEvidenceBundle({ report: REPORT, windowEvents: EVENTS, agent }, key);
    expect(bundle.format).toBe(EVIDENCE_BUNDLE_FORMAT);
    expect(bundle.version).toBe(1);
    expect(bundle.generatedAt).toBe("2026-09-18T12:00:00.000Z");
    expect(bundle.agent).toEqual({ agentId: "ag_1", agentName: "demo", host: "ide" });
    expect(bundle.catalog).toEqual({ id: "agent-trust-baseline", version: "0.1.0" });
    expect(bundle.window).toEqual({
      days: 30,
      since: "2026-08-19T12:00:00.000Z",
      until: "2026-09-18T12:00:00.000Z",
    });
    const trail = bundle.trail as Record<string, unknown>;
    expect(trail.eventCount).toBe(1);
    expect(trail.digest).toBe(
      createHash("sha256").update(canonicalJson(EVENTS), "utf8").digest("hex"),
    );
    expect(trail.verdictMix).toEqual({ ALLOW: 1, DENY: 0, REQUIRE_APPROVE: 0 });
    const reqs = bundle.requirements as Record<string, unknown>[];
    expect(reqs).toHaveLength(2);
    // bundle requirement rows carry no title/severity — the contract's shape
    expect(reqs[0]).toEqual({
      id: "DP-02",
      domain: "data-privacy",
      status: "pass",
      evidence: "0/1 events match verdict=ALLOW reason=HIGH_STAKES_WRITE mode=hold in 30d",
    });
    expect(reqs[1]).toEqual({
      id: "SOC-01",
      domain: "society",
      status: "attested",
      evidence: "attested 2026-09-01T00:00:00.000Z",
      attestation: { text: "AUP at https://example.com/aup", at: "2026-09-01T00:00:00.000Z" },
    });
    expect(bundle.overall).toEqual({
      pass: 1, gap: 0, insufficientEvidence: 0, attested: 1, result: "pass",
    });
    expect(bundle.pubkey).toBe(key.pubkeyB64u);
    expect(typeof bundle.sig).toBe("string");
    expect(verifyBundleSignature(bundle)).toBe(true);
  });

  it("omits the agent block when no identity fields exist", () => {
    const key = loadOrCreateEvidenceKey({ KYA_HOME: tmp() });
    const bundle = buildEvidenceBundle({ report: REPORT, windowEvents: EVENTS }, key);
    expect("agent" in bundle).toBe(false);
    expect(verifyBundleSignature(bundle)).toBe(true);
  });

  it("emits only the present fields for a partial identity (agentName only)", () => {
    const key = loadOrCreateEvidenceKey({ KYA_HOME: tmp() });
    const bundle = buildEvidenceBundle(
      { report: REPORT, windowEvents: EVENTS, agent: { agentName: "demo" } },
      key,
    );
    expect(bundle.agent).toEqual({ agentName: "demo" });
    expect(verifyBundleSignature(bundle)).toBe(true);
  });

  it("matches a fixed trail digest vector (anchors the cross-repo canonicalization contract)", () => {
    const key = loadOrCreateEvidenceKey({ KYA_HOME: tmp() });
    const bundle = buildEvidenceBundle({ report: REPORT, windowEvents: EVENTS }, key);
    const trail = bundle.trail as Record<string, unknown>;
    // sha256 hex of canonicalJson(EVENTS) — hardcoded so any canonicalJson drift breaks this test
    expect(trail.digest).toBe(
      "fe211046d57d000869cdfbc00a428fd1fb5eb3905c7026165344d4fd19f02588",
    );
  });

  it("digests an empty trail window as sha256 of canonicalJson([])", () => {
    const key = loadOrCreateEvidenceKey({ KYA_HOME: tmp() });
    const emptyReport: CertifyReport = {
      ...REPORT,
      trail: {
        eventCount: 0,
        verdictMix: { ALLOW: 0, DENY: 0, REQUIRE_APPROVE: 0 },
        modes: { observe: 0, hold: 0, offline: 0 },
      },
    };
    const bundle = buildEvidenceBundle({ report: emptyReport, windowEvents: [] }, key);
    const trail = bundle.trail as Record<string, unknown>;
    expect(trail.eventCount).toBe(0);
    // sha256 hex of "[]"
    expect(trail.digest).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(verifyBundleSignature(bundle)).toBe(true);
  });

  it("clips evidence at 200 code points without splitting surrogate pairs", () => {
    const key = loadOrCreateEvidenceKey({ KYA_HOME: tmp() });
    const withEvidence = (evidence: string): CertifyReport => ({
      ...REPORT,
      requirements: [
        {
          id: "DP-02",
          domain: "data-privacy",
          title: "t",
          severity: "critical",
          status: "pass",
          evidence,
        },
      ],
    });
    const evidenceOf = (report: CertifyReport): string => {
      const bundle = buildEvidenceBundle({ report, windowEvents: EVENTS }, key);
      const reqs = bundle.requirements as Record<string, unknown>[];
      return reqs[0]!.evidence as string;
    };
    // 199 and 200 code points: unclipped
    const e199 = "a".repeat(199);
    const e200 = "a".repeat(200);
    expect(evidenceOf(withEvidence(e199))).toBe(e199);
    expect(evidenceOf(withEvidence(e200))).toBe(e200);
    // 201 code points: clipped to 199 + ellipsis
    expect(evidenceOf(withEvidence(`${"a".repeat(200)}b`))).toBe(`${"a".repeat(199)}…`);
    // 200 code points but 201 UTF-16 units (astral char): still unclipped
    const astralAtEnd = `${"a".repeat(199)}😀`;
    expect(evidenceOf(withEvidence(astralAtEnd))).toBe(astralAtEnd);
    // 201 code points with the astral char at the clip boundary: a UTF-16 slice
    // would split the surrogate pair; the code-point clip must keep it intact
    const straddle = `${"a".repeat(198)}😀bc`;
    const clipped = evidenceOf(withEvidence(straddle));
    expect(clipped).toBe(`${"a".repeat(198)}😀…`);
    expect(Array.from(clipped)).toHaveLength(200);
  });

  it("is deterministic: same input + key ⇒ identical sig", () => {
    const key = loadOrCreateEvidenceKey({ KYA_HOME: tmp() });
    const a = buildEvidenceBundle({ report: REPORT, windowEvents: EVENTS }, key);
    const b = buildEvidenceBundle({ report: REPORT, windowEvents: EVENTS }, key);
    expect(a.sig).toBe(b.sig);
  });
});

describe("runCertify --sign", () => {
  it("writes evidence-bundle.json, auto-generates the key, and the bundle verifies", () => {
    const cwd = tmp();
    const home = tmp();
    const result = runCertify({
      cwd,
      env: { KYA_HOME: home },
      windowDays: 30,
      out: ".kya/certify",
      formats: ["json"],
      jsonStdout: false,
      open: false,
      quiet: true,
      failOn: "never",
      sign: true,
      now: new Date("2026-09-18T12:00:00.000Z"),
    });
    expect(result.bundlePath).toBe(join(cwd, ".kya", "certify", "evidence-bundle.json"));
    const bundle = JSON.parse(readFileSync(result.bundlePath!, "utf8")) as Record<string, unknown>;
    expect(bundle.format).toBe("shield-kya-evidence-bundle");
    expect(bundle.version).toBe(1);
    expect(verifyBundleSignature(bundle)).toBe(true);
    // key auto-generated under KYA_HOME — lifecycle surfaced on the result
    expect(result.keyCreated).toBe(true);
    expect(result.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const key = loadOrCreateEvidenceKey({ KYA_HOME: home });
    expect(bundle.pubkey).toBe(key.pubkeyB64u);
    expect(result.keyFingerprint).toBe(key.fingerprint);
    // second run reuses the same key (continuity of a key)
    const again = runCertify({
      cwd, env: { KYA_HOME: home }, windowDays: 30, out: ".kya/certify",
      formats: ["json"], jsonStdout: false, open: false, quiet: true,
      failOn: "never", sign: true, now: new Date("2026-09-18T12:00:00.000Z"),
    });
    const bundle2 = JSON.parse(readFileSync(again.bundlePath!, "utf8")) as Record<string, unknown>;
    expect(bundle2.pubkey).toBe(bundle.pubkey);
    expect(again.keyCreated).toBe(false);
    expect(again.keyFingerprint).toBe(result.keyFingerprint);
    expect(readFileSync(evidenceKeyPath({ KYA_HOME: home }), "utf8")).toContain("privateKeyPkcs8");
  });

  it("does not write a bundle without --sign", () => {
    const cwd = tmp();
    const home = tmp();
    const result = runCertify({
      cwd, env: { KYA_HOME: home }, windowDays: 30, out: ".kya/certify",
      formats: ["json"], jsonStdout: false, open: false, quiet: true,
      failOn: "never", sign: false,
      now: new Date("2026-09-18T12:00:00.000Z"),
    });
    expect(result.bundlePath).toBeUndefined();
    expect(result.keyFingerprint).toBeUndefined();
    expect(result.keyCreated).toBeUndefined();
  });
});
