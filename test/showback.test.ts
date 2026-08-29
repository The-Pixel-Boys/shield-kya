import { describe, expect, it } from "vitest";
import { estimateRequestUsd, lookupRate } from "../src/showback/rates.js";
import {
  buildShowback,
  parseUsageRecords,
  SHOWBACK_DISCLAIMER,
} from "../src/showback/cost-per-task.js";

describe("published rates", () => {
  it("looks up known models case-insensitively", () => {
    expect(lookupRate("GPT-4o")?.inputPer1M).toBe(2.5);
    expect(lookupRate("unknown-model")).toBeNull();
  });

  it("estimates gpt-4o request USD (vector shared with Java)", () => {
    // 1M in + 1M out at 2.5 / 10 = 12.5
    expect(estimateRequestUsd("gpt-4o", 1_000_000, 1_000_000)).toBe(12.5);
    // 1000 in, 500 out: (1000*2.5 + 500*10) / 1e6 = 0.0075
    expect(estimateRequestUsd("gpt-4o", 1000, 500)).toBe(0.0075);
  });

  it("returns null USD for unknown models", () => {
    expect(estimateRequestUsd("mystery", 100, 100)).toBeNull();
  });
});

describe("buildShowback", () => {
  it("rolls nested subagents into parent run cost-per-task", () => {
    const report = buildShowback([
      {
        agentId: "refund-bot",
        runId: "run-1",
        model: "gpt-4o-mini",
        tokensIn: 1000,
        tokensOut: 200,
        environment: "prod",
        route: "main",
      },
      {
        agentId: "sub-research",
        parentRunId: "run-1",
        model: "gpt-4o-mini",
        tokensIn: 500,
        tokensOut: 100,
        environment: "prod",
        route: "sub",
      },
    ]);

    expect(report.billingMeter).toBe(false);
    expect(report.disclaimer).toBe(SHOWBACK_DISCLAIMER);
    expect(report.perRun).toHaveLength(1);
    expect(report.perRun[0].runId).toBe("run-1");
    expect(report.perRun[0].parentAgentId).toBe("refund-bot");
    expect(report.perRun[0].subagentIds).toEqual(["sub-research"]);
    expect(report.perRun[0].tokensIn).toBe(1500);
    expect(report.perRun[0].tokensOut).toBe(300);
    // gpt-4o-mini: in 0.15, out 0.6 per 1M
    // (1500*0.15 + 300*0.6) / 1e6 = 0.000405
    expect(report.perRun[0].estimatedUsd).toBe(0.000405);
    expect(report.perAgent.map((a) => a.agentId).sort()).toEqual([
      "refund-bot",
      "sub-research",
    ]);
  });

  it("applies retries only when present", () => {
    const one = buildShowback([
      {
        agentId: "a",
        runId: "r",
        model: "gpt-4o-mini",
        tokensIn: 1000,
        tokensOut: 0,
      },
    ]);
    const withRetry = buildShowback([
      {
        agentId: "a",
        runId: "r",
        model: "gpt-4o-mini",
        tokensIn: 1000,
        tokensOut: 0,
        retries: 1,
      },
    ]);
    expect(withRetry.perRun[0].tokensIn).toBe(one.perRun[0].tokensIn * 2);
    expect(withRetry.perRun[0].estimatedUsd).toBe(
      (one.perRun[0].estimatedUsd ?? 0) * 2,
    );
  });

  it("nulls USD when any step has an unknown model", () => {
    const report = buildShowback([
      {
        agentId: "a",
        runId: "r",
        model: "gpt-4o-mini",
        tokensIn: 100,
        tokensOut: 0,
      },
      {
        agentId: "b",
        parentRunId: "r",
        model: "custom-finetune",
        tokensIn: 100,
        tokensOut: 0,
      },
    ]);
    expect(report.perRun[0].estimatedUsd).toBeNull();
    expect(report.estimatedUsd).toBeNull();
    expect(report.totalTokensIn).toBe(200);
  });

  it("parses usage JSON with snake_case aliases", () => {
    const rows = parseUsageRecords([
      {
        agent_id: "bot",
        parent_run_id: "run-9",
        tokens_in: 10,
        tokens_out: 2,
        model: "gpt-4o-mini",
      },
    ]);
    expect(rows[0].agentId).toBe("bot");
    expect(rows[0].parentRunId).toBe("run-9");
    expect(rows[0].tokensIn).toBe(10);
  });
});
