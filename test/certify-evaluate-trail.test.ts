import { describe, expect, it } from "vitest";
import type { RequirementCheck, CatalogRequirement } from "../src/certify/catalog.js";
import {
  evaluateRequirement,
  matchEvent,
  type EvidenceContext,
} from "../src/certify/evaluate.js";
import type { TrailEvent } from "../src/trail.js";

const NOW = new Date("2026-09-18T12:00:00.000Z");

function ev(over: Partial<TrailEvent>): TrailEvent {
  return {
    ts: "2026-09-18T00:00:00.000Z",
    sessionId: "s1",
    toolId: "Bash",
    verdict: "ALLOW",
    reasonCode: "LOW_RISK_READ",
    mode: "observe",
    ...over,
  };
}

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
  return {
    id: "DP-02",
    domain: "data-privacy",
    title: "t",
    text: "x",
    severity: "critical",
    check,
  };
}

describe("matchEvent", () => {
  it("matches all given fields and ignores the rest", () => {
    const e = ev({ verdict: "allow", reasonCode: "SHELL_EXEC", mode: "hold", neverEvent: true });
    expect(matchEvent(e, {})).toBe(true);
    expect(matchEvent(e, { verdict: "ALLOW" })).toBe(true); // case-insensitive
    expect(matchEvent(e, { reasonCode: "SHELL_EXEC", mode: "hold" })).toBe(true);
    expect(matchEvent(e, { neverEvent: true })).toBe(true);
    expect(matchEvent(e, { neverEvent: false })).toBe(false);
    expect(matchEvent(e, { verdict: "DENY" })).toBe(false);
    expect(matchEvent(e, { reasonCode: "shell_exec" })).toBe(false); // exact
    expect(matchEvent(e, { mode: "observe" })).toBe(false);
    expect(matchEvent(ev({}), { neverEvent: false })).toBe(true); // absent flag counts as false
  });
});

describe("trail_zero", () => {
  const check: RequirementCheck = {
    kind: "trail_zero",
    windowDays: 30,
    match: { verdict: "ALLOW", reasonCode: "HIGH_STAKES_WRITE", mode: "hold" },
  };

  it("passes when no events match in the window", () => {
    const events = [
      ev({ ts: "2026-09-01T00:00:00.000Z", verdict: "DENY", reasonCode: "HIGH_STAKES_WRITE", mode: "hold" }),
      ev({ ts: "2026-09-02T00:00:00.000Z" }),
    ];
    const r = evaluateRequirement(req(check), ctx({ events }));
    expect(r.status).toBe("pass");
    expect(r.evidence).toContain("0/2");
  });

  it("gaps with the latest matching ts when an event matches", () => {
    const events = [
      ev({ ts: "2026-09-10T00:00:00.000Z", verdict: "ALLOW", reasonCode: "HIGH_STAKES_WRITE", mode: "hold" }),
    ];
    const r = evaluateRequirement(req(check), ctx({ events }));
    expect(r.status).toBe("gap");
    expect(r.evidence).toContain("2026-09-10T00:00:00.000Z");
  });

  it("multi-match gap picks the true latest, unsorted input, ts ISO-normalized", () => {
    const events = [
      ev({ ts: "2026-09-05T00:00:00.000Z", verdict: "ALLOW", reasonCode: "HIGH_STAKES_WRITE", mode: "hold" }),
      // Latest in time, but not last in the array; offset form must be normalized.
      ev({ ts: "2026-09-12T02:00:00.000+02:00", verdict: "ALLOW", reasonCode: "HIGH_STAKES_WRITE", mode: "hold" }),
      ev({ ts: "2026-09-08T00:00:00.000Z", verdict: "ALLOW", reasonCode: "HIGH_STAKES_WRITE", mode: "hold" }),
    ];
    const r = evaluateRequirement(req(check), ctx({ events }));
    expect(r.status).toBe("gap");
    expect(r.evidence).toContain("3 event(s)");
    expect(r.evidence).toContain("latest 2026-09-12T00:00:00.000Z");
    expect(r.evidence).not.toContain("+02:00");
  });

  it("yields insufficient_evidence on an empty window (never vacuous pass)", () => {
    expect(evaluateRequirement(req(check), ctx({ events: [] })).status).toBe(
      "insufficient_evidence",
    );
    // events older than the window still mean empty window
    const old = [ev({ ts: "2026-01-01T00:00:00.000Z" })];
    expect(evaluateRequirement(req(check), ctx({ events: old })).status).toBe(
      "insufficient_evidence",
    );
  });
});

describe("trail_min", () => {
  const check: RequirementCheck = {
    kind: "trail_min",
    windowDays: 90,
    match: { verdict: "DENY" },
    min: 1,
  };

  it("passes at or above min, gaps below", () => {
    const deny = ev({ verdict: "DENY" });
    expect(evaluateRequirement(req(check), ctx({ events: [deny] })).status).toBe("pass");
    expect(evaluateRequirement(req(check), ctx({ events: [ev({})] })).status).toBe("gap");
    expect(evaluateRequirement(req(check), ctx({ events: [] })).status).toBe(
      "insufficient_evidence",
    );
  });

  it("REL-01 style empty match counts any event", () => {
    const active: RequirementCheck = { kind: "trail_min", windowDays: 7, match: {}, min: 1 };
    expect(evaluateRequirement(req(active), ctx({ events: [ev({})] })).status).toBe("pass");
  });
});

