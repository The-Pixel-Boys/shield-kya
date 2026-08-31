import { describe, expect, it, vi } from "vitest";
import { PolicySampleCache } from "../src/dash/policy-cache.js";
import type { KyaHttpClient, PolicyEvaluateResponse } from "../src/client.js";

function fakeClient(calls: { n: number }): KyaHttpClient {
  return {
    evaluatePolicy: async (req) => {
      calls.n += 1;
      const res: PolicyEvaluateResponse = {
        verdict: req.toolId?.includes("never") ? "DENY" : "REQUIRE_APPROVE",
        reasonCode: "TEST",
        toolId: req.toolId,
      };
      return res;
    },
  } as unknown as KyaHttpClient;
}

describe("PolicySampleCache", () => {
  it("caches within TTL and refreshes on force", async () => {
    const calls = { n: 0 };
    const cache = new PolicySampleCache(60_000);
    const client = fakeClient(calls);
    const a = await cache.get(client, false);
    expect(a.fromCache).toBe(false);
    expect(calls.n).toBe(2);
    const b = await cache.get(client, false);
    expect(b.fromCache).toBe(true);
    expect(calls.n).toBe(2);
    const c = await cache.get(client, true);
    expect(c.fromCache).toBe(false);
    expect(calls.n).toBe(4);
  });
});
