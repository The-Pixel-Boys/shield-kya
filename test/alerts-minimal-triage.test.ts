/**
 * kya-alerts: when the triage input builder returns nothing (its secret check failed), the alert
 * carries title, severity, detector ids and counts of findings only, in every template.
 */
import { describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ kind: "null" as "null" | "throw" }));
vi.mock("../src/alerts/triage-input.js", () => ({
  buildTriageInput: () => {
    if (mode.kind === "throw") throw new Error("triage input unsafe");
    return null;
  },
}));

import { buildIncidentAlert } from "../src/alerts/incident-alert.js";
import { investigateTrail } from "../src/investigate/index.js";
import { NOTIFY_TEMPLATES, serializeIncidentPayload } from "../src/notify/index.js";
import type { TrailEvent } from "../src/trail.js";

const ev = (m: number): TrailEvent => ({
  ts: new Date(Date.UTC(2026, 10, 11, 9, m)).toISOString(),
  sessionId: "SESSION-SECRET-777",
  toolId: "mcp__postgres__drop_table",
  verdict: "DENY",
  reasonCode: "NEVER_EVENT",
  mode: "offline",
  neverEvent: true,
  summary: "some summary text",
});

describe.each(["null", "throw"] as const)("kya-alerts with no triage input (builder %s)", (kind) => {
  const events = [ev(1), ev(2)];
  const result = investigateTrail(events);
  const inc = result.incidents[0]!;
  mode.kind = kind;
  const alert = buildIncidentAlert(inc, events, result.briefs.get(inc.id));

  it("keeps title, severity, detector ids and the finding count; drops counts, tools and summaries", () => {
    expect(alert).toMatchObject({ severity: "high", detectorIds: ["never-repeat"], findingCount: 1, tools: [], summaries: [] });
    expect(alert.counts).toBeUndefined();
    expect(alert.title).toContain("Never-list tool attempted repeatedly");
  });

  it.each(NOTIFY_TEMPLATES)("template %s still renders and leaks nothing", (template) => {
    const body = serializeIncidentPayload(template, alert);
    expect(body).toContain("Never-list tool attempted repeatedly");
    expect(body).not.toContain("SESSION-SECRET-777");
    expect(body).not.toContain("some summary text");
    expect(body).not.toContain("drop_table");
  });
});
