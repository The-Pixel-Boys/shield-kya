import { describe, expect, it } from "vitest";
import type { TrailEvent } from "../src/trail.js";
import {
  investigateTrail,
  renderFixBrief,
  renderInvestigateReport,
} from "../src/investigate/index.js";
import { luhnValid, runDetectors } from "../src/investigate/detectors.js";
import { groupIncidents } from "../src/investigate/incidents.js";

const BASE = "2026-10-09T10:00:00.000Z";

function ev(over: Partial<TrailEvent> = {}, offsetMs = 0): TrailEvent {
  return {
    ts: new Date(Date.parse(BASE) + offsetMs).toISOString(),
    sessionId: "s1",
    toolId: "tool.a",
    verdict: "ALLOW",
    reasonCode: "OK",
    mode: "observe",
    ...over,
  };
}

const MIN = 60_000;

describe("pii-in-summary detector", () => {
  it("flags an email in summary as critical (positive)", () => {
    const events = [ev({ summary: "wrote config for user@example.com" })];
    const findings = runDetectors(events).filter((f) => f.detectorId === "pii-in-summary");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].eventIdx).toEqual([0]);
    const samples = findings[0].evidence.samples as string[];
    expect(samples[0]).not.toContain("user@example.com");
    expect(samples[0]).toContain("***");
  });

  it("flags a Luhn-valid card number in diffPreview (positive)", () => {
    const events = [ev({ diffPreview: "+ card: 4111 1111 1111 1111" })];
    const findings = runDetectors(events).filter((f) => f.detectorId === "pii-in-summary");
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.kinds).toContain("credit-card");
  });

  it("flags a high-entropy token in targetPath (positive)", () => {
    const token = "a9f3c17d2e8b4056a1c9f3d7e2b80654a9f3c17d2e8b4056";
    const events = [ev({ targetPath: `/tmp/${token}/out.txt` })];
    const findings = runDetectors(events).filter((f) => f.detectorId === "pii-in-summary");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
  });

  it("ignores clean fields and non-Luhn digit runs (negative)", () => {
    const events = [
      ev({ summary: "edited src/index.ts, 1234 5678 9012 3456 lines scanned" }),
    ];
    expect(luhnValid("1234567890123456")).toBe(false);
    const findings = runDetectors(events).filter((f) => f.detectorId === "pii-in-summary");
    expect(findings).toHaveLength(0);
  });
});

describe("deny-spike detector", () => {
  it("flags >3 DENY for one tool within 10 minutes (positive)", () => {
    const events = [0, 2 * MIN, 4 * MIN, 6 * MIN].map((o) =>
      ev({ verdict: "DENY", reasonCode: "POLICY_DENY" }, o),
    );
    const findings = runDetectors(events).filter((f) => f.detectorId === "deny-spike");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
    expect(findings[0].eventIdx).toHaveLength(4);
  });

  it("ignores 3 DENY in the window and spread-out denies (negative)", () => {
    const three = [0, 2 * MIN, 4 * MIN].map((o) =>
      ev({ verdict: "DENY", reasonCode: "POLICY_DENY" }, o),
    );
    expect(runDetectors(three).filter((f) => f.detectorId === "deny-spike")).toHaveLength(0);
    const spread = [0, 11 * MIN, 22 * MIN, 33 * MIN].map((o) =>
      ev({ verdict: "DENY", reasonCode: "POLICY_DENY" }, o),
    );
    expect(runDetectors(spread).filter((f) => f.detectorId === "deny-spike")).toHaveLength(0);
  });
});

describe("approval-loop detector", () => {
  it("flags >=3 consecutive REQUIRE_APPROVE on one session+tool (positive)", () => {
    const events = [0, MIN, 2 * MIN].map((o) =>
      ev({ verdict: "REQUIRE_APPROVE", reasonCode: "HOLD" }, o),
    );
    const findings = runDetectors(events).filter((f) => f.detectorId === "approval-loop");
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.sessionId).toBe("s1");
    expect(findings[0].evidence.count).toBe(3);
  });

  it("ignores a run broken by another verdict (negative)", () => {
    const events = [
      ev({ verdict: "REQUIRE_APPROVE" }, 0),
      ev({ verdict: "REQUIRE_APPROVE" }, MIN),
      ev({ verdict: "ALLOW" }, 2 * MIN),
      ev({ verdict: "REQUIRE_APPROVE" }, 3 * MIN),
    ];
    expect(runDetectors(events).filter((f) => f.detectorId === "approval-loop")).toHaveLength(0);
  });
});

describe("never-repeat detector", () => {
  it("flags a NEVER_EVENT tool attempted more than once (positive)", () => {
    const events = [
      ev({ verdict: "DENY", reasonCode: "NEVER_EVENT", neverEvent: true }, 0),
      ev({ verdict: "DENY", reasonCode: "NEVER_EVENT", neverEvent: true }, 5 * MIN),
    ];
    const findings = runDetectors(events).filter((f) => f.detectorId === "never-repeat");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].eventIdx).toEqual([0, 1]);
  });

  it("ignores a single never attempt (negative)", () => {
    const events = [ev({ verdict: "DENY", reasonCode: "NEVER_EVENT", neverEvent: true })];
    expect(runDetectors(events).filter((f) => f.detectorId === "never-repeat")).toHaveLength(0);
  });
});

