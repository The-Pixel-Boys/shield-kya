import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { orrRunOptionsFromArgs, runOrr } from "../src/commands/orr.js";
import { parseArgs } from "../src/parse-args.js";
import { runCli, type CliIo } from "../src/cli.js";
import {
  GUARD_REPORT_PRODUCER_ID,
  ingestGuardReport,
  mapGuardReportFinding,
  readGuardReportJson,
} from "../src/orr/guard-report.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "orr");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-orr-guard-"));
  dirs.push(d);
  return d;
}

function wrapTree(): string {
  const root = tmp();
  writeFileSync(
    join(root, "wrap.ts"),
    `
    export function wrapTool() {}
    export async function evaluatePolicy() {
      return { verdict: "REQUIRE_APPROVE", host: "ide" as const };
    }
    const AgentHost = "ide";
    const KYA_HOST = "runtime";
    const toolId = "org.sample.safe.read";
    // EventLog trail POLICY_ALLOW
    `,
  );
  return root;
}

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    exit: () => {
      /* no-op */
    },
  };
  return { io, logs, errors };
}

describe("harness.guard_report producer id", () => {
  it("is stable and has no third-party product name", () => {
    expect(GUARD_REPORT_PRODUCER_ID).toBe("harness.guard_report");
    expect(GUARD_REPORT_PRODUCER_ID.toLowerCase()).not.toContain("agentseal");
  });
});

describe("mapGuardReportFinding / ingest", () => {
  it("maps guard fixture findings and never allows", () => {
    const parsed = JSON.parse(
      readFileSync(join(FIXTURES, "guard-report.json"), "utf8"),
    );
    const findings = ingestGuardReport(parsed);
    expect(findings[0]?.id).toBe("harness.guard_report.ingested");
    expect(findings[0]?.detail).toMatch(/never authorizes|Evidence only/i);
    expect(findings.some((f) => /poison|exfil/i.test(`${f.id} ${f.title}`))).toBe(
      true,
    );
    expect(findings.every((f) => f.source_tool === GUARD_REPORT_PRODUCER_ID)).toBe(
      true,
    );
    expect(findings.every((f) => !/ALLOW/i.test(f.title))).toBe(true);
    const poison = findings.find((f) => f.id.includes("mcp-tool-poison"));
    expect(poison?.category).toBe("agent_control_plane");
    expect(poison?.severity).toBe("high");
  });

  it("maps SARIF results", () => {
    const parsed = JSON.parse(
      readFileSync(join(FIXTURES, "guard-report-sarif.json"), "utf8"),
    );
    const findings = ingestGuardReport(parsed);
    expect(findings.some((f) => f.id.includes("mcp.poisoning"))).toBe(true);
    const err = findings.find((f) => f.id.includes("mcp.poisoning"));
    expect(err?.severity).toBe("high");
    expect(err?.evidence).toContain("server.json");
  });

  it("returns null for empty raw", () => {
    expect(mapGuardReportFinding(null)).toBeNull();
    expect(mapGuardReportFinding({})).toBeNull();
  });
});

describe("readGuardReportJson", () => {
  it("missing file → info finding", () => {
    const findings = readGuardReportJson(join(tmp(), "nope.json"));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("harness.guard_report.missing");
  });

  it("unreadable → low finding", () => {
    const p = join(tmp(), "bad.json");
    writeFileSync(p, "{not-json");
    const findings = readGuardReportJson(p);
    expect(findings[0]?.id).toBe("harness.guard_report.unreadable");
  });

  it("reads fixture", () => {
    const findings = readGuardReportJson(join(FIXTURES, "guard-report.json"));
    expect(findings.length).toBeGreaterThan(2);
  });
});

describe("orr run + guard-json", () => {
  it("parses --guard-json and --producer harness.guard_report", () => {
    const parsed = parseArgs([
      "orr",
      "run",
      "--path",
      ".",
      "--producer",
      "harness.guard_report",
      "--guard-json",
      "./guard.json",
    ]);
    const opts = orrRunOptionsFromArgs(parsed);
    expect(opts.producers).toContain("harness.guard_report");
    expect(opts.guardJsonPath).toBe("./guard.json");
    expect(JSON.stringify(opts).toLowerCase()).not.toContain("agentseal");
  });

  it("help omits guard-report flags and third-party scanner names", async () => {
    const { io, logs } = captureIo();
    await runCli(["help"], io);
    const blob = logs.join("\n").toLowerCase();
    expect(blob).not.toMatch(/agent.?seal/);
    expect(blob).not.toContain("guard-json");
    expect(blob).not.toContain("guard_report");
  });

  it("ingests fixture via runOrr", () => {
    const root = wrapTree();
    const out = join(tmp(), "out");
    const result = runOrr({
      path: root,
      out,
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", GUARD_REPORT_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      guardJsonPath: join(FIXTURES, "guard-report.json"),
    });
    expect(
      result.report.findings.some((f) => f.id === "harness.guard_report.ingested"),
    ).toBe(true);
    expect(result.report.scope.producers_requested).toContain(
      GUARD_REPORT_PRODUCER_ID,
    );
  });

  it("CLI smoke: orr run --guard-json", async () => {
    const root = wrapTree();
    const out = join(tmp(), "cli-out");
    mkdirSync(out, { recursive: true });
    const { io, errors } = captureIo();
    const code = await runCli(
      [
        "orr",
        "run",
        "--path",
        root,
        "--out",
        out,
        "--quiet",
        "--producer",
        GUARD_REPORT_PRODUCER_ID,
        "--guard-json",
        join(FIXTURES, "guard-report-sarif.json"),
      ],
      io,
      {},
      root,
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(
      report.findings.some((f: { id: string }) => f.id.includes("guard_report")),
    ).toBe(true);
    expect(JSON.stringify(report).toLowerCase()).not.toContain("agentseal");
  });

  it("producer without --guard-json → coverage gap, not crash", () => {
    const root = wrapTree();
    const out = join(tmp(), "gap-out");
    const result = runOrr({
      path: root,
      out,
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: [GUARD_REPORT_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
    });
    expect(
      result.report.coverage_gaps.some(
        (g) => g.adapter_id === GUARD_REPORT_PRODUCER_ID,
      ),
    ).toBe(true);
  });
});
