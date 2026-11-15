/** The test receiver counts only requests under its own path token: the stray-request guard of the alert e2e tests. */
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { receiver } from "./support/alert-receiver.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("alert test receiver", () => {
  it("counts an incident under its token and keeps a stray one (same port, other path) out of the count", async () => {
    const r = await receiver(servers);
    const origin = new URL(r.url).origin;
    // a retrying flush child of another test that was given this port earlier
    expect((await post(`${origin}/inc`, { event: "incident.opened" })).status).toBe(200);
    expect(r.incidents()).toHaveLength(0);
    expect(r.hits).toHaveLength(0);
    expect(r.foreign).toHaveLength(1);
    // the child under test
    await post(`${r.url}/inc`, { event: "incident.opened" });
    await post(`${r.url}/all`, { kind: "kya.trail.verdict" });
    expect(r.incidents()).toHaveLength(1);
    expect(r.denies()).toHaveLength(1);
    // a resend of the same alert to the same URL is still counted
    await post(`${r.url}/inc`, { event: "incident.opened" });
    expect(r.incidents()).toHaveLength(2);
  });
});
