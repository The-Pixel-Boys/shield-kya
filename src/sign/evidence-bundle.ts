/**
 * Signed evidence bundles (v1) — the OSS half of hosted verification.
 * Self-signed by a locally generated ed25519 key: proves bundle integrity and
 * continuity of a key, NOT identity. Identity binding is a hosted claim.
 * node:crypto only — the package dependency list is locked.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { globalConfigDir } from "../config.js";
import { assertNoSecrets } from "../dash/render.js";
import { UsageError } from "../errors.js";
import { canonicalJson } from "../hash.js";
import type { CertifyReport } from "../certify/evaluate.js";
import type { TrailEvent } from "../trail.js";

export const EVIDENCE_BUNDLE_FORMAT = "shield-kya-evidence-bundle";
export const EVIDENCE_BUNDLE_VERSION = 1;

export interface EvidenceKey {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  /** base64url(SPKI DER) — the `pubkey` field of every bundle. */
  readonly pubkeyB64u: string;
  /** First 16 hex chars of sha256(SPKI DER). */
  readonly fingerprint: string;
  /** True when this call generated the key (fresh or after a corrupt file). */
  readonly created: boolean;
  /** True when generation replaced an unreadable/corrupt key file. */
  readonly regenerated: boolean;
}

export interface SerializedEvidenceKey {
  readonly version: 1;
  readonly createdAt: string;
  readonly publicKeySpki: string;
  readonly privateKeyPkcs8: string;
}

export function evidenceKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "keys", "evidence-ed25519.json");
}

export function fingerprintSpki(spkiDer: Buffer): string {
  return createHash("sha256").update(spkiDer).digest("hex").slice(0, 16);
}

/** Rebuild an EvidenceKey from the on-disk JSON shape. Throws UsageError on corrupt input. */
export function evidenceKeyFromSerialized(raw: unknown): EvidenceKey {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError("evidence key file is not an object");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.version !== 1) {
    throw new UsageError("evidence key file has an unsupported version");
  }
  if (
    typeof rec.privateKeyPkcs8 !== "string" ||
    typeof rec.publicKeySpki !== "string"
  ) {
    throw new UsageError("evidence key file is missing key material");
  }
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(rec.privateKeyPkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey({
      key: Buffer.from(rec.publicKeySpki, "base64url"),
      format: "der",
      type: "spki",
    });
    const spkiDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    const derivedSpkiDer = Buffer.from(
      createPublicKey(privateKey).export({ format: "der", type: "spki" }),
    );
    if (!derivedSpkiDer.equals(spkiDer)) {
      throw new Error("pub/private key mismatch");
    }
    return {
      publicKey,
      privateKey,
      pubkeyB64u: spkiDer.toString("base64url"),
      fingerprint: fingerprintSpki(spkiDer),
      created: false,
      regenerated: false,
    };
  } catch {
    throw new UsageError(
      "evidence key file is corrupt — regenerating (old bundles stay verifiable only with the old pubkey)",
    );
  }
}

