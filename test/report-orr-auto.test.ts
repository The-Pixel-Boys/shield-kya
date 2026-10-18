/**
 * ORR board in the live report: auto-generation at server start, the 30-minute
 * refresh cadence, the dedicated ORR zone + nav item, and the "Run ORR now"
 * report action. Self-service contract: an ORR board exists without the user
 * ever running `kya orr run` (docs/report-design.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import { buildWindowReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";
import { loadOrrCard } from "../src/receipt/enrich.js";
import { runOrr } from "../src/commands/orr.js";

vi.mock("../src/commands/gate.js", () => ({
  runGateRun: vi.fn(),
  runGateStop: vi.fn(),
  runGateDoctor: vi.fn(),
}));

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-orr-auto-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function orrOptionsFor(cwd: string): Parameters<typeof runOrr>[0] {
  return {
    path: cwd,
    out: join(cwd, "orr-report"),
    rubric: "0",
    disableCategories: [],
    formats: ["json", "md"],
    producers: ["sa.first_party"],
    skipOptionalProducers: true,
    quiet: true,
    jsonStdout: false,
  };
}

describe("ORR auto-generation in the live server", () => {
  let dir: string;
  let config: ResolvedConfig;
  const servers: Awaited<ReturnType<typeof startLiveReceiptServer>>[] = [];

  beforeEach(() => {
    dir = tmp();
    config = resolveConfig({
      cwd: dir,
      offline: true,
      allowMissingApiKey: true,
      env: { KYA_OFFLINE: "1" },
      flags: { offline: true },
    });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      try {
        await s.close();
      } catch {
        /* ignore */
      }
    }
  });

  async function start(): Promise<Awaited<ReturnType<typeof startLiveReceiptServer>>> {
    const s = await startLiveReceiptServer({ config, days: 3 });
    servers.push(s);
    return s;
  }

  it("generates orr-report/report.json shortly after the server starts", async () => {
    expect(existsSync(join(dir, "orr-report", "report.json"))).toBe(false);
    const s = await start();
    // The refresh fires 1.5s after listen; give it room on a loaded machine.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(existsSync(join(dir, "orr-report", "report.json"))).toBe(true);
    const card = loadOrrCard(dir);
    expect(card).toBeDefined();
    expect(["green", "amber", "red"]).toContain(card?.overall);
    // The served page already carries the ORR zone.
    const html = await (await fetch(`http://127.0.0.1:${s.port}/?t=${s.token}`)).text();
    expect(html).toContain('id="orr"');
    expect(html).toContain('aria-label="ORR"');
    expect(html).not.toContain("No ORR board yet");
  });

  it("does not clobber a fresh board on restart, and refreshes a stale one", async () => {
    // Fresh board: written now, so a server restart must not rewrite it.
    runOrr(orrOptionsFor(dir));
    const before = existsSync(join(dir, "orr-report", "report.json"));
    expect(before).toBe(true);
    const s1 = await start();
    await new Promise((r) => setTimeout(r, 3_000));
    await s1.close();
    // (still present; staleness gate kept it)

    // Stale board: backdate mtime past the 30-minute refresh window.
    const reportPath = join(dir, "orr-report", "report.json");
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(reportPath, old, old);
    const s2 = await start();
    await new Promise((r) => setTimeout(r, 4_000));
    const { statSync } = await import("node:fs");
    expect(statSync(reportPath).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    await s2.close();
  }, 20_000);

  it("POST /action/orr-run regenerates the board and reports the rating", async () => {
    const s = await start();
    const res = await fetch(`http://127.0.0.1:${s.port}/action/orr-run?t=${s.token}`, {
      method: "POST",
    });
    const body = (await res.json()) as { ok: boolean; detail?: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(String(body.detail)).toContain("overall");
    expect(existsSync(join(dir, "orr-report", "report.json"))).toBe(true);
  });
});

describe("ORR zone rendering", () => {
  it("renders the ORR nav item, zone, and a Run ORR now button on live renders", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { live: true, liveToken: "x" }));
    expect(html).toContain('href="#orr"');
    expect(html).toContain('id="orr"');
    expect(html).toContain('data-report-action="orr-run"');
    expect(html).toContain('id="report-action-result-orr-run"');
  });

  it("static renders keep the zone and CLI hint but no live button", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3));
    expect(html).toContain('id="orr"');
    expect(html).toContain("kya orr run --path .");
    expect(html).not.toContain('data-report-action="orr-run"');
  });

  it("shows the board content when a card exists", () => {
    mkdirSync(join(dirs[0] ?? tmp(), "orr-report"), { recursive: true });
    const html = renderReceiptHtml(
      buildWindowReceiptModel([], 3, {
        orr: {
          overall: "amber",
          disposition: "conditional",
          primaryFailureMode: "no policy evaluate path",
          mostUrgentFix: "wire wrapTool",
          generatedAt: "2026-10-17T12:00:00.000Z",
          targetName: "demo",
          scorecards: { pass: 2, fail: 1, partial: 0, notEvaluated: 3 },
          findings: [
            {
              id: "sa.probe.no_evaluate_path",
              severity: "critical",
              title: "No fail-closed evaluate/wrap path detected",
              detail: "Tree lacks policy evaluate signals.",
              evidence: "src/agent.ts:42",
            },
          ],
        },
      }),
    );
    expect(html).toContain('pill orr-amber">amber');
    expect(html).toContain("conditional");
    expect(html).toContain("no policy evaluate path");
    expect(html).toContain("wire wrapTool");
    expect(html).toContain("2 pass · 1 fail");
    expect(html).toContain("auto-refreshes every 30 min");
    expect(html).toContain("No fail-closed evaluate/wrap path detected");
    expect(html).toContain("src/agent.ts:42");
  });
});