describe("trail_ratio", () => {
  const check: RequirementCheck = {
    kind: "trail_ratio",
    windowDays: 30,
    match: { reasonCode: "UNKNOWN_TOOL" },
    maxRatio: 0.05,
  };

  it("passes at or below maxRatio, gaps above", () => {
    const events = [
      ...Array.from({ length: 19 }, () => ev({})),
      ev({ reasonCode: "UNKNOWN_TOOL" }),
    ];
    const r = evaluateRequirement(req(check), ctx({ events }));
    expect(r.status).toBe("pass"); // 1/20 = 5% ≤ 5%
    expect(r.evidence).toContain("5.0%");
    const over = [...events, ev({ reasonCode: "UNKNOWN_TOOL" })];
    expect(evaluateRequirement(req(check), ctx({ events: over })).status).toBe("gap"); // 2/21 ≈ 9.5%
  });

  it("empty window is insufficient_evidence", () => {
    expect(evaluateRequirement(req(check), ctx({ events: [] })).status).toBe(
      "insufficient_evidence",
    );
  });

  it("renders the threshold without float noise (0.29 → 29%)", () => {
    const noisy: RequirementCheck = {
      kind: "trail_ratio",
      windowDays: 30,
      match: { reasonCode: "UNKNOWN_TOOL" },
      maxRatio: 0.29,
    };
    const r = evaluateRequirement(req(noisy), ctx({ events: [ev({})] }));
    expect(r.evidence).toContain("≤ 29%");
    expect(r.evidence).not.toContain("28.99");
    expect(r.evidence).not.toContain("29.0000");
  });

  it("events with unparseable ts are outside every window", () => {
    const r = evaluateRequirement(req(check), ctx({ events: [ev({ ts: "not a date" })] }));
    expect(r.status).toBe("insufficient_evidence");
  });
});

describe("trailWindow bounds", () => {
  const active: RequirementCheck = { kind: "trail_min", windowDays: 30, match: {}, min: 1 };
  // NOW is 2026-09-18T12:00:00.000Z → sinceMs is 2026-08-19T12:00:00.000Z.

  it("includes events at exactly sinceMs and exactly now (inclusive bounds)", () => {
    const atSince = ev({ ts: "2026-08-19T12:00:00.000Z" });
    const atNow = ev({ ts: "2026-09-18T12:00:00.000Z" });
    expect(evaluateRequirement(req(active), ctx({ events: [atSince] })).status).toBe("pass");
    expect(evaluateRequirement(req(active), ctx({ events: [atNow] })).status).toBe("pass");
  });

  it("excludes events just outside both bounds", () => {
    const before = ev({ ts: "2026-08-19T11:59:59.999Z" });
    const after = ev({ ts: "2026-09-18T12:00:00.001Z" });
    expect(evaluateRequirement(req(active), ctx({ events: [before] })).status).toBe(
      "insufficient_evidence",
    );
    expect(evaluateRequirement(req(active), ctx({ events: [after] })).status).toBe(
      "insufficient_evidence",
    );
  });

  it("accepts non-UTC offset ts inside the window", () => {
    // 2026-09-18T13:00:00+02:00 == 2026-09-18T11:00:00Z, inside the window.
    const offset = ev({ ts: "2026-09-18T13:00:00.000+02:00" });
    expect(evaluateRequirement(req(active), ctx({ events: [offset] })).status).toBe("pass");
  });
});

describe("evidence hygiene", () => {
  it("every evaluator evidence string is a single line", () => {
    const ratioCheck: RequirementCheck = {
      kind: "trail_ratio",
      windowDays: 30,
      match: { reasonCode: "UNKNOWN_TOOL" },
      maxRatio: 0.05,
    };
    const results = [
      // trail_zero: pass, gap, insufficient_evidence
      evaluateRequirement(
        req({ kind: "trail_zero", windowDays: 30, match: { verdict: "DENY" } }),
        ctx({ events: [ev({})] }),
      ),
      evaluateRequirement(
        req({ kind: "trail_zero", windowDays: 30, match: { verdict: "DENY" } }),
        ctx({ events: [ev({ verdict: "DENY" })] }),
      ),
      evaluateRequirement(
        req({ kind: "trail_zero", windowDays: 30, match: {} }),
        ctx({ events: [] }),
      ),
      // trail_min: pass, gap
      evaluateRequirement(
        req({ kind: "trail_min", windowDays: 30, match: {}, min: 1 }),
        ctx({ events: [ev({})] }),
      ),
      evaluateRequirement(
        req({ kind: "trail_min", windowDays: 30, match: { verdict: "DENY" }, min: 2 }),
        ctx({ events: [ev({})] }),
      ),
      // trail_ratio: pass, gap, insufficient_evidence
      evaluateRequirement(req(ratioCheck), ctx({ events: [ev({})] })),
      evaluateRequirement(
        req(ratioCheck),
        ctx({ events: [ev({ reasonCode: "UNKNOWN_TOOL" })] }),
      ),
      evaluateRequirement(req(ratioCheck), ctx({ events: [] })),
      // unimplemented kind fall-through
      evaluateRequirement(req({ kind: "orr_overall", max: "amber" }), ctx({})),
    ];
    for (const r of results) {
      expect(r.evidence).not.toMatch(/\n/);
    }
  });
});
