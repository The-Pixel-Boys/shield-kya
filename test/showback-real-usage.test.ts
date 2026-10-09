import { describe, expect, it } from "vitest";
import {
  STATIC_ESTIMATE_TOKENS_IN,
  STATIC_ESTIMATE_TOKENS_OUT,
  summarizeTrailUsage,
} from "../src/showback/trail-usage.js";
import type { TrailEvent } from "../src/trail.js";

function event(over: Partial<TrailEvent> = {}): TrailEvent {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    sessionId: "s1",
    toolId: "Bash",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...over,
  };
}

describe("summarizeTrailUsage", () => {
  it("empty trail yields zeros", () => {
    const s = summarizeTrailUsage([]);
    expect(s.events).toBe(0);
    expect(s.realUsageEvents).toBe(0);
    expect(s.tokensIn).toBe(0);
    expect(s.tokensOut).toBe(0);
  });

  it("events without real usage keep the static estimate", () => {
    const s = summarizeTrailUsage([event(), event()]);
    expect(s.realUsageEvents).toBe(0);
    expect(s.estimatedEvents).toBe(2);
    expect(s.tokensIn).toBe(2 * STATIC_ESTIMATE_TOKENS_IN);
    expect(s.tokensOut).toBe(2 * STATIC_ESTIMATE_TOKENS_OUT);
    expect(s.realTokensIn).toBe(0);
    expect(s.realTokensOut).toBe(0);
  });

  it("real tokensIn/tokensOut are preferred over the estimate", () => {
    const s = summarizeTrailUsage([
      event({ tokensIn: 10_000, tokensOut: 800 }),
      event(),
    ]);
    expect(s.realUsageEvents).toBe(1);
    expect(s.estimatedEvents).toBe(1);
    expect(s.realTokensIn).toBe(10_000);
    expect(s.realTokensOut).toBe(800);
    expect(s.tokensIn).toBe(10_000 + STATIC_ESTIMATE_TOKENS_IN);
    expect(s.tokensOut).toBe(800 + STATIC_ESTIMATE_TOKENS_OUT);
  });

  it("an event with only tokensIn still counts as real (tokensOut = 0)", () => {
    const s = summarizeTrailUsage([event({ tokensIn: 500 })]);
    expect(s.realUsageEvents).toBe(1);
    expect(s.estimatedEvents).toBe(0);
    expect(s.tokensIn).toBe(500);
    expect(s.tokensOut).toBe(0);
  });

  it("zero tokens reported by the host is real usage, not an estimate", () => {
    const s = summarizeTrailUsage([event({ tokensIn: 0, tokensOut: 0 })]);
    expect(s.realUsageEvents).toBe(1);
    expect(s.tokensIn).toBe(0);
    expect(s.tokensOut).toBe(0);
  });
});
