/**
 * Report empty-state actions: the live-server POST /action/* helpers, tested
 * directly (validation branches, no server) plus the happy paths that only
 * touch local files.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runReportDiscoverAction,
  runReportImportAction,
  runReportInvestigateAction,
  runReportNotifyTestAction,
  runReportOrrAction,
  runReportOtelTestAction,
} from "../src/receipt/live-server.js";
import {
  investigateLastRunPath,
  loadInvestigateLastRun,
} from "../src/investigate/last-run.js";
import { readTrail } from "../src/trail.js";

const home = () => mkdtempSync(join(tmpdir(), "kya-action-home-"));
const cwdOf = () => mkdtempSync(join(tmpdir(), "kya-action-proj-"));

describe("runReportImportAction", () => {
  it("rejects an unknown source", async () => {
    const res = await runReportImportAction({ from: "datadog", file: "/tmp/x.json" }, cwdOf(), {});
    expect(res.status).toBe(400);
    expect(res.body["ok"]).toBe(false);
    expect(String(res.body["error"])).toContain("invalid source");
  });

  it("rejects a missing file for non-agt sources", async () => {
    const res = await runReportImportAction({ from: "langsmith" }, cwdOf(), {});
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("file path required");
  });

  it("rejects a relative file path", async () => {
    const res = await runReportImportAction({ from: "otel", file: "traces.json" }, cwdOf(), {});
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("absolute path");
  });

  it("rejects a nonexistent absolute file", async () => {
    const res = await runReportImportAction(
      { from: "otel", file: "/tmp/kya-no-such-file-9f3a.json" },
      cwdOf(),
      {},
    );
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("file not found");
  });

  it("rejects a directory as the file", async () => {
    const res = await runReportImportAction({ from: "otel", file: cwdOf() }, cwdOf(), {});
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toContain("not a regular file");
  });

  it("imports a valid langsmith export into the trail", async () => {
    const cwd = cwdOf();
    const env = { KYA_HOME: home() };
    const file = join(cwd, "ls.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          name: "ls_tool",
          run_type: "tool",
          inputs: { query: "refunds" },
          start_time: "2026-09-15T10:00:00.000Z",
          end_time: "2026-09-15T10:00:00.300Z",
          session_name: "e2e-ls",
        },
      ]),
      "utf8",
    );
    const res = await runReportImportAction({ from: "langsmith", file }, cwd, env);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, imported: 1 });
    const trail = readTrail(cwd, env);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.host).toBe("import");
    expect(trail[0]?.importFormat).toBe("langsmith");
  });

  it("surfaces per-record parse errors without failing the request", async () => {
    const cwd = cwdOf();
    const env = { KYA_HOME: home() };
    const file = join(cwd, "bad.jsonl");
    writeFileSync(file, "not json at all\n", "utf8");
    const res = await runReportImportAction({ from: "langfuse", file }, cwd, env);
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["imported"]).toBe(0);
    expect((res.body["errors"] as string[]).length).toBeGreaterThan(0);
  });
});

describe("runReportInvestigateAction", () => {
  it("runs detectors on an empty trail and persists the summary", async () => {
    const cwd = cwdOf();
    const env = { KYA_HOME: home() };
    const res = await runReportInvestigateAction(cwd, env);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, findings: 0, incidents: 0 });
    expect(existsSync(investigateLastRunPath(env))).toBe(true);
    expect(loadInvestigateLastRun(env)?.ranAt).toBeTruthy();
  });
});

describe("runReportNotifyTestAction", () => {
  it("delivers to an ephemeral loopback receiver when no webhooks are configured", async () => {
    const homeDir = home();
    const res = await runReportNotifyTestAction(cwdOf(), { KYA_HOME: homeDir });
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["loopback"]).toBe(true);
    expect(String(res.body["detail"])).toContain("temporary loopback receiver");
    expect(String(res.body["detail"])).toContain("notify.webhooks");
  });
});

describe("runReportOtelTestAction", () => {
  it("exports to an ephemeral loopback collector when no endpoint is configured", async () => {
    const res = await runReportOtelTestAction(cwdOf(), { KYA_HOME: home() });
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["loopback"]).toBe(true);
    expect(String(res.body["detail"])).toContain("temporary loopback collector");
    expect(String(res.body["detail"])).toContain("otlpExport.endpoint");
  });
});

describe("runReportOrrAction", () => {
  it("generates orr-report/report.json on demand", async () => {
    const cwd = cwdOf();
    const res = await runReportOrrAction(cwd);
    expect(res.status).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(String(res.body["detail"])).toContain("overall");
    expect(existsSync(join(cwd, "orr-report", "report.json"))).toBe(true);
  });
});

describe("runReportDiscoverAction", () => {
  it("scans and persists a discovery snapshot", async () => {
    const cwd = cwdOf();
    const env = { KYA_HOME: home() };
    const res = await runReportDiscoverAction(cwd, env);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(typeof (res.body as { total: unknown }).total).toBe("number");
  });
});
