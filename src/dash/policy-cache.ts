/**
 * Cache live policy playground samples so each dash paint does not
 * spam the production PEP with two evaluate calls.
 */

import type { KyaHttpClient, PolicyEvaluateResponse } from "../client.js";

export const POLICY_SAMPLE_TTL_MS = 30_000;

export class PolicySampleCache {
  private cached: PolicyEvaluateResponse[] | undefined;
  private fetchedAt = 0;

  constructor(private readonly ttlMs: number = POLICY_SAMPLE_TTL_MS) {}

  async get(
    client: KyaHttpClient,
    force: boolean,
  ): Promise<{ evals: PolicyEvaluateResponse[]; fromCache: boolean }> {
    const fresh =
      !force &&
      this.cached !== undefined &&
      Date.now() - this.fetchedAt < this.ttlMs;
    if (fresh && this.cached) {
      return { evals: this.cached, fromCache: true };
    }
    const deny = await client.evaluatePolicy({
      toolId: "org.sample.never.event",
      irreversible: true,
    });
    const ra = await client.evaluatePolicy({
      toolId: "org.sample.data.write",
      irreversible: true,
    });
    this.cached = [deny, ra];
    this.fetchedAt = Date.now();
    return { evals: this.cached, fromCache: false };
  }

  invalidate(): void {
    this.cached = undefined;
    this.fetchedAt = 0;
  }
}
