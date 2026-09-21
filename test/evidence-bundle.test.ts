import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_BUNDLE_FORMAT,
  EVIDENCE_BUNDLE_VERSION,
  evidenceKeyFromSerialized,
  evidenceKeyPath,
  fingerprintSpki,
  loadOrCreateEvidenceKey,
  signCanonicalPayload,
  verifyBundleSignature,
} from "../src/sign/evidence-bundle.js";

describe("evidence key", () => {
  it("generates a 0600 ed25519 key on first use and reloads it", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-sign-"));
    const env = { KYA_HOME: home };
    const k1 = loadOrCreateEvidenceKey(env);
    expect(k1.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(k1.pubkeyB64u.length).toBeGreaterThan(40);
    expect(k1.created).toBe(true);
    expect(k1.regenerated).toBe(false);
    const path = evidenceKeyPath(env);
    expect(path).toBe(join(home, ".kya", "keys", "evidence-ed25519.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const k2 = loadOrCreateEvidenceKey(env);
    expect(k2.pubkeyB64u).toBe(k1.pubkeyB64u);
    expect(k2.fingerprint).toBe(k1.fingerprint);
    expect(k2.created).toBe(false);
    expect(k2.regenerated).toBe(false);
  });

  it("fingerprint is first 16 hex of sha256(SPKI DER)", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-sign-"));
    const key = loadOrCreateEvidenceKey({ KYA_HOME: home });
    const spkiDer = Buffer.from(key.pubkeyB64u, "base64url");
    expect(fingerprintSpki(spkiDer)).toBe(key.fingerprint);
  });

  it("regenerates a fresh key when the key file is corrupt", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-sign-"));
    const env = { KYA_HOME: home };
    const k1 = loadOrCreateEvidenceKey(env);
    writeFileSync(evidenceKeyPath(env), "not json garbage {{{", "utf8");
    const k2 = loadOrCreateEvidenceKey(env);
    expect(k2.fingerprint).not.toBe(k1.fingerprint);
    expect(k2.pubkeyB64u).not.toBe(k1.pubkeyB64u);
    // regeneration after a corrupt file is reported as both created and regenerated
    expect(k2.created).toBe(true);
    expect(k2.regenerated).toBe(true);
    // the regenerated file is valid and matches the returned key
    const doc = JSON.parse(readFileSync(evidenceKeyPath(env), "utf8")) as unknown;
    const k3 = evidenceKeyFromSerialized(doc);
    expect(k3.pubkeyB64u).toBe(k2.pubkeyB64u);
    expect(k3.fingerprint).toBe(k2.fingerprint);
    expect(statSync(evidenceKeyPath(env)).mode & 0o777).toBe(0o600);
    const k4 = loadOrCreateEvidenceKey(env);
    expect(k4.created).toBe(false);
    expect(k4.regenerated).toBe(false);
  });

  it("round-trips a serialized key and rejects corrupt ones", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-sign-"));
    const env = { KYA_HOME: home };
    const k1 = loadOrCreateEvidenceKey(env);
    const doc = JSON.parse(readFileSync(evidenceKeyPath(env), "utf8")) as unknown;
    const k2 = evidenceKeyFromSerialized(doc);
    expect(k2.pubkeyB64u).toBe(k1.pubkeyB64u);
    const sig = signCanonicalPayload({ hello: "world" }, k1.privateKey);
    expect(
      verifyBundleSignature({ hello: "world", pubkey: k2.pubkeyB64u, sig }),
    ).toBe(true);
    expect(() => evidenceKeyFromSerialized({ version: 1 })).toThrow();
    expect(() => evidenceKeyFromSerialized("nope")).toThrow();
    expect(() =>
      evidenceKeyFromSerialized({ privateKeyPkcs8: "!!!", publicKeySpki: "!!!" }),
    ).toThrow();
  });
});

describe("bundle signature", () => {
  it("verify(sign(x)) round-trips; tamper and non-strings are rejected", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-sign-"));
    const key = loadOrCreateEvidenceKey({ KYA_HOME: home });
    const body = {
      format: EVIDENCE_BUNDLE_FORMAT,
      version: EVIDENCE_BUNDLE_VERSION,
      n: [1, 2, 3],
      s: "héllo ✓",
    };
    const bundle: Record<string, unknown> = {
      ...body,
      pubkey: key.pubkeyB64u,
      sig: signCanonicalPayload(body, key.privateKey),
    };
    expect(verifyBundleSignature(bundle)).toBe(true);
    expect(verifyBundleSignature({ ...bundle, version: 2 })).toBe(false);
    expect(
      verifyBundleSignature({ ...bundle, sig: `${String(bundle.sig).slice(0, -2)}AA` }),
    ).toBe(false);
    expect(verifyBundleSignature({ ...bundle, sig: 42 })).toBe(false);
    expect(verifyBundleSignature({ ...bundle, pubkey: "!!!" })).toBe(false);
    // key order in the source object must not matter (canonicalJson sorts keys)
    const reordered: Record<string, unknown> = {
      sig: bundle.sig,
      pubkey: bundle.pubkey,
      s: "héllo ✓",
      n: [1, 2, 3],
      version: EVIDENCE_BUNDLE_VERSION,
      format: EVIDENCE_BUNDLE_FORMAT,
    };
    expect(verifyBundleSignature(reordered)).toBe(true);
  });
});
