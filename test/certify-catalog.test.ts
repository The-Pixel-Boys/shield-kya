import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/errors.js";
import {
  defaultCatalogPath,
  loadCatalog,
  MAX_CATALOG_BYTES,
  validateCatalog,
  type Catalog,
} from "../src/certify/catalog.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpCatalog(doc: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "kya-catalog-"));
  dirs.push(d);
  const p = join(d, "catalog.json");
  writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
  return p;
}

describe("bundled catalog", () => {
  it("loads the packaged Agent Trust Baseline v0", () => {
    const catalog = loadCatalog();
    expect(catalog.id).toBe("agent-trust-baseline");
    expect(catalog.version).toBe("0.1.0");
    expect(catalog.domains).toEqual([
      "data-privacy",
      "security",
      "safety",
      "reliability",
      "accountability",
      "society",
    ]);
    expect(catalog.requirements).toHaveLength(30);
    expect(defaultCatalogPath()).toMatch(/catalog\/agent-trust-baseline-v0\.json$/);
    const ids = catalog.requirements.map((r) => r.id);
    expect(new Set(ids).size).toBe(30);
    const attest = catalog.requirements.filter((r) => r.check.kind === "attest");
    const machine = catalog.requirements.filter((r) => r.check.kind !== "attest");
    expect(attest.length).toBe(13);
    expect(machine.length).toBe(17);
    // every requirement sits in a declared domain
    for (const r of catalog.requirements) {
      expect(catalog.domains).toContain(r.domain);
    }
  });
});

describe("validateCatalog", () => {
  const base: Catalog = loadCatalog();

  it("round-trips the bundled catalog", () => {
    expect(validateCatalog(JSON.parse(JSON.stringify(base)))).toEqual(base);
  });

  it("rejects non-object roots and missing fields", () => {
    expect(() => validateCatalog(null)).toThrow(UsageError);
    expect(() => validateCatalog([])).toThrow(UsageError);
    expect(() => validateCatalog({ id: "x" })).toThrow(/version/);
    expect(() =>
      validateCatalog({ id: "x", version: "1", updated: "d", domains: [], requirements: [] }),
    ).toThrow(/domains/);
  });

  it("rejects duplicate and malformed requirement ids", () => {
    const dup = JSON.parse(JSON.stringify(base)) as Catalog;
    (dup.requirements as unknown[]).push(JSON.parse(JSON.stringify(base.requirements[0])));
    expect(() => validateCatalog(dup)).toThrow(/duplicate/);
    const bad = JSON.parse(JSON.stringify(base)) as ReturnType<typeof JSON.parse>;
    bad.requirements[0].id = "dp-01";
    expect(() => validateCatalog(bad)).toThrow(/id/);
  });

  it("rejects unknown domains, severities, and check kinds", () => {
    const mk = (mutate: (r: Record<string, unknown>) => void) => {
      const doc = JSON.parse(JSON.stringify(base)) as {
        requirements: Record<string, unknown>[];
      };
      mutate(doc.requirements[0]!);
      return doc;
    };
    expect(() => validateCatalog(mk((r) => (r.domain = "nope")))).toThrow(/domain/);
    expect(() => validateCatalog(mk((r) => (r.severity = "fatal")))).toThrow(/severity/);
    expect(() => validateCatalog(mk((r) => (r.check = { kind: "nmap_scan" })))).toThrow(
      /check kind/,
    );
  });

  it("validates per-kind fields", () => {
    const req = (check: unknown) => ({
      id: "XX-01",
      domain: "security",
      title: "t",
      text: "x",
      severity: "high",
      check,
    });
    const wrap = (check: unknown) => ({
      id: "c",
      version: "1",
      updated: "d",
      domains: ["security"],
      requirements: [req(check)],
    });
    expect(() => validateCatalog(wrap({ kind: "hooks_wired" }))).toThrow(/min/);
    expect(() => validateCatalog(wrap({ kind: "trail_zero", windowDays: 0 }))).toThrow(
      /windowDays/,
    );
    expect(
      () => validateCatalog(wrap({ kind: "trail_min", windowDays: 7, match: {} })),
    ).toThrow(/min/);
    expect(
      () =>
        validateCatalog(
          wrap({ kind: "trail_ratio", windowDays: 7, match: {}, maxRatio: 1.5 }),
        ),
    ).toThrow(/maxRatio/);
    expect(() => validateCatalog(wrap({ kind: "orr_overall", max: "red" }))).toThrow(
      /max/,
    );
    expect(
      () => validateCatalog(wrap({ kind: "orr_category", id: "", max: "amber" })),
    ).toThrow(/id/);
    expect(() => validateCatalog(wrap({ kind: "orr_fresh" }))).toThrow(/maxAgeDays/);
    expect(() => validateCatalog(wrap({ kind: "attest" }))).toThrow(/prompt/);
    expect(() => validateCatalog(wrap({ kind: "attest", prompt: "one\ntwo" }))).toThrow(
      /prompt/,
    );
    expect(
      () => validateCatalog(wrap({ kind: "config_mode", not: "hold" })),
    ).toThrow(/config_mode/);
    expect(
      validateCatalog(wrap({ kind: "trail_zero", windowDays: 30, match: {} })).requirements[0]!
        .check,
    ).toEqual({ kind: "trail_zero", windowDays: 30, match: {} });
  });
});