describe("unknown-tool-hold detector", () => {
  it("flags UNKNOWN_TOOL while mode is hold (positive)", () => {
    const events = [ev({ reasonCode: "UNKNOWN_TOOL", mode: "hold" })];
    const findings = runDetectors(events).filter((f) => f.detectorId === "unknown-tool-hold");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("low");
  });

  it("ignores UNKNOWN_TOOL in observe mode (negative)", () => {
    const events = [ev({ reasonCode: "UNKNOWN_TOOL", mode: "observe" })];
    expect(runDetectors(events).filter((f) => f.detectorId === "unknown-tool-hold")).toHaveLength(0);
  });
});

describe("slow-calls detector", () => {
  it("flags p95 above 5000ms with >=5 samples (positive)", () => {
    const events = [100, 200, 300, 400, 6000].map((ms, i) =>
      ev({ latencyMs: ms }, i * MIN),
    );
    const findings = runDetectors(events).filter((f) => f.detectorId === "slow-calls");
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.p95Ms).toBe(6000);
  });

  it("ignores fewer than 5 samples and fast tools (negative)", () => {
    const few = [100, 200, 300, 6000].map((ms, i) => ev({ latencyMs: ms }, i * MIN));
    expect(runDetectors(few).filter((f) => f.detectorId === "slow-calls")).toHaveLength(0);
    const fast = [100, 200, 300, 400, 500].map((ms, i) => ev({ latencyMs: ms }, i * MIN));
    expect(runDetectors(fast).filter((f) => f.detectorId === "slow-calls")).toHaveLength(0);
  });
});

describe("groupIncidents", () => {
  it("merges same detector+key, sorts by severity then recency", () => {
    // Two deny spikes on the same tool, hours apart: one incident, 2 findings.
    const spike1 = [0, MIN, 2 * MIN, 3 * MIN].map((o) =>
      ev({ verdict: "DENY", reasonCode: "POLICY_DENY" }, o),
    );
    const spike2 = [120 * MIN, 121 * MIN, 122 * MIN, 123 * MIN].map((o) =>
      ev({ verdict: "DENY", reasonCode: "POLICY_DENY" }, o),
    );
    // PII event is older than the spike but outranks it on severity.
    const pii = ev({ summary: "leak user@example.com" }, -60 * MIN);
    const events = [...spike1, ...spike2, pii];
    const findings = runDetectors(events);
    const incidents = groupIncidents(findings, events);
    expect(incidents).toHaveLength(2);
    expect(incidents[0].severity).toBe("critical");
    expect(incidents[1].severity).toBe("medium");
    expect(incidents[1].findingCount).toBe(2);
    expect(incidents[1].firstTs < incidents[1].lastTs).toBe(true);
    expect(incidents[0].id).toMatch(/^pii-in-summary-/);
  });

  it("breaks severity ties by recency", () => {
    const oldSlow = [100, 200, 300, 400, 6000].map((ms, i) =>
      ev({ toolId: "tool.old", latencyMs: ms }, i * MIN),
    );
    const newSlow = [100, 200, 300, 400, 7000].map((ms, i) =>
      ev({ toolId: "tool.new", latencyMs: ms }, (60 + i) * MIN),
    );
    const incidents = groupIncidents(runDetectors([...oldSlow, ...newSlow]), [
      ...oldSlow,
      ...newSlow,
    ]);
    expect(incidents).toHaveLength(2);
    expect(incidents[0].title).toContain("tool.new");
    expect(incidents[1].title).toContain("tool.old");
  });
});

describe("fix briefs and report", () => {
  it("brief markdown contains title, suggested change, and a real verify command", () => {
    const events = [0, MIN, 2 * MIN, 3 * MIN].map((o) =>
      ev({ verdict: "DENY", reasonCode: "POLICY_DENY" }, o),
    );
    const result = investigateTrail(events);
    expect(result.incidents).toHaveLength(1);
    const brief = result.briefs.get(result.incidents[0].id);
    expect(brief).toBeDefined();
    expect(brief).toContain("# Fix brief:");
    expect(brief).toContain(result.incidents[0].title);
    expect(brief).toContain("## What happened");
    expect(brief).toContain("## Why it matters");
    expect(brief).toContain("## Suggested change");
    expect(brief).toContain("never-list");
    expect(brief).toContain("## Verify");
    expect(brief).toContain("`kya certify`");
    expect(renderFixBrief(result.incidents[0])).toBe(brief);
  });

  it("report lists counts by severity and top incidents", () => {
    const events = [0, MIN, 2 * MIN, 3 * MIN].map((o) =>
      ev({ verdict: "DENY", reasonCode: "POLICY_DENY" }, o),
    );
    const report = renderInvestigateReport(investigateTrail(events));
    expect(report).toContain("Findings: 1 (medium: 1)");
    expect(report).toContain("Incidents: 1");
    expect(report).toContain("[medium]");
  });

  it("empty trail yields zero findings, zero incidents, no briefs", () => {
    const result = investigateTrail([]);
    expect(result.findings).toHaveLength(0);
    expect(result.incidents).toHaveLength(0);
    expect(result.briefs.size).toBe(0);
    expect(renderInvestigateReport(result)).toContain("No findings");
  });
});