/** Load the evidence signing key, generating one (mode 0600) on first use. */
export function loadOrCreateEvidenceKey(
  env: NodeJS.ProcessEnv = process.env,
): EvidenceKey {
  const path = evidenceKeyPath(env);
  let existed = false;
  if (existsSync(path)) {
    existed = true;
    try {
      return evidenceKeyFromSerialized(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      /* corrupt or unreadable key file: regenerate below */
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const pkcs8Der = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const doc: SerializedEvidenceKey = {
    version: 1,
    createdAt: new Date().toISOString(),
    publicKeySpki: spkiDer.toString("base64url"),
    privateKeyPkcs8: pkcs8Der.toString("base64url"),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort on non-POSIX */
  }
  return {
    publicKey,
    privateKey,
    pubkeyB64u: doc.publicKeySpki,
    fingerprint: fingerprintSpki(spkiDer),
    created: true,
    regenerated: existed,
  };
}

/** sig = base64url( ed25519_sign( canonicalJson(body) ) ) — canonicalJson from src/hash.ts. */
export function signCanonicalPayload(body: unknown, privateKey: KeyObject): string {
  const payload = Buffer.from(canonicalJson(body), "utf8");
  return sign(null, payload, privateKey).toString("base64url");
}

/** Verify `sig` over canonicalJson(bundle without the `sig` and `pubkey` fields) using the embedded `pubkey`. */
export function verifyBundleSignature(bundle: Record<string, unknown>): boolean {
  const sig = bundle.sig;
  const pubkey = bundle.pubkey;
  if (typeof sig !== "string" || typeof pubkey !== "string") return false;
  const { sig: _omitSig, pubkey: _omitPubkey, ...body } = bundle;
  void _omitSig;
  void _omitPubkey;
  try {
    const key = createPublicKey({
      key: Buffer.from(pubkey, "base64url"),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(canonicalJson(body), "utf8"),
      key,
      Buffer.from(sig, "base64url"),
    );
  } catch {
    return false;
  }
}

export interface BundleAgent {
  readonly agentId?: string;
  readonly agentName?: string;
  readonly host?: "ide" | "runtime";
  readonly product?: string;
}

export interface EvidenceBundleInput {
  readonly report: CertifyReport;
  /** Events inside report.window — the digest binds the bundle to the tape. */
  readonly windowEvents: readonly TrailEvent[];
  readonly agent?: BundleAgent;
}

const MAX_BUNDLE_EVIDENCE_CHARS = 200;

/**
 * Clip to MAX code points (not UTF-16 units): a surrogate-splitting slice
 * re-encodes differently in Java (`?`) than Node (U+FFFD) → cross-repo sig mismatch.
 */
function clipBundleEvidence(evidence: string): string {
  const chars = Array.from(evidence);
  return chars.length > MAX_BUNDLE_EVIDENCE_CHARS
    ? `${chars.slice(0, MAX_BUNDLE_EVIDENCE_CHARS - 1).join("")}…`
    : evidence;
}

/**
 * Build a signed evidence bundle v1 (hard cross-repo contract — see
 * docs/certify.md). sig = base64url(ed25519_sign(canonicalJson(body))) where
 * body is the bundle without the sig and pubkey fields (same stripping as
 * verifyBundleSignature). Self-signed: integrity + key continuity, NOT identity.
 */
export function buildEvidenceBundle(
  input: EvidenceBundleInput,
  key: EvidenceKey,
): Record<string, unknown> {
  const report = input.report;
  const agent =
    input.agent && Object.values(input.agent).some((v) => v !== undefined)
      ? Object.fromEntries(
          Object.entries(input.agent).filter(([, v]) => v !== undefined),
        )
      : undefined;
  const body: Record<string, unknown> = {
    format: EVIDENCE_BUNDLE_FORMAT,
    version: EVIDENCE_BUNDLE_VERSION,
    generatedAt: report.generatedAt,
    ...(agent ? { agent } : {}),
    catalog: { id: report.catalog.id, version: report.catalog.version },
    window: {
      days: report.window.days,
      since: report.window.since,
      until: report.window.until,
    },
    trail: {
      eventCount: report.trail.eventCount,
      digest: createHash("sha256")
        .update(canonicalJson(input.windowEvents), "utf8")
        .digest("hex"),
      verdictMix: report.trail.verdictMix,
      modes: report.trail.modes,
    },
    requirements: report.requirements.map((r) => ({
      id: r.id,
      domain: r.domain,
      status: r.status,
      evidence: clipBundleEvidence(r.evidence),
      ...(r.attestation
        ? { attestation: { text: r.attestation.text, at: r.attestation.at } }
        : {}),
    })),
    overall: report.overall,
  };
  // egress-artifact defense-in-depth, same scan as report.json
  const payload = canonicalJson(body);
  assertNoSecrets(payload);
  return {
    ...body,
    pubkey: key.pubkeyB64u,
    sig: sign(null, Buffer.from(payload, "utf8"), key.privateKey).toString("base64url"),
  };
}
