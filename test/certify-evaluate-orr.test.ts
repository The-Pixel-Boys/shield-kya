import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RequirementCheck, CatalogRequirement } from "../src/certify/catalog.js";
import { evaluateRequirement, type EvidenceContext } from "../src/certify/evaluate.js";
import { loadOrrCategoryRatings } from "../src/receipt/enrich.js";
import type { OrrCard } from "../src/receipt/enrich.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-09-18T12:00:00.000Z");

function ctx(over: Partial<EvidenceContext>): EvidenceContext {
  return {
    now: NOW,
    events: [],
    gateMode: "observe",
    wiredHostCount: 0,
    orr: undefined,
    orrCategories: undefined,
    sandboxCount: 0,
    receiptCount: 0,
    showbackPresent: false,
    attestations: new Map(),
    ...over,
  };
}

function req(check: RequirementCheck): CatalogRequirement {
  return { id: "SEC-04", domain: "security", title: "t", text: "x", severity: "high", check };
}

function orrCard(over: Partial<OrrCard>): OrrCard {
  return {
    overall: "amber",
    disposition: "conditional",
    primaryFailureMode: "x",
    mostUrgentFix: "y",
    generatedAt: "2026-09-10T00:00:00.000Z",
    targetName: "demo",
    scorecards: { pass: 1, fail: 0, partial: 0, notEvaluated: 0 },
    ...over,
  };
}

describe("orr_overall", () => {
  const check: RequirementCheck = { kind: "orr_overall", max: "amber" };
  it("ranks green<amber<red against max; missing report is insufficient_evidence", () => {
    expect(evaluateRequirement(req(check), ctx({})).status).toBe("insufficient_evidence");
    expect(evaluateRequirement(req(check), ctx({ orr: orrCard({ overall: "green" }) })).status).toBe("pass");
    expect(evaluateRequirement(req(check), ctx({ orr: orrCard({ overall: "amber" }) })).status).toBe("pass");
    expect(evaluateRequirement(req(check), ctx({ orr: orrCard({ overall: "red" }) })).status).toBe("gap");
  });
});

describe("orr_category", () => {
  const check: RequirementCheck = { kind: "orr_category", id: "security_platform", max: "amber" };
  it("uses per-category ratings; unknown category is insufficient_evidence", () => {
    expect(evaluateRequirement(req(check), ctx({})).status).toBe("insufficient_evidence");
    expect(
      evaluateRequirement(req(check), ctx({ orrCategories: { security_platform: "red" } })).status,
    ).toBe("gap");
    expect(
      evaluateRequirement(req(check), ctx({ orrCategories: { security_platform: "amber" } })).status,
    ).toBe("pass");
    expect(
      evaluateRequirement(req(check), ctx({ orrCategories: { other: "green" } })).status,
    ).toBe("insufficient_evidence");
  });
});

describe("orr_fresh", () => {
  const check: RequirementCheck = { kind: "orr_fresh", maxAgeDays: 30 };
  it("passes within maxAgeDays, gaps when stale, insufficient on bad ts", () => {
    expect(evaluateRequirement(req(check), ctx({})).status).toBe("insufficient_evidence");
    const fresh = evaluateRequirement(req(check), ctx({ orr: orrCard({}) }));
    expect(fresh.status).toBe("pass");
    expect(fresh.evidence).toContain("8d");
    expect(
      evaluateRequirement(req(check), ctx({ orr: orrCard({ generatedAt: "2026-01-01T00:00:00.000Z" }) })).status,
    ).toBe("gap");
    expect(
      evaluateRequirement(req(check), ctx({ orr: orrCard({ generatedAt: "garbage" }) })).status,
    ).toBe("insufficient_evidence");
  });

  it("compares exact ms — exactly maxAgeDays old passes, 1ms older gaps", () => {
    // NOW is 2026-09-18T12:00:00.000Z; maxAgeDays 30 → boundary 2026-08-19T12:00:00.000Z.
    expect(
      evaluateRequirement(
        req(check),
        ctx({ orr: orrCard({ generatedAt: "2026-08-19T12:00:00.000Z" }) }),
      ).status,
    ).toBe("pass");
    expect(
      evaluateRequirement(
        req(check),
        ctx({ orr: orrCard({ generatedAt: "2026-08-19T11:59:59.999Z" }) }),
      ).status,
    ).toBe("gap");
  });

  it("treats a future generatedAt as insufficient_evidence (clock skew)", () => {
    expect(
      evaluateRequirement(
        req(check),
        ctx({ orr: orrCard({ generatedAt: "2026-09-19T12:00:00.000Z" }) }),
      ).status,
    ).toBe("insufficient_evidence");
  });
});

describe("attest", () => {
  const check: RequirementCheck = { kind: "attest", prompt: "Confirm the thing." };
  it("gaps without an attestation (with CLI hint), attested with one", () => {
    const bare = evaluateRequirement(req(check), ctx({}));
    expect(bare.status).toBe("gap");
    expect(bare.evidence).toContain("--attest SEC-04");
    const withAtt = evaluateRequirement(
      req(check),
      ctx({ attestations: new Map([["SEC-04", { text: "done", at: "2026-09-01T00:00:00.000Z" }]]) }),
    );
    expect(withAtt.status).toBe("attested");
    expect(withAtt.attestation).toEqual({ text: "done", at: "2026-09-01T00:00:00.000Z" });
  });

  it("attestation attaches to any requirement's result, not only attest kind", () => {
    const r = evaluateRequirement(
      req({ kind: "hooks_wired", min: 1 }),
      ctx({
        wiredHostCount: 1,
        attestations: new Map([["SEC-04", { text: "note", at: "2026-09-01T00:00:00.000Z" }]]),
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.attestation?.text).toBe("note");
  });
});

describe("loadOrrCategoryRatings", () => {
  it("reads category ratings from <cwd>/orr-report/report.json", () => {
    const root = mkdtempSync(join(tmpdir(), "kya-orrcat-"));
    dirs.push(root);
    mkdirSync(join(root, "orr-report"), { recursive: true });
    writeFileSync(
      join(root, "orr-report", "report.json"),
      JSON.stringify({
        overall: "amber",
        disposition: "conditional",
        categories: [
          { id: "security_platform", label: "Security", rating: "amber", tldr: "x" },
          { id: "engineering_craft", label: "Craft", rating: "green", tldr: "y" },
          { id: "broken", rating: "purple" },
        ],
      }),
    );
    expect(loadOrrCategoryRatings(root)).toEqual({
      security_platform: "amber",
      engineering_craft: "green",
    });
  });

  it("returns undefined when the report is missing or has no valid categories", () => {
    const root = mkdtempSync(join(tmpdir(), "kya-orrcat-"));
    dirs.push(root);
    expect(loadOrrCategoryRatings(root)).toBeUndefined();
    mkdirSync(join(root, "orr-report"), { recursive: true });
    writeFileSync(join(root, "orr-report", "report.json"), JSON.stringify({ overall: "red" }));
    expect(loadOrrCategoryRatings(root)).toBeUndefined();
  });
});
