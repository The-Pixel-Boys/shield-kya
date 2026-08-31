import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatOrrMarkdown,
  orrRunOptionsFromArgs,
  readScorecardEvidence,
  runOrr,
  runSaFirstPartyProbes,
} from "../src/commands/orr.js";
import { parseArgs } from "../src/parse-args.js";
import { UsageError } from "../src/errors.js";
import { runCli, type CliIo } from "../src/cli.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-orr-"));
  dirs.push(d);
  return d;
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

describe("orr run", () => {
  it("parses options", () => {
    const p = parseArgs([
      "orr",
      "run",
      "--path",
      "/tmp/agents",
      "--out",
      "/tmp/out",
      "--skip-optional-producers",
      "--fail-on",
      "no_go",
    ]);
    expect(p.command).toBe("orr");
    expect(p.positionals[0]).toBe("run");
    const opts = orrRunOptionsFromArgs(p);
    expect(opts.path).toBe("/tmp/agents");
    expect(opts.out).toBe("/tmp/out");
    expect(opts.skipOptionalProducers).toBe(true);
    expect(opts.failOn).toBe("no_go");
  });

  it("requires --path", () => {
    const p = parseArgs(["orr", "run"]);
    expect(() => orrRunOptionsFromArgs(p)).toThrow(UsageError);
  });

  it("emits report with control-plane findings for empty tree", () => {
    const root = tmp();
    const out = join(root, "out");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.js"), "console.log('hello')\n");

    const result = runOrr({
      path: root,
      out,
      rubric: "0",
      disableCategories: [],
      formats: ["json", "md"],
      producers: ["sa.first_party"],
      skipOptionalProducers: true,
      quiet: true,
      jsonStdout: false,
    });

    expect(result.report.rubric_version).toBe("0");
    expect(result.report.findings.length).toBeGreaterThan(0);
    expect(result.report.categories.some((c) => c.id === "agent_control_plane")).toBe(
      true,
    );
    expect(result.reportJsonPath).toBeDefined();
    expect(result.reportMdPath).toBeDefined();
    const md = formatOrrMarkdown(result.report);
    expect(md).toContain("ORR:");
    expect(md).toMatch(/[Ss]ole PEP/);
  });


  it("marks cost_budget_gates amber when in-loop ceilings are missing", () => {
    const root = tmp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.js"), "console.log('hello')\n");
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party"],
      skipOptionalProducers: true,
      quiet: true,
      jsonStdout: false,
    });
    const cost = result.report.categories.find((c) => c.id === "cost_budget_gates");
    expect(cost?.rating).toBe("amber");
    expect(
      result.report.scorecards.some(
        (s) => s.name === "in_loop_ceilings" && s.result === "partial",
      ),
    ).toBe(true);
    expect(
      result.report.findings.some((f) => f.id === "sa.probe.no_in_loop_ceilings"),
    ).toBe(true);
  });

  it("passes in_loop_ceilings when max_steps is present", () => {
    const root = tmp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "agent.ts"),
      "const max_steps = 12;\nexport function wrapTool() {}\nPolicyEngine\nREQUIRE_APPROVE\n",
    );
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party"],
      skipOptionalProducers: true,
      quiet: true,
      jsonStdout: false,
    });
    expect(
      result.report.findings.some((f) => f.id === "sa.probe.no_in_loop_ceilings"),
    ).toBe(false);
    expect(
      result.report.scorecards.some(
        (s) => s.name === "in_loop_ceilings" && s.result === "pass",
      ),
    ).toBe(true);
  });

  it("loads --usage into report.showback", () => {
    const root = tmp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.js"), "console.log(1)\n");
    const usage = join(root, "usage.json");
    writeFileSync(
      usage,
      JSON.stringify([
        {
          agentId: "bot",
          runId: "r1",
          model: "gpt-4o-mini",
          tokensIn: 1000,
          tokensOut: 0,
        },
      ]),
    );
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json", "md"],
      producers: ["sa.first_party"],
      skipOptionalProducers: true,
      quiet: true,
      jsonStdout: false,
      usagePath: usage,
    });
    expect(result.report.showback?.billingMeter).toBe(false);
    expect(result.report.showback?.totalTokensIn).toBe(1000);
    expect(formatOrrMarkdown(result.report)).toContain("Showback");
    expect(formatOrrMarkdown(result.report)).toContain("billingMeter");
  });

  it("skips default usage.json when it is a symlink", () => {
    const root = tmp();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".kya"), { recursive: true });
    writeFileSync(join(root, "src", "app.js"), "console.log(1)\n");
    const outside = join(tmpdir(), "kya-usage-link-target.json");
    writeFileSync(
      outside,
      JSON.stringify([{ agentId: "leaked", model: "gpt-4o-mini", tokensIn: 9, tokensOut: 0 }]),
    );
    symlinkSync(outside, join(root, ".kya", "usage.json"));
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party"],
      skipOptionalProducers: true,
      quiet: true,
      jsonStdout: false,
    });
    expect(result.report.showback).toBeUndefined();
  });

  it("rejects --usage outside --path", () => {
    const root = tmp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.js"), "console.log(1)\n");
    const outside = join(tmpdir(), "kya-usage-outside.json");
    writeFileSync(outside, "[]\n");
    expect(() =>
      runOrr({
        path: root,
        out: join(root, "out"),
        rubric: "0",
        disableCategories: [],
        formats: ["json"],
        producers: ["sa.first_party"],
        skipOptionalProducers: true,
        quiet: true,
        jsonStdout: false,
        usagePath: outside,
      }),
    ).toThrow(/inside --path/);
  });

  it("ingests --scorecard JSON as evidence only", () => {
    const root = tmp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.js"), "console.log('x')\n");
    const scorecard = join(root, "scorecard.json");
    writeFileSync(
      scorecard,
      JSON.stringify({
        score: 7.2,
        checks: [{ name: "Pinned-Dependencies", score: 8 }],
      }),
    );
    const ingested = readScorecardEvidence(scorecard);
    expect(ingested.some((f) => f.id === "sa.scorecard.ingested")).toBe(true);
    expect(ingested.every((f) => !/ALLOW/i.test(f.title))).toBe(true);

    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", "openssf.scorecard"],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      scorecardPath: scorecard,
    });
    expect(
      result.report.findings.some((f) => f.id === "sa.scorecard.ingested"),
    ).toBe(true);
    expect(
      result.report.coverage_gaps.some((g) => g.adapter_id === "openssf.scorecard"),
    ).toBe(false);
    expect(JSON.stringify(result.report)).not.toMatch(/"verdict":"ALLOW"/);
  });

  it("spawns scorecard CLI when producer requested without --scorecard file", () => {
    const root = tmp();
    writeFileSync(join(root, "README.md"), "# x\n");
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", "openssf.scorecard"],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      scorecardSpawn: () => ({
        status: 0,
        stdout: JSON.stringify({
          score: 6.5,
          checks: [{ name: "CI-Tests", score: 10 }],
        }),
        stderr: "",
      }),
    });
    expect(
      result.report.findings.some((f) => f.id === "sa.scorecard.ingested"),
    ).toBe(true);
    expect(
      result.report.findings.some((f) => f.id === "sa.scorecard.check.ci_tests"),
    ).toBe(true);
    expect(
      result.report.coverage_gaps.some((g) => g.adapter_id === "openssf.scorecard"),
    ).toBe(false);
    expect(JSON.stringify(result.report)).not.toMatch(/"verdict":"ALLOW"/);
  });

  it("records binary_not_found when scorecard CLI is missing", () => {
    const root = tmp();
    writeFileSync(join(root, "README.md"), "# x\n");
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", "openssf.scorecard"],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      scorecardSpawn: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn scorecard ENOENT"), { code: "ENOENT" }),
      }),
    });
    expect(
      result.report.coverage_gaps.some(
        (g) =>
          g.adapter_id === "openssf.scorecard" && g.reason === "binary_not_found",
      ),
    ).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("scores green-ish control plane when wrap/evaluate present", () => {
    const root = tmp();
    writeFileSync(
      join(root, "wrap.ts"),
      `
      export function wrapTool() {}
      export async function evaluatePolicy() {
        return { verdict: "REQUIRE_APPROVE", host: "ide" as const };
      }
      // PolicyEngine + dual plane KYA_HOST=runtime
      const AgentHost = "ide";
      const toolId = "org.sample.safe.read";
      // EventLog trail POLICY_ALLOW
      `,
    );
    const findings = runSaFirstPartyProbes(root);
    expect(findings.some((f) => f.id === "sa.probe.no_evaluate_path")).toBe(false);
  });

  it("cli orr run writes report", async () => {
    const root = tmp();
    writeFileSync(join(root, "x.md"), "# hi\n");
    const out = join(root, "orr-out");
    const { io, logs } = captureIo();
    const code = await runCli(
      [
        "orr",
        "run",
        "--path",
        root,
        "--out",
        out,
        "--skip-optional-producers",
        "--quiet",
        "--json-stdout",
      ],
      io,
      {},
      root,
    );
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("rubric_version");
  });

  it("exit 3 when --fail-on no_go and disposition no_go", () => {
    const root = tmp();
    writeFileSync(join(root, "empty.txt"), "x");
    const out = join(root, "o");
    const result = runOrr({
      path: root,
      out,
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party"],
      skipOptionalProducers: true,
      failOn: "no_go",
      quiet: true,
      jsonStdout: false,
    });
    // empty tree without evaluate → typically no_go
    if (result.report.disposition === "no_go") {
      expect(result.exitCode).toBe(3);
    } else {
      expect(result.exitCode).toBe(0);
    }
  });
});
