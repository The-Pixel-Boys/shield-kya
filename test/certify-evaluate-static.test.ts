import { describe, expect, it } from "vitest";
import type { RequirementCheck, CatalogRequirement } from "../src/certify/catalog.js";
import { evaluateRequirement, type EvidenceContext } from "../src/certify/evaluate.js";

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
  return { id: "SEC-01", domain: "security", title: "t", text: "x", severity: "high", check };
}

describe("config_mode", () => {
  const check: RequirementCheck = { kind: "config_mode", not: "observe" };
  it("gaps on observe with remediation, passes on hold/offline", () => {
    const gap = evaluateRequirement(req(check), ctx({ gateMode: "observe" }));
    expect(gap.status).toBe("gap");
    expect(gap.evidence).toContain("KYA_HOLD");
    expect(evaluateRequirement(req(check), ctx({ gateMode: "hold" })).status).toBe("pass");
    expect(evaluateRequirement(req(check), ctx({ gateMode: "offline" })).status).toBe("pass");
  });
});

describe("hooks_wired", () => {
  const check: RequirementCheck = { kind: "hooks_wired", min: 1 };
  it("counts wired hosts against min", () => {
    expect(evaluateRequirement(req(check), ctx({ wiredHostCount: 0 })).status).toBe("gap");
    const ok = evaluateRequirement(req(check), ctx({ wiredHostCount: 2 }));
    expect(ok.status).toBe("pass");
    expect(ok.evidence).toContain("2 wired host(s)");
  });
});

describe("sandbox_inventory", () => {
  const check: RequirementCheck = { kind: "sandbox_inventory", min: 1 };
  it("passes with a sandbox record, gaps without", () => {
    expect(evaluateRequirement(req(check), ctx({ sandboxCount: 0 })).status).toBe("gap");
    expect(evaluateRequirement(req(check), ctx({ sandboxCount: 1 })).status).toBe("pass");
  });
});

describe("receipts_present", () => {
  const check: RequirementCheck = { kind: "receipts_present", min: 1 };
  it("passes when receipts exist", () => {
    expect(evaluateRequirement(req(check), ctx({ receiptCount: 0 })).status).toBe("gap");
    expect(evaluateRequirement(req(check), ctx({ receiptCount: 3 })).status).toBe("pass");
  });
});

describe("showback_present", () => {
  const check: RequirementCheck = { kind: "showback_present" };
  it("passes when a showback card exists", () => {
    expect(evaluateRequirement(req(check), ctx({ showbackPresent: false })).status).toBe("gap");
    expect(evaluateRequirement(req(check), ctx({ showbackPresent: true })).status).toBe("pass");
  });
});
