// test/report-actions-e2e.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";

/**
 * End-to-end action contract over real HTTP: boot the live report server,
 * fetch the rendered page with its loopback token, then exercise every
 * interactive path the page exposes:
 *
 *   - every [data-report-action] button maps to a live POST /action/*
 *     endpoint that accepts the page token (no 401) and answers JSON
 *   - every button has its result div wired in the HTML
 *   - the token contract holds: no token or a wrong token gets 401
 *
 * This is the guard for "clicked a button and nothing happened" bugs: it
 * fails if a button renders but its endpoint is missing, misnamed, or
 * rejects the page token.
 */

describe("live report actions e2e (real server, every page action)", () => {
  let dir: string;
  let config: ResolvedConfig;
  const servers: Awaited<ReturnType<typeof startLiveReceiptServer>>[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kya-actions-e2e-"));
    config = resolveConfig({
      cwd: dir,
      offline: true,
      allowMissingApiKey: true,
      env: { KYA_OFFLINE: "1" },
      flags: { offline: true },
    });
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      try {
        await s.close();
      } catch {
        /* ignore */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    const s = await startLiveReceiptServer({ config, days: 3 });
    servers.push(s);
    return s;
  }

  async function getPage(port: number, token: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/?t=${token}`);
    expect(res.status).toBe(200);
    return res.text();
  }

  function reportActions(html: string): string[] {
    return [...html.matchAll(/data-report-action="([a-z-]+)"/g)].map((m) => m[1]);
  }

  it("renders the full set of report actions", async () => {
    const s = await start();
    const html = await getPage(s.port, s.token);
    const actions = new Set(reportActions(html));
    for (const expected of [
      "orr-run",
      "discover",
      "investigate",
      "notify-test",
      "otel-test",
    ]) {
      expect(actions.has(expected), `page is missing action ${expected}`).toBe(true);
    }
  });

  it("every rendered [data-report-action] button has a wired result div and a working endpoint", async () => {
    const s = await start();
    const html = await getPage(s.port, s.token);
    const actions = [...new Set(reportActions(html))];
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(
        html,
        `button ${action} renders without its result div report-action-result-${action}`,
      ).toContain(`id="report-action-result-${action}"`);
      const res = await fetch(
        `http://127.0.0.1:${s.port}/action/${action}?t=${s.token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(
        res.status,
        `POST /action/${action} with the page token returned ${res.status}`,
      ).toBe(200);
      const body = (await res.json()) as { ok?: unknown };
      expect(
        typeof body.ok,
        `POST /action/${action} did not answer a JSON body with an ok field`,
      ).toBe("boolean");
    }
  });

  it("orr-run regenerates the board end to end", async () => {
    const s = await start();
    const res = await fetch(
      `http://127.0.0.1:${s.port}/action/orr-run?t=${s.token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; detail?: string };
    expect(body.ok).toBe(true);
    expect(String(body.detail)).toContain("overall");
  });

  it("enforces the token contract: missing and wrong tokens get 401", async () => {
    const s = await start();
    for (const qs of ["", "?t=wrong-token"]) {
      const res = await fetch(`http://127.0.0.1:${s.port}/action/orr-run${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status, `POST /action/orr-run${qs}`).toBe(401);
    }
  });

  it("serves the client script that attaches token-authed handlers", async () => {
    const s = await start();
    const html = await getPage(s.port, s.token);
    expect(html).toContain("data-live-token");
    expect(html).toContain("function post(path, body)");
    expect(html).toContain("encodeURIComponent(T)");
    expect(html).toContain("Session expired or unauthorized (401)");
  });
});
