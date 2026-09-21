import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import {
  attestationsPath,
  loadAttestations,
  recordAttestation,
} from "../src/certify/attest.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-attest-"));
  dirs.push(d);
  return d;
}

describe("attestations store", () => {
  it("records and reloads attestations; latest per requirement wins", () => {
    const cwd = tmp();
    expect(attestationsPath(cwd)).toBe(join(cwd, ".kya", "attestations.json"));
    recordAttestation(cwd, "SOC-01", "AUP: https://example.com/aup");
    recordAttestation(cwd, "SOC-02", "runbook v1");
    const second = recordAttestation(cwd, "SOC-01", "AUP v2: https://example.com/aup2");
    const map = loadAttestations(cwd);
    expect(map.size).toBe(2);
    expect(map.get("SOC-01")?.text).toBe("AUP v2: https://example.com/aup2");
    expect(map.get("SOC-01")?.at).toBe(second.at);
    expect(map.get("SOC-02")?.text).toBe("runbook v1");
  });

  it("missing or corrupt file yields an empty map, never throws", () => {
    const cwd = tmp();
    expect(loadAttestations(cwd).size).toBe(0);
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    writeFileSync(attestationsPath(cwd), "{not json");
    expect(loadAttestations(cwd).size).toBe(0);
    writeFileSync(
      attestationsPath(cwd),
      JSON.stringify({ version: 1, attestations: [{ requirementId: 1 }, "junk", null] }),
    );
    expect(loadAttestations(cwd).size).toBe(0);
  });

  it("validates id and text; refuses secret-shaped attestation text", () => {
    const cwd = tmp();
    expect(() => recordAttestation(cwd, "soc-01", "x")).toThrow(UsageError);
    expect(() => recordAttestation(cwd, "SOC-01", "   ")).toThrow(UsageError);
    expect(() => recordAttestation(cwd, "SOC-01", "y".repeat(2001))).toThrow(/2000/);
    const secretShaped = `token: ${["abcdef01", "23456789", "abcdef"].join("")}`;
    expect(() => recordAttestation(cwd, "SOC-01", secretShaped)).toThrow(/secret/);
    const ok = recordAttestation(cwd, " SOC-03 ", "  models: claude, kimi  ");
    expect(ok.requirementId).toBe("SOC-03");
    expect(ok.text).toBe("models: claude, kimi");
  });

  it("rejects attestation text containing control characters", () => {
    const cwd = tmp();
    expect(() => recordAttestation(cwd, "SOC-01", "line one\nline two")).toThrow(
      /control/,
    );
    expect(() => recordAttestation(cwd, "SOC-01", "col\tcol")).toThrow(/control/);
    expect(() => recordAttestation(cwd, "SOC-01", "bell\u0007in text")).toThrow(/control/);
    expect(() => recordAttestation(cwd, "SOC-01", "del\u007fchar")).toThrow(/control/);
    expect(loadAttestations(cwd).size).toBe(0);
  });

  it("load skips entries with control characters in text or timestamp", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    writeFileSync(
      attestationsPath(cwd),
      JSON.stringify({
        version: 1,
        attestations: [
          { requirementId: "SOC-01", text: "clean text", at: "2026-09-20T00:00:00.000Z" },
          { requirementId: "SOC-02", text: "two\nlines", at: "2026-09-20T00:00:00.000Z" },
          { requirementId: "SOC-03", text: "clean", at: "2026-09-20T00:00:00.000Z\nspoofed" },
        ],
      }),
    );
    const map = loadAttestations(cwd);
    expect(map.size).toBe(1);
    expect(map.get("SOC-01")?.text).toBe("clean text");
  });

  it("load sanitizes bidi/zero-width chars like record does", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    writeFileSync(
      attestationsPath(cwd),
      JSON.stringify({
        version: 1,
        attestations: [
          {
            requirementId: "SOC-01",
            text: "run\u200bbook \u202espoof\u202c",
            at: "2026-09-20T00:00:00.000Z",
          },
          { requirementId: "SOC-02", text: "\u200b", at: "2026-09-20T00:00:00.000Z" },
        ],
      }),
    );
    const map = loadAttestations(cwd);
    expect(map.size).toBe(1);
    expect(map.get("SOC-01")?.text).toBe("runbook spoof");
  });

  it("oversize store file yields an empty map", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    writeFileSync(attestationsPath(cwd), " ".repeat(257 * 1024));
    expect(loadAttestations(cwd).size).toBe(0);
  });

  it("rejects malformed requirement ids", () => {
    const cwd = tmp();
    for (const bad of ["SOC-01x", "SOC-", "", "SOC01"]) {
      expect(() => recordAttestation(cwd, bad, "text")).toThrow(UsageError);
    }
  });

  it("store file is written 0600", () => {
    const cwd = tmp();
    recordAttestation(cwd, "SOC-01", "runbook v1");
    expect(statSync(attestationsPath(cwd)).mode & 0o777).toBe(0o600);
  });

  it("a failed write leaves the prior store intact", () => {
    const cwd = tmp();
    recordAttestation(cwd, "SOC-01", "runbook v1");
    // Force the tmp write inside atomicWriteSync to fail (EISDIR): the crash
    // path must not truncate or corrupt the existing store.
    mkdirSync(`${attestationsPath(cwd)}.kya-tmp-${process.pid}`);
    expect(() => recordAttestation(cwd, "SOC-02", "runbook v2")).toThrow();
    const map = loadAttestations(cwd);
    expect(map.size).toBe(1);
    expect(map.get("SOC-01")?.text).toBe("runbook v1");
  });
});
