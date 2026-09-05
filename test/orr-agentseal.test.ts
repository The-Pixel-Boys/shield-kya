import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { orrRunOptionsFromArgs, runOrr } from "../src/commands/orr.js";
import { parseArgs } from "../src/parse-args.js";
import { runCli, type CliIo } from "../src/cli.js";
import {
  AGENTSEAL_PRODUCER_ID,
  FORBIDDEN_AGENTSEAL_SPAWN_TOKENS,
  assertSafeAgentSealArgv,
  buildAgentSealArgv,
  ingestAgentSealReport,
  mapAgentSealFinding,
  readAgentSealJson,
  tryRunAgentSealCli,
  type AgentSealSpawnFn,
} from "../src/orr/agentseal.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "orr");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-orr-seal-"));
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

describe("harness.agentseal producer id", () => {
  it("is stable", () => {
    expect(AGENTSEAL_PRODUCER_ID).toBe("harness.agentseal");
  });

  it("forbids shield watcher, --fix, npx, and scan-mcp in spawn argv", () => {
    expect(FORBIDDEN_AGENTSEAL_SPAWN_TOKENS).toContain("shield");
    expect(FORBIDDEN_AGENTSEAL_SPAWN_TOKENS).toContain("--fix");
    expect(FORBIDDEN_AGENTSEAL_SPAWN_TOKENS).toContain("npx");
    expect(FORBIDDEN_AGENTSEAL_SPAWN_TOKENS).toContain("scan-mcp");
    expect(() => assertSafeAgentSealArgv(["shield"])).toThrow(/forbidden/);
    expect(() => assertSafeAgentSealArgv(["guard", "--fix"])).toThrow(/forbidden/);
  });
});

describe("buildAgentSealArgv", () => {
  it("spawns guard json only", () => {
    const { command, args } = buildAgentSealArgv("/tmp/proj");
    expect(command).toBe("agentseal");
    expect(args).toEqual(["guard", "--output", "json", "--path", "/tmp/proj"]);
    expect(args.join(" ")).not.toMatch(/shield|npx|scan-mcp|--fix/);
    assertSafeAgentSealArgv(args);
  });
});

describe("mapAgentSealFinding / ingest", () => {
  it("maps guard fixture findings and never allows", () => {
    const parsed = JSON.parse(
      readFileSync(join(FIXTURES, "agentseal-guard.json"), "utf8"),
    );
    const findings = ingestAgentSealReport(parsed);
    expect(findings[0]?.id).toBe("harness.agentseal.ingested");
    expect(findings[0]?.detail).toMatch(/never authorizes|Evidence only/i);
    expect(findings.some((f) => /poison|exfil/i.test(`${f.id} ${f.title}`))).toBe(true);
    expect(findings.every((f) => f.source_tool === AGENTSEAL_PRODUCER_ID)).toBe(true);
    expect(findings.every((f) => !/ALLOW/i.test(f.title))).toBe(true);
    const poison = findings.find((f) => f.id.includes("mcp-tool-poison"));
    expect(poison?.category).toBe("agent_control_plane");
    expect(poison?.severity).toBe("high");
  });

  it("maps SARIF results", () => {
    const parsed = JSON.parse(
      readFileSync(join(FIXTURES, "agentseal-sarif.json"), "utf8"),
    );
    const findings = ingestAgentSealReport(parsed);
    expect(findings.some((f) => f.id.includes("mcp.poisoning"))).toBe(true);
    const err = findings.find((f) => f.id.includes("mcp.poisoning"));
    expect(err?.severity).toBe("high");
    expect(err?.evidence).toContain("server.json");
  });

  it("returns null for empty raw", () => {
    expect(mapAgentSealFinding(null)).toBeNull();
    expect(mapAgentSealFinding({})).toBeNull();
  });
});

describe("readAgentSealJson", () => {
  it("missing file → info finding", () => {
    const findings = readAgentSealJson(join(tmp(), "nope.json"));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("harness.agentseal.missing");
  });

  it("unreadable → low finding", () => {
    const p = join(tmp(), "bad.json");
    writeFileSync(p, "{not-json");
    const findings = readAgentSealJson(p);
    expect(findings[0]?.id).toBe("harness.agentseal.unreadable");
  });

  it("reads fixture", () => {
    const findings = readAgentSealJson(join(FIXTURES, "agentseal-guard.json"));
    expect(findings.length).toBeGreaterThan(2);
  });
});

describe("tryRunAgentSealCli", () => {
  it("ENOENT → coverage gap", () => {
    const spawn: AgentSealSpawnFn = () => ({
      status: 1,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("not found"), { code: "ENOENT" }),
    });
    const result = tryRunAgentSealCli(tmp(), spawn);
    expect("gap" in result).toBe(true);
    if ("gap" in result) {
      expect(result.gap.adapter_id).toBe(AGENTSEAL_PRODUCER_ID);
      expect(result.gap.reason).toBe("binary_not_found");
    }
  });

  it("valid stdout JSON → findings", () => {
    const fixture = readFileSync(join(FIXTURES, "agentseal-guard.json"), "utf8");
    const { calls, spawn } = (() => {
      const calls: { command: string; args: readonly string[] }[] = [];
      const spawn: AgentSealSpawnFn = (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: fixture, stderr: "" };
      };
      return { calls, spawn };
    })();
    const result = tryRunAgentSealCli("/proj", spawn);
    expect("findings" in result).toBe(true);
    expect(calls[0]?.command).toBe("agentseal");
    expect(calls[0]?.args[0]).toBe("guard");
  });
});

describe("orr run + agentseal", () => {
  it("parses --agentseal-json and --producer harness.agentseal", () => {
    const parsed = parseArgs([
      "orr",
      "run",
      "--path",
      ".",
      "--producer",
      "harness.agentseal",
      "--agentseal-json",
      "./seal.json",
    ]);
    const opts = orrRunOptionsFromArgs(parsed);
    expect(opts.producers).toContain("harness.agentseal");
    expect(opts.agentsealJsonPath).toBe("./seal.json");
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
      producers: ["sa.first_party", AGENTSEAL_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      agentsealJsonPath: join(FIXTURES, "agentseal-guard.json"),
    });
    expect(result.report.findings.some((f) => f.id === "harness.agentseal.ingested")).toBe(
      true,
    );
    expect(result.report.scope.producers_requested).toContain(AGENTSEAL_PRODUCER_ID);
    expect(
      result.report.findings.every(
        (f) => f.source_tool !== AGENTSEAL_PRODUCER_ID || !/^ALLOW$/i.test(f.title),
      ),
    ).toBe(true);
  });

  it("CLI smoke: orr run --agentseal-json", async () => {
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
        AGENTSEAL_PRODUCER_ID,
        "--agentseal-json",
        join(FIXTURES, "agentseal-sarif.json"),
      ],
      io,
      {},
      root,
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.findings.some((f: { id: string }) => f.id.includes("agentseal"))).toBe(
      true,
    );
  });

  it("missing binary without json → coverage gap, not crash", () => {
    const root = wrapTree();
    const out = join(tmp(), "gap-out");
    const spawn: AgentSealSpawnFn = () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("missing"), { code: "ENOENT" }),
    });
    const result = runOrr({
      path: root,
      out,
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: [AGENTSEAL_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      agentsealSpawn: spawn,
    });
    expect(
      result.report.coverage_gaps.some((g) => g.adapter_id === AGENTSEAL_PRODUCER_ID),
    ).toBe(true);
  });
});
