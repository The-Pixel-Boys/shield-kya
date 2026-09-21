/**
 * Golden cross-test vectors for the evidence-bundle v1 contract.
 * KYA_WRITE_GOLDEN=1 regenerates the key + expected files (review the diff,
 * commit); otherwise the test asserts byte-stability. The Java verifier tests
 * consume copies of these files — the formats are a hard cross-repo contract.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/hash.js";
import type { CertifyReport } from "../src/certify/evaluate.js";
import type { TrailEvent } from "../src/trail.js";
import {
  buildEvidenceBundle,
  evidenceKeyFromSerialized,
  verifyBundleSignature,
  type BundleAgent,
  type EvidenceKey,
  type SerializedEvidenceKey,
} from "../src/sign/evidence-bundle.js";

const GOLDEN_DIR = fileURLToPath(new URL("./golden", import.meta.url));
const KEY_PATH = join(GOLDEN_DIR, "evidence-key.test.json");
const WRITE = process.env.KYA_WRITE_GOLDEN === "1";
const WRITE_BANNER =
  "*** KYA_WRITE_GOLDEN: WROTE golden files — review git diff before committing ***";
// Pinned fingerprint of the committed test-only key: accidental key rotation
// fails here, one assertion before any sig/digest mismatch.
const EXPECTED_FINGERPRINT = "dec4d977dda4051b";

interface GoldenInput {
  readonly report: CertifyReport;
  readonly windowEvents: readonly TrailEvent[];
  readonly agent?: BundleAgent;
}

function loadOrGenerateKey(): EvidenceKey {
  if (WRITE && !existsSync(KEY_PATH)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const doc: SerializedEvidenceKey = {
      version: 1,
      createdAt: "2026-09-18T00:00:00.000Z",
      publicKeySpki: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64url"),
      privateKeyPkcs8: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url"),
    };
    writeFileSync(KEY_PATH, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    console.log(WRITE_BANNER);
  }
  if (!existsSync(KEY_PATH)) {
    throw new Error(
      "golden key missing — generate once: KYA_WRITE_GOLDEN=1 pnpm vitest run test/golden-vectors.test.ts",
    );
  }
  return evidenceKeyFromSerialized(JSON.parse(readFileSync(KEY_PATH, "utf8")));
}

describe("golden evidence-bundle vectors", () => {
  const key = loadOrGenerateKey();
  const inputs = readdirSync(GOLDEN_DIR)
    .filter((f) => /^bundle-input-\d+\.json$/.test(f))
    .sort();

  it("has at least two committed inputs", () => {
    expect(inputs.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of inputs) {
    const n = file.replace("bundle-input-", "").replace(".json", "");
    it(`bundle-input-${n}: sign → expected sig + sha256, verify round-trip`, () => {
      const input = JSON.parse(
        readFileSync(join(GOLDEN_DIR, file), "utf8"),
      ) as GoldenInput;
      const bundle = buildEvidenceBundle(
        {
          report: input.report,
          windowEvents: input.windowEvents,
          ...(input.agent ? { agent: input.agent } : {}),
        },
        key,
      );
      const digest = createHash("sha256")
        .update(canonicalJson(bundle), "utf8")
        .digest("hex");
      const expectedPath = join(GOLDEN_DIR, `bundle-expected-${n}.json`);
      if (WRITE) {
        writeFileSync(
          expectedPath,
          `${JSON.stringify({ sig: bundle.sig, sha256: digest }, null, 2)}\n`,
          "utf8",
        );
        console.log(WRITE_BANNER);
      }
      const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as {
        sig: string;
        sha256: string;
      };
      expect(bundle.sig).toBe(expected.sig);
      expect(digest).toBe(expected.sha256);
      expect(verifyBundleSignature(bundle)).toBe(true);
      // the exact canonical payload the Java side must reconstruct:
      const { sig: _omitSig, pubkey: _omitPub, ...body } = bundle;
      void _omitSig;
      void _omitPub;
      expect(canonicalJson(body)).toBe(
        canonicalJson(JSON.parse(canonicalJson(body))),
      );
    });
  }

  it("canonicalJson is stable across key order, unicode, and numbers", () => {
    const a = canonicalJson({ b: 1, a: "héllo ✓", n: 0.1 + 0.2 });
    const b = canonicalJson({ n: 0.30000000000000004, a: "héllo ✓", b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":"héllo ✓","b":1,"n":0.30000000000000004}');
    // arrays stay in order; nested objects are sorted recursively
    expect(canonicalJson({ z: [{ y: 1, x: 2 }], a: "x" })).toBe(
      '{"a":"x","z":[{"x":2,"y":1}]}',
    );
  });

  it("key fingerprint format is 16 lowercase hex chars", () => {
    expect(key.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(key.fingerprint).toBe(EXPECTED_FINGERPRINT);
  });
});
