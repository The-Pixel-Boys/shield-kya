/**
 * Report interop sections: Import (trail-derived), Investigations
 * (persisted last-run summary), plus the render-level contract that all four
 * interop sections are absent on a fresh install and present with data.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateImports,
  buildWindowReceiptModel,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../src/receipt/render-receipt.js";
import { runInvestigate } from "../src/commands/investigate.js";
import {
  investigateLastRunPath,
  loadInvestigateLastRun,
} from "../src/investigate/last-run.js";
import { appendTrail, type TrailEvent } from "../src/trail.js";
import type { NotifyLogSummary } from "../src/notify/log.js";
import type { OtelStats } from "../src/otel/stats.js";

const home = () => mkdtempSync(join(tmpdir(), "kya-interop-home-"));
const cwdOf = () => mkdtempSync(join(tmpdir(), "kya-interop-proj-"));

const imp = (over: Partial<TrailEvent> = {}): TrailEvent => ({
  ts: "2026-10-09T12:00:00.000Z",
  sessionId: "sess-foreign",
  host: "import",
  toolId: "llm.call",
  verdict: "ALLOW",
  reasonCode: "IMPORTED",
  mode: "observe",
  ...over,
});

const wrap = (over: Partial<TrailEvent> = {}): TrailEvent => ({
  ts: "2026-10-09T12:00:00.000Z",
  sessionId: "s1",
  host: "ide",
  toolId: "Bash",
  verdict: "ALLOW",
  reasonCode: "ALLOW",
  mode: "observe",
  ...over,
});

describe("aggregateImports", () => {
  it("is undefined when the trail has no import events", () => {
    expect(aggregateImports([])).toBeUndefined();
    expect(aggregateImports([wrap()])).toBeUndefined();
  });

  it("counts per format via importFormat, errors, and last event ts", () => {
    const card = aggregateImports([
      imp({ importFormat: "langsmith", ts: "2026-10-08T10:00:00.000Z" }),
      imp({ importFormat: "langsmith", ts: "2026-10-09T10:00:00.000Z" }),
      imp({ importFormat: "langfuse", reasonCode: "IMPORTED_ERROR", verdict: "DENY" }),
      wrap(),
    ]);
    expect(card).toBeDefined();
    expect(card?.total).toBe(3);
    expect(card?.errors).toBe(1);
    expect(card?.lastTs).toBe("2026-10-09T12:00:00.000Z");
    expect(card?.formats).toEqual([
      { format: "langsmith", imported: 2, errors: 0 },
      { format: "langfuse", imported: 0, errors: 1 },
    ]);
  });

  it("falls back to the legacy import-<format>- session prefix, then other", () => {
    const card = aggregateImports([
      imp({ sessionId: "import-phoenix-2026-10-01" }),
      imp({ sessionId: "import-otel-2026-10-02" }),
      imp({ sessionId: "sess-no-format" }),
    ]);
    expect(card?.formats.map((f) => f.format).sort()).toEqual(["otel", "other", "phoenix"]);
  });

  it("ignores host=import events without import reason codes", () => {
    expect(aggregateImports([imp({ reasonCode: "ALLOW" })])).toBeUndefined();
  });
});

describe("Import hero card", () => {
  it("renders per-format counts and errors", () => {
    const events = [
      imp({ importFormat: "langsmith" }),
      imp({ importFormat: "langsmith" }),
      imp({ importFormat: "otel", reasonCode: "IMPORTED_ERROR", verdict: "DENY" }),
    ];
    const model = buildWindowReceiptModel(events, 3, { imports: aggregateImports(events) });
    const html = renderReceiptHtml(model);
    expect(html).toContain('aria-label="Import"');
    expect(html).toContain("langsmith");
    expect(html).toContain("otel");
    const md = renderReceiptMarkdown(model);
    expect(md).toContain("## Import");
    expect(md).toContain("langsmith × 2");
  });

  it("escapes attacker-controlled format labels", () => {
    const events = [imp({ sessionId: "x" })];
    const card = aggregateImports(events);
    const forged = {
      ...card!,
      formats: [{ format: "<img src=x onerror=alert(1)>", imported: 1, errors: 0 }],
    };
    const html = renderReceiptHtml(buildWindowReceiptModel(events, 3, { imports: forged }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("investigate last-run summary", () => {
  const seedDenySpike = (cwd: string, env: NodeJS.ProcessEnv): void => {
    const base = Date.now();
    for (let i = 0; i < 4; i++) {
      appendTrail(cwd, {
        ts: new Date(base + i * 60_000).toISOString(),
        sessionId: "s-spike",
        host: "ide",
        toolId: "Bash",
        verdict: "DENY",
        reasonCode: "SHELL_EXEC",
        mode: "hold",
      }, env);
    }
  };

  it("kya investigate persists investigate-last.json with the detector rollup", async () => {
    const env = { KYA_HOME: home() };
    const cwd = cwdOf();
    seedDenySpike(cwd, env);
    const out: string[] = [];
    const code = await runInvestigate(
      { json: false },
      { log: (s: string) => out.push(s) },
      cwd,
      env,
    );
    expect(code).toBe(0);
    const summary = loadInvestigateLastRun(env);
    expect(summary).toBeDefined();
    expect(summary?.ranAt).toBeTruthy();
    expect(summary?.windowDays).toBeGreaterThanOrEqual(1);
    expect(summary?.incidents).toBeGreaterThan(0);
    const spike = summary?.findings.find((f) => f.detectorId === "deny-spike");
    expect(spike).toMatchObject({ severity: "medium", count: 1 });
    expect(spike?.title).toBeTruthy();
    expect(summary?.briefSnippet).toContain("Fix brief");
    // On disk it is plain JSON in the global .kya dir.
    const raw = JSON.parse(readFileSync(investigateLastRunPath(env), "utf8")) as {
      ranAt: string;
    };
    expect(raw.ranAt).toBe(summary?.ranAt);
  });

  it("renders the Investigations hero card from the summary", async () => {
    const env = { KYA_HOME: home() };
    const cwd = cwdOf();
    seedDenySpike(cwd, env);
    const out: string[] = [];
    await runInvestigate({ json: false }, { log: (s: string) => out.push(s) }, cwd, env);
    const summary = loadInvestigateLastRun(env);
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { investigate: summary }));
    expect(html).toContain('aria-label="Investigations"');
    expect(html).toContain("deny-spike");
    expect(html).toContain("Top fix brief");
    const md = renderReceiptMarkdown(buildWindowReceiptModel([], 3, { investigate: summary }));
    expect(md).toContain("## Investigations");
    expect(md).toContain("deny-spike");
  });

  it("renders a clean run as zero findings", () => {
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, {
        investigate: {
          ranAt: new Date().toISOString(),
          windowDays: 1,
          findings: [],
          incidents: 0,
        },
      }),
    );
    expect(html).toContain('aria-label="Investigations"');
    expect(html).toContain("No findings");
  });

  it("tolerates missing and corrupt summary files", () => {
    const env = { KYA_HOME: home() };
    expect(loadInvestigateLastRun(env)).toBeUndefined();
    mkdirSync(join(env.KYA_HOME!, ".kya"), { recursive: true });
    writeFileSync(investigateLastRunPath(env), "not json {{{", "utf8");
    expect(loadInvestigateLastRun(env)).toBeUndefined();
    writeFileSync(investigateLastRunPath(env), JSON.stringify({ findings: "junk" }), "utf8");
    expect(loadInvestigateLastRun(env)).toBeUndefined();
  });
});

describe("render-level interop contract", () => {
  it("fresh install renders none of the four interop sections", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(html).not.toContain('aria-label="Import"');
    expect(html).not.toContain('aria-label="Investigations"');
    expect(html).not.toContain('aria-label="Alerts"');
    expect(html).not.toContain('aria-label="OTel export"');
    const md = renderReceiptMarkdown(buildWindowReceiptModel([], 3));
    expect(md).not.toContain("## Import");
    expect(md).not.toContain("## Investigations");
    expect(md).not.toContain("## Alerts");
    expect(md).not.toContain("## OTel export");
  });

  it("renders all four sections when their data exists", () => {
    const events = [imp({ importFormat: "langsmith" })];
    const alerts: NotifyLogSummary = {
      delivered: 3,
      failed: 1,
      lastTs: "2026-10-09T12:00:00.000Z",
      targets: [
        {
          target: "hooks.example.com",
          delivered: 3,
          failed: 1,
          lastTs: "2026-10-09T12:00:00.000Z",
          lastOk: false,
          lastDetail: "HTTP 500",
        },
      ],
    };
    const otel: OtelStats = {
      endpoint: "127.0.0.1:4318",
      spansSent: 5,
      spansFailed: 2,
      lastExportAt: "2026-10-09T12:00:00.000Z",
    };
    const model = buildWindowReceiptModel(events, 3, {
      imports: aggregateImports(events),
      investigate: {
        ranAt: "2026-10-09T12:00:00.000Z",
        windowDays: 3,
        findings: [{ detectorId: "deny-spike", severity: "medium", title: "DENY spike on a gated tool", count: 2 }],
        incidents: 1,
        briefSnippet: "# Fix brief: DENY spike",
      },
      alerts,
      otel,
    });
    const html = renderReceiptHtml(model);
    expect(html).toContain('aria-label="Import"');
    expect(html).toContain('aria-label="Investigations"');
    expect(html).toContain('aria-label="Alerts"');
    expect(html).toContain("hooks.example.com");
    expect(html).toContain('aria-label="OTel export"');
    expect(html).toContain("127.0.0.1:4318");
    const md = renderReceiptMarkdown(model);
    expect(md).toContain("## Import");
    expect(md).toContain("## Investigations");
    expect(md).toContain("## Alerts");
    expect(md).toContain("## OTel export");
  });
});
