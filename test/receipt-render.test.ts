import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aggregateEvents,
  buildReceiptModel,
  buildWindowReceiptModel,
  loadReceiptModel,
  renderReceiptHtml,
  renderReceiptMarkdown,
  type ReceiptModel,
} from "../src/receipt/render-receipt.js";
import type { WiredHostRow } from "../src/receipt/enrich.js";
import { SHOWBACK_DISCLAIMER } from "../src/showback/cost-per-task.js";
import { appendTrail, type TrailEvent } from "../src/trail.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-render-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function ev(partial: Partial<TrailEvent> & Pick<TrailEvent, "ts" | "sessionId">): TrailEvent {
  return {
    toolId: "org.sample.safe.read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...partial,
  };
}

const NOW = Date.parse("2026-09-14T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("aggregateEvents", () => {
  it("counts modes, planes, reasons, and products", () => {
    const agg = aggregateEvents([
      ev({ ts: iso(0), sessionId: "a", mode: "observe", host: "ide", product: "cursor" }),
      ev({ ts: iso(1), sessionId: "a", mode: "hold", host: "runtime", product: "claude" }),
      ev({
        ts: iso(2),
        sessionId: "b",
        mode: "offline",
        product: "cursor",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
    ]);
    expect(agg.modes).toEqual({ observe: 1, hold: 1, offline: 1 });
    expect(agg.planes).toEqual({ ide: 1, runtime: 1 });
    expect(agg.reasons).toEqual([
      { label: "ALLOW", count: 2 },
      { label: "NEVER_EVENT", count: 1 },
    ]);
    expect(agg.products).toEqual([
      { label: "Cursor", count: 2 },
      { label: "Claude Code", count: 1 },
    ]);
  });

  it("aggregates sessions with never > deny > hold precedence and recency order", () => {
    const agg = aggregateEvents([
      ev({ ts: iso(100), sessionId: "s-hold", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD_IT" }),
      ev({ ts: iso(200), sessionId: "s-mix", verdict: "REQUIRE_APPROVE", reasonCode: "HOLD_IT" }),
      ev({ ts: iso(300), sessionId: "s-mix", verdict: "DENY", reasonCode: "NOPE" }),
      ev({ ts: iso(400), sessionId: "s-never", verdict: "ALLOW", reasonCode: "ALLOW" }),
      ev({
        ts: iso(500),
        sessionId: "s-never",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
    ]);
    const byId = new Map(agg.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("s-hold")?.worst).toBe("hold");
    expect(byId.get("s-mix")?.worst).toBe("deny");
    expect(byId.get("s-never")?.worst).toBe("never");
    expect(byId.get("s-mix")?.events).toBe(2);
    expect(byId.get("s-mix")?.deny).toBe(1);
    expect(byId.get("s-mix")?.hold).toBe(1);
    expect(byId.get("s-never")?.never).toBe(1);
    // Most recent session first.
    expect(agg.sessions[0]?.sessionId).toBe("s-hold");
    expect(agg.sessions[0]?.lastTs).toBe(iso(100));
  });

  it("caps sessions and reasons at 8", () => {
    const events: TrailEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(ev({ ts: iso(i * 1000), sessionId: `s${i}` }));
    }
    for (let i = 0; i < 10; i++) {
      events.push(ev({ ts: iso(20000 + i), sessionId: "sx", reasonCode: `R${i}` }));
    }
    const agg = aggregateEvents(events);
    expect(agg.sessions).toHaveLength(8);
    expect(agg.sessions[0]?.sessionId).toBe("s0");
    expect(agg.reasons).toHaveLength(8);
    // ALLOW (10 events) outranks every R<n> (1 each); ties break alphabetically.
    expect(agg.reasons[0]).toEqual({ label: "ALLOW", count: 10 });
    expect(agg.reasons[1]?.label).toBe("R0");
    expect(agg.reasons.at(-1)?.label).toBe("R6"); // ALLOW + R0..R6 = 8 cap
  });

  it("handles an empty feed", () => {
    const agg = aggregateEvents([]);
    expect(agg.modes).toEqual({ observe: 0, hold: 0, offline: 0 });
    expect(agg.sessions).toEqual([]);
    expect(agg.reasons).toEqual([]);
    expect(agg.products).toEqual([]);
  });
});

const ORR_REPORT = {
  rubric_version: "0",
  generated_at: "2026-09-14T00:00:00.000Z",
  target: { name: "demo-target", path: ".", kind: "path" },
  overall: "amber",
  disposition: "conditional",
  primary_failure_mode: "secret handling",
  most_urgent_fix: "rotate leaked keys",
  scorecards: [
    { category: "security_platform", name: "a", result: "pass", hardness: "hard" },
    { category: "engineering_craft", name: "c", result: "fail", hardness: "soft" },
    { category: "engineering_craft", name: "d", result: "partial", hardness: "soft" },
  ],
};

function writeFullFixture(): void {
  write(
    ".kya/config.json",
    JSON.stringify({
      agentId: "agt-1",
      agentName: "refund-bot",
      host: "ide",
      baseUrl: "http://127.0.0.1:8090",
    }),
  );
  write(
    ".kya/sandboxes.json",
    JSON.stringify([
      {
        sandboxId: "sbx-0123456789abcdef",
        backend: "firecracker",
        createdAt: iso(3600_000),
        status: "running",
      },
    ]),
  );
  write("orr-report/report.json", JSON.stringify(ORR_REPORT));
  write(
    ".kya/usage.json",
    JSON.stringify([{ agentId: "refund-bot", runId: "run-1", tokensIn: 1000, tokensOut: 200 }]),
  );
  appendTrail(dir, ev({ ts: iso(60_000), sessionId: "demo", product: "cursor", host: "ide" }));
}

describe("loadReceiptModel", () => {
  it("carries all enrichment sections from a fixture dir", () => {
    writeFullFixture();
    const model = loadReceiptModel({ cwd: dir, days: 3 });
    expect(model.identity).toEqual({
      agentId: "agt-1",
      agentName: "refund-bot",
      host: "ide",
      baseUrl: "http://127.0.0.1:8090",
    });
    expect(model.sandboxes?.sandboxes).toHaveLength(1);
    expect(model.orr?.overall).toBe("amber");
    expect(model.showback?.totalTokensIn).toBe(1000);
    expect(Array.isArray(model.wiredHosts)).toBe(true);
    expect(model.spend).toEqual({ tokens: 1200, usdEstimate: undefined });
    expect(model.events).toHaveLength(1);
  });

  it("leaves sections undefined when state files are absent", () => {
    appendTrail(dir, ev({ ts: iso(60_000), sessionId: "demo" }));
    const model = loadReceiptModel({ cwd: dir, days: 3 });
    expect(model.identity).toBeUndefined();
    expect(model.orr).toBeUndefined();
    expect(model.showback).toBeUndefined();
    expect(model.spend).toBeUndefined();
    expect(model.sandboxes?.sandboxes).toEqual([]);
    expect(model.events).toHaveLength(1);
  });

  it("never reads the receipt-server token into the report", () => {
    writeFullFixture();
    write(
      ".kya/receipt-server.json",
      JSON.stringify({ token: "kya-test-token-zzz-0011223344" }),
    );
    const model = loadReceiptModel({ cwd: dir, days: 3 });
    const html = renderReceiptHtml(model);
    const md = renderReceiptMarkdown(model);
    expect(html).not.toContain("kya-test-token-zzz-0011223344");
    expect(md).not.toContain("kya-test-token-zzz-0011223344");
    expect(JSON.stringify(model)).not.toContain("kya-test-token-zzz-0011223344");
  });
});

function richModel(): ReceiptModel {
  const wiredHosts: WiredHostRow[] = [
    {
      id: "cursor",
      label: "Cursor (IDE + Agent CLI)",
      wired: "global",
      reload: {
        id: "cursor",
        reload: "auto",
        detail: "watches mcp.json",
        processNames: ["cursor"],
      },
      running: true,
      recipeOnly: undefined,
    },
    {
      id: "cline",
      label: "Cline",
      wired: "none",
      reload: undefined,
      running: false,
      recipeOnly: "docs/hosts/cline.md",
    },
    {
      id: "codex",
      label: "Codex",
      wired: "none",
      reload: undefined,
      running: false,
      recipeOnly: undefined,
    },
  ];
  return buildWindowReceiptModel(
    [
      ev({
        ts: iso(60_000),
        sessionId: "demo",
        product: "cursor",
        host: "ide",
        mode: "observe",
        verdict: "REQUIRE_APPROVE",
        reasonCode: "HIGH_STAKES_WRITE",
      }),
      ev({
        ts: iso(120_000),
        sessionId: "demo",
        product: "claude",
        host: "runtime",
        mode: "hold",
        verdict: "DENY",
        reasonCode: "NEVER_EVENT",
        neverEvent: true,
      }),
    ],
    3,
    {
      identity: {
        agentId: "agt-1",
        agentName: "refund-bot",
        host: "ide",
        baseUrl: "http://127.0.0.1:8090",
      },
      sandboxes: {
        backend: "firecracker",
        sandboxes: [
          {
            sandboxId: "sbx-0123456789abcdef",
            backend: "firecracker",
            createdAt: iso(3600_000),
            status: "running",
          },
        ],
      },
      wiredHosts,
      orr: {
        overall: "amber",
        disposition: "conditional",
        primaryFailureMode: "secret handling",
        mostUrgentFix: "rotate leaked keys",
        generatedAt: "2026-09-14T00:00:00.000Z",
        targetName: "demo-target",
        scorecards: { pass: 1, fail: 1, partial: 1, notEvaluated: 0 },
      },
      showback: {
        billingMeter: false,
        disclaimer: SHOWBACK_DISCLAIMER,
        totalTokensIn: 1000,
        totalTokensOut: 200,
        estimatedUsd: 0.0123,
        perRun: [
          {
            runId: "run-1",
            parentAgentId: "refund-bot",
            tokensIn: 1000,
            tokensOut: 200,
            estimatedUsd: 0.0123,
            steps: 2,
            subagentIds: [],
          },
        ],
        perAgent: [],
      },
    },
  );
}

describe("renderReceiptHtml sections", () => {
  it("renders no enrichment sections on an empty model", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    for (const label of [
      "Sessions",
      "Reasons",
      "Products",
      "Wired hosts",
      "Sandboxes",
      "ORR",
      "Showback",
    ]) {
      expect(html).not.toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain('class="identity"');
    expect(html).not.toContain("Mode:");
    expect(html).not.toContain("class=\"modeb\"");
    expect(html).not.toContain("<table");
  });

  it("renders every section when the data is present", () => {
    const html = renderReceiptHtml(richModel());
    expect(html).toContain('aria-label="Sessions"');
    expect(html).toContain('aria-label="Reasons"');
    expect(html).toContain('aria-label="Products"');
    expect(html).toContain('aria-label="Wired hosts"');
    expect(html).toContain('aria-label="Sandboxes"');
    expect(html).toContain('aria-label="ORR"');
    expect(html).toContain('aria-label="Showback"');
    // Identity line: name/id · host · baseUrl, as inert text (no link).
    expect(html).toContain("refund-bot/agt-1 · ide · http://127.0.0.1:8090");
    expect(html).not.toContain("<a "); // no anchors — loader output is never linked
    // Mode chips are distinct from the Hold verdict chip.
    expect(html).toContain("Mode: observe");
    expect(html).toContain("Mode: hold");
    expect(html).toContain(">IDE<");
    expect(html).toContain(">Runtime<");
    // Products row (>= 2 distinct products).
    expect(html).toContain(">Cursor<");
    expect(html).toContain(">Claude Code<");
    // Sessions: worst-verdict dot + count.
    expect(html).toContain('class="wdot never"');
    expect(html).toContain("2 events");
    // Reasons chips.
    expect(html).toContain("HIGH_STAKES_WRITE");
    // Wired hosts: wired row, manual-setup recipe row, muted unwired row.
    expect(html).toContain("Cursor (IDE + Agent CLI) — wired (global) · auto · running");
    expect(html).toContain("manual setup");
    expect(html).toContain("Codex — not wired");
    expect(html).not.toContain("mcp.json"); // status words only, no config detail
    // Sandboxes table.
    expect(html).toContain("sbx-0123456789abcdef".slice(0, 19));
    expect(html).toContain("Configured backend");
    // ORR pill class + disposition + counts.
    expect(html).toContain('class="pill orr-amber"');
    expect(html).toContain("conditional");
    expect(html).toContain("1 pass · 1 fail · 1 partial");
    // Showback + disclaimer.
    expect(html).toContain("1000 tokens in · 200 tokens out · ~$0.01");
    expect(html).toContain("run-1");
    expect(html).toContain("2 steps");
    expect(html).toContain(SHOWBACK_DISCLAIMER);
  });

  it("renders a per-event mode badge with a tooltip", () => {
    const html = renderReceiptHtml(richModel());
    expect(html).toContain('class="modeb" title="observe mode">O<');
    expect(html).toContain('class="modeb" title="hold mode">H<');
    const offline = renderReceiptHtml(
      buildWindowReceiptModel(
        [ev({ ts: iso(0), sessionId: "demo", mode: "offline" })],
        3,
      ),
    );
    expect(offline).toContain('class="modeb" title="offline mode">X<');
    expect(offline).not.toContain('class="modeb" title="offline mode">F<');
  });

  it("suppresses the products chip row with a single distinct product", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(
        [
          ev({ ts: iso(0), sessionId: "a", product: "cursor" }),
          ev({ ts: iso(1), sessionId: "b", product: "cursor" }),
        ],
        3,
      ),
    );
    expect(html).not.toContain('aria-label="Products"');
    expect(richModel().events.length).toBeGreaterThan(0);
    expect(renderReceiptHtml(richModel())).toContain('aria-label="Products"');
  });

  it("renders the sessions panel when a session ts is unparseable", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel(
        [ev({ ts: "not-a-<date>", sessionId: "badts" })],
        3,
      ),
    );
    expect(html).toContain('aria-label="Sessions"');
    expect(html).toContain("badts");
    // relativeTime falls back to the raw value, escaped.
    expect(html).toContain("not-a-&lt;date&gt;");
    expect(html).not.toContain("not-a-<date>");
  });

  it("escapes loader output (identity is untrusted)", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, {
        identity: { agentName: "<script>alert(1)</script>", host: "ide" },
      }),
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("assertNoSecrets tripwire still fires on planted secret-shaped data", () => {
    // Joined at runtime: the literal trips GitHub push protection on the OSS mirror.
    const secret = "sk" + "_live_4eC39HqLyjWDarjtT1zdp7dc";
    const model = buildWindowReceiptModel(
      [ev({ ts: iso(0), sessionId: "demo", summary: `touched ${secret}` })],
      3,
    );
    expect(() => renderReceiptHtml(model)).toThrow(/secret/i);
    expect(() => renderReceiptMarkdown(model)).toThrow(/secret/i);
  });

  it("skips the sandboxes panel when empty and no backend configured", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, { sandboxes: { backend: undefined, sandboxes: [] } }),
    );
    expect(html).not.toContain('aria-label="Sandboxes"');
  });

  it("shows 'USD n/a' when cost cannot be estimated", () => {
    const model = buildWindowReceiptModel([], 3, {
      showback: {
        billingMeter: false,
        disclaimer: SHOWBACK_DISCLAIMER,
        totalTokensIn: 5,
        totalTokensOut: 1,
        estimatedUsd: null,
        perRun: [],
        perAgent: [],
      },
    });
    expect(renderReceiptHtml(model)).toContain("USD n/a");
    expect(renderReceiptMarkdown(model)).toContain("USD n/a");
  });
});

