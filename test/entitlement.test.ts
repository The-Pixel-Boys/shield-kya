import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENTERPRISE_PANES,
  licenseGrantsEnterprise,
  paneAllowed,
  planeGrantsEnterprise,
  resolveEntitlement,
} from "../src/dash/entitlement.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-ent-"));
  dirs.push(d);
  return d;
}

function signLicense(body: Record<string, unknown>): { pem: string; raw: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = Buffer.from(
    `{${Object.keys(body)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${JSON.stringify(body[k])}`)
      .join(",")}}`,
    "utf8",
  );
  const sig = sign(null, payload, privateKey).toString("base64");
  return { pem, raw: JSON.stringify({ ...body, sig }) };
}

describe("resolveEntitlement", () => {
  it("defaults to free with enterprise panes locked", () => {
    const cwd = tmp();
    const ent = resolveEntitlement({ env: {}, cwd });
    expect(ent.plan).toBe("free");
    expect(ent.source).toBe("default");
    expect(ent.locked).toEqual([...ENTERPRISE_PANES]);
    expect(paneAllowed(ent, "home")).toBe(true);
    expect(paneAllowed(ent, "cases")).toBe(false);
  });

  it("KYA_DASH_PLAN=enterprise unlocks", () => {
    const cwd = tmp();
    const ent = resolveEntitlement({ env: { KYA_DASH_PLAN: "enterprise" }, cwd });
    expect(ent.plan).toBe("enterprise");
    expect(ent.source).toBe("env");
    expect(paneAllowed(ent, "metrics")).toBe(true);
  });

  it("invalid license file stays free", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".kya"));
    writeFileSync(join(cwd, ".kya", "license"), "{not-json", "utf8");
    const ent = resolveEntitlement({ env: {}, cwd });
    expect(ent.plan).toBe("free");
  });

  it("license null or non-object does not throw", () => {
    expect(licenseGrantsEnterprise("null", new Date(), undefined)).toBe(false);
    expect(licenseGrantsEnterprise('"enterprise"', new Date(), undefined)).toBe(false);
  });

  it("valid signed enterprise license unlocks", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".kya"));
    const { pem, raw } = signLicense({
      plan: "enterprise",
      exp: "2099-01-01T00:00:00Z",
      iss: "test",
      sub: "dev",
    });
    writeFileSync(join(cwd, ".kya", "license"), raw, "utf8");
    const ent = resolveEntitlement({ env: {}, cwd, licensePublicKeyPem: pem });
    expect(ent.plan).toBe("enterprise");
    expect(ent.source).toBe("license");
  });

  it("expired license does not unlock", () => {
    const now = new Date("2026-08-12T00:00:00Z");
    const { pem, raw } = signLicense({
      plan: "enterprise",
      exp: "2020-01-01T00:00:00Z",
    });
    expect(licenseGrantsEnterprise(raw, now, pem)).toBe(false);
  });

  it("SCALE plane unlocks; STARTER does not", () => {
    expect(planeGrantsEnterprise({ plan: "SCALE" })).toBe(true);
    expect(planeGrantsEnterprise({ plan: "STARTER" })).toBe(false);
    expect(planeGrantsEnterprise({ plan: "ENTERPRISE" })).toBe(false);
    expect(planeGrantsEnterprise({ dash: "enterprise" })).toBe(true);
    expect(planeGrantsEnterprise({ features: ["enterprise_tui"] })).toBe(true);
  });
});