describe("loadCatalog path handling", () => {
  it("throws UsageError for missing, oversize, or invalid JSON catalogs", () => {
    expect(() => loadCatalog("/no/such/catalog.json")).toThrow(UsageError);
    expect(() => loadCatalog(tmpCatalog("{not json"))).toThrow(/JSON/);
    expect(() => loadCatalog(tmpCatalog(" ".repeat(MAX_CATALOG_BYTES + 1)))).toThrow(
      /exceeds/i,
    );
  });

  it("distinguishes read errors from JSON parse errors", () => {
    const p = tmpCatalog("{}");
    chmodSync(p, 0o000);
    expect(() => loadCatalog(p)).toThrow(/readable/);
    expect(() => loadCatalog(tmpdir())).toThrow(UsageError);
  });

  it("loads a custom catalog via --catalog path", () => {
    const base = loadCatalog();
    const slim = { ...base, requirements: [base.requirements[0]] };
    const p = tmpCatalog(slim);
    expect(loadCatalog(p).requirements).toHaveLength(1);
  });
});

describe("validateCatalog hostile match inputs", () => {
  const req = (check: unknown) => ({
    id: "XX-01",
    domain: "security",
    title: "t",
    text: "x",
    severity: "high",
    check,
  });
  const wrap = (check: unknown) => ({
    id: "c",
    version: "1",
    updated: "d",
    domains: ["security"],
    requirements: [req(check)],
  });
  const trail = (match: unknown) => ({ kind: "trail_zero", windowDays: 30, match });

  it("rejects match that is an array, null, or non-object", () => {
    expect(() => validateCatalog(wrap(trail([])))).toThrow(/match/);
    expect(() => validateCatalog(wrap(trail(null)))).toThrow(/match/);
    expect(() => validateCatalog(wrap(trail("ALLOW")))).toThrow(/match/);
  });

  it("rejects invalid match.mode and non-boolean match.neverEvent", () => {
    expect(() => validateCatalog(wrap(trail({ mode: "bogus" })))).toThrow(/mode/);
    expect(() => validateCatalog(wrap(trail({ neverEvent: "yes" })))).toThrow(/neverEvent/);
  });

  it("ignores a __proto__ key in match without prototype pollution", () => {
    const doc = JSON.parse(
      '{"id":"c","version":"1","updated":"d","domains":["security"],"requirements":[{"id":"XX-01","domain":"security","title":"t","text":"x","severity":"high","check":{"kind":"trail_zero","windowDays":30,"match":{"__proto__":{"polluted":true},"verdict":"ALLOW"}}}]}',
    ) as unknown;
    const catalog = validateCatalog(doc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(catalog.requirements[0]!.check).toEqual({
      kind: "trail_zero",
      windowDays: 30,
      match: { verdict: "ALLOW" },
    });
  });
});