describe("renderReceiptMarkdown sections", () => {
  it("includes the new sections as ## blocks", () => {
    const md = renderReceiptMarkdown(richModel());
    expect(md).toContain("refund-bot/agt-1 · ide · http://127.0.0.1:8090");
    expect(md).toContain("## Products");
    expect(md).toContain("## Sessions");
    expect(md).toContain("## Reasons");
    expect(md).toContain("## Wired hosts");
    expect(md).toContain("Cursor (IDE + Agent CLI) — wired (global) · auto · running");
    expect(md).toContain("## Sandboxes");
    expect(md).toContain("## Operational readiness");
    expect(md).toContain("overall: amber · disposition: conditional");
    expect(md).toContain("## Showback (observe only)");
    expect(md).toContain(SHOWBACK_DISCLAIMER);
  });

  it("omits enrichment sections on an empty model", () => {
    const md = renderReceiptMarkdown(buildWindowReceiptModel([], 3));
    expect(md).not.toContain("## Sessions");
    expect(md).not.toContain("## Reasons");
    expect(md).not.toContain("## Wired hosts");
    expect(md).not.toContain("## Sandboxes");
    expect(md).not.toContain("## Operational readiness");
    expect(md).not.toContain("## Showback");
  });
});

describe("Projects rollup", () => {
  it("counts projects sorted desc by count then label", () => {
    const agg = aggregateEvents([
      ev({ ts: iso(0), sessionId: "a", project: "beta" }),
      ev({ ts: iso(1), sessionId: "a", project: "alpha" }),
      ev({ ts: iso(2), sessionId: "a" }),
      ev({ ts: iso(3), sessionId: "b", project: "beta" }),
    ]);
    expect(agg.projects).toEqual([
      { label: "beta", count: 2 },
      { label: "alpha", count: 1 },
    ]);
  });

  it("renders a Projects panel when two or more distinct projects exist", () => {
    const events = [
      ev({ ts: iso(0), sessionId: "s", project: "alpha", toolId: "A" }),
      ev({ ts: iso(1), sessionId: "s", project: "beta", toolId: "B" }),
    ];
    const model = buildReceiptModel("s", events, {});
    const html = renderReceiptHtml(model);
    expect(html).toContain("Projects");
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    const md = renderReceiptMarkdown(model);
    expect(md).toContain("## Projects");
  });

  it("omits the Projects panel for a single project", () => {
    const model = buildReceiptModel(
      "s",
      [
        ev({ ts: iso(0), sessionId: "s", project: "alpha" }),
        ev({ ts: iso(1), sessionId: "s", project: "alpha" }),
      ],
      {},
    );
    expect(renderReceiptHtml(model)).not.toContain("Projects");
    expect(renderReceiptMarkdown(model)).not.toContain("## Projects");
  });

  it("shows the project in feed meta even for a single project", () => {
    const model = buildReceiptModel(
      "s",
      [ev({ ts: iso(0), sessionId: "s", project: "alpha" })],
      {},
    );
    const html = renderReceiptHtml(model);
    expect(html).toContain('<span class="project">alpha</span>');
  });

  it("escapes attacker-controlled project strings in the report", () => {
    const xss = `<img src=x onerror=alert(1)>`;
    const events = [
      ev({ ts: iso(0), sessionId: "s", project: xss, toolId: "A" }),
      ev({ ts: iso(1), sessionId: "s", project: "beta", toolId: "B" }),
    ];
    const html = renderReceiptHtml(buildReceiptModel("s", events, {}));
    expect(html).not.toContain(xss);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("pins the localeCompare tie-break: equal counts sort label-ascending", () => {
    const agg = aggregateEvents([
      ev({ ts: iso(0), sessionId: "a", project: "beta" }),
      ev({ ts: iso(1), sessionId: "a", project: "alpha" }),
    ]);
    expect(agg.projects).toEqual([
      { label: "alpha", count: 1 },
      { label: "beta", count: 1 },
    ]);
  });

  it("caps the projects rollup at 8", () => {
    const events: TrailEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(ev({ ts: iso(i), sessionId: "s", project: `p${i}` }));
    }
    expect(aggregateEvents(events).projects).toHaveLength(8);
  });
});
