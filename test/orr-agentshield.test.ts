import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  orrRunOptionsFromArgs,
  runOrr,
  runSaFirstPartyProbes,
  type OrrFinding,
} from "../src/commands/orr.js";
import { parseArgs } from "../src/parse-args.js";
import { runCli, type CliIo } from "../src/cli.js";
import {
  AGENTSHIELD_PRODUCER_ID,
  FORBIDDEN_AGENTSHIELD_SPAWN_TOKENS,
  buildAgentShieldArgv,
  mapAgentShieldFinding,
  readAgentShieldJson,
  redactEvidence,
  tryRunAgentShieldCli,
  type AgentShieldSpawnFn,
} from "../src/orr/agentshield.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "orr");

/** Assembled at runtime so push protection does not treat fixtures as live Stripe keys. */
const FIXTURE_STRIPE_LIVE = ["sk", "_live_", "51AgentShieldFixtureSecret0001"].join("");
const FIXTURE_STRIPE_RK = ["rk", "_live_", "51AgentShieldFixtureSecret0001"].join("");
const FIXTURE_WHSEC = ["whsec_", "51AgentShieldFixtureSecret0001"].join("");
const FIXTURE_GHP = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
const FIXTURE_STRIPE_ELLIPSIS = ["sk", "_live_", "...0001"].join("");

function expandSecretPlaceholders(raw: string): string {
  return raw.replaceAll("__KYA_STRIPE_LIVE__", FIXTURE_STRIPE_LIVE);
}

function materializeSecretFixture(): string {
  const dir = tmp();
  const template = join(FIXTURES, "agentshield-secret" + ".json");
  const raw = expandSecretPlaceholders(readFileSync(template, "utf8"));
  const out = join(dir, "agentshield-secret.json");
  writeFileSync(out, raw);
  return out;
}
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-orr-as-"));
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

function emptyTree(): string {
  const root = tmp();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.js"), "console.log('hello')\n");
  return root;
}

function enoentSpawn(): AgentShieldSpawnFn {
  return () => ({
    status: 1,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("not found"), { code: "ENOENT" }),
  });
}

function recordingSpawn(impl: AgentShieldSpawnFn) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const spawn: AgentShieldSpawnFn = (command, args, options) => {
    calls.push({ command, args });
    return impl(command, args, options);
  };
  return { spawn, calls };
}

describe("redactEvidence", () => {
  it("strips live Stripe, restricted, webhook, GitHub, and PEM material", () => {
    const raw = [
      FIXTURE_STRIPE_LIVE,
      FIXTURE_STRIPE_RK,
      FIXTURE_WHSEC,
      FIXTURE_GHP,
      "Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKFAKE\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactEvidence(raw);
    expect(redacted).not.toMatch(/sk_live_51/);
    expect(redacted).not.toMatch(/rk_live_51/);
    expect(redacted).not.toMatch(/whsec_51/);
    expect(redacted).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
    expect(redacted).not.toMatch(/Bearer eyJ/);
    expect(redacted).not.toMatch(/MIIEowIBAAKFAKE/);
    expect(redacted).toMatch(/\[redacted\]/i);
  });

  it("strips AgentShield maskSecretValue and sk-ant / AKIA / npm_ forms", () => {
    const raw = [
      FIXTURE_STRIPE_ELLIPSIS,
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
      "AKIAIOSFODNN7EXAMPLE",
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n");
    const redacted = redactEvidence(raw);
    expect(redacted).not.toMatch(/sk_live_\.\.\.0001/);
    expect(redacted).not.toMatch(/sk-ant-api03-/);
    expect(redacted).not.toMatch(/AKIAIOSFODNN7/);
    expect(redacted).not.toMatch(/npm_abcdefgh/);
  });
});

describe("mapAgentShieldFinding", () => {
  it("maps a real secret to security_platform high with redacted evidence", () => {
    const report = JSON.parse(
      readFileSync(materializeSecretFixture(), "utf8"),
    ) as { findings: unknown[] };
    const mapped = mapAgentShieldFinding(report.findings[0]);
    expect(mapped).not.toBeNull();
    expect(mapped!.id).toBe("harness.agentshield.secrets-hardcoded-stripe-key");
    expect(mapped!.category).toBe("security_platform");
    expect(mapped!.severity).toBe("high");
    expect(mapped!.source_tool).toBe(AGENTSHIELD_PRODUCER_ID);
    expect(mapped!.evidence).not.toMatch(/sk_live_51/);
    expect(mapped!.detail).not.toMatch(/sk_live_51/);
  });

  it("does not treat AgentShield critical as a second PEP / critical ORR rating", () => {
    const mapped = mapAgentShieldFinding({
      id: "secrets-x",
      severity: "critical",
      category: "secrets",
      title: "key",
      description: FIXTURE_STRIPE_LIVE,
      evidence: FIXTURE_STRIPE_LIVE,
      runtimeConfidence: "active-runtime",
    });
    expect(mapped!.severity).toBe("high");
    expect(mapped!.severity).not.toBe("critical");
  });

  it("maps template-example MCP to info and does not drop the finding", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "agentshield-template-mcp.json"), "utf8"),
    ) as { findings: unknown[] };
    const mapped = mapAgentShieldFinding(report.findings[0]);
    expect(mapped!.severity).toBe("info");
    expect(mapped!.category).toBe("agent_control_plane");
    expect(mapped!.source_tool).toBe(AGENTSHIELD_PRODUCER_ID);
  });

  it("does not raise AgentShield info 'good practice' permissions to medium", () => {
    const mapped = mapAgentShieldFinding({
      id: "permissions-negated-good",
      severity: "info",
      category: "permissions",
      title: "Deny list blocks Bash(*)",
      description: "Good practice.",
      evidence: "deny: [\"Bash(*)\"]",
      runtimeConfidence: "active-runtime",
    });
    expect(mapped!.severity).toBe("info");
    expect(mapped!.category).toBe("agent_control_plane");
  });

  it("treats missing runtimeConfidence + AS info as info (not medium)", () => {
    const mapped = mapAgentShieldFinding({
      id: "mcp-missing-conf-info",
      severity: "info",
      category: "mcp",
      title: "MCP inventory note",
      description: "No runtimeConfidence field.",
      evidence: "server demo",
    });
    expect(mapped!.severity).toBe("info");
  });

  it("maps active-runtime permissions to agent_control_plane medium", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "agentshield-permissions-runtime.json"), "utf8"),
    ) as { findings: unknown[] };
    const mapped = mapAgentShieldFinding(report.findings[0]);
    expect(mapped!.category).toBe("agent_control_plane");
    expect(mapped!.severity).toBe("medium");
  });

  it("maps active-runtime hooks to engineering_craft low", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "agentshield-hooks-runtime.json"), "utf8"),
    ) as { findings: unknown[] };
    const mapped = mapAgentShieldFinding(report.findings[0]);
    expect(mapped!.category).toBe("engineering_craft");
    expect(mapped!.severity).toBe("low");
  });

  it("maps active-runtime misconfiguration to engineering_craft low", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "agentshield-hooks-runtime.json"), "utf8"),
    ) as { findings: unknown[] };
    const mapped = mapAgentShieldFinding(report.findings[1]);
    expect(mapped!.category).toBe("engineering_craft");
    expect(mapped!.severity).toBe("low");
  });

  it("drops ECC skill / observation-hook nits", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "agentshield-noise-skill.json"), "utf8"),
    ) as { findings: unknown[] };
    expect(mapAgentShieldFinding(report.findings[0])).toBeNull();
    expect(mapAgentShieldFinding(report.findings[1])).toBeNull();
  });

  it("keeps placeholder secrets at info", () => {
    const report = JSON.parse(
      readFileSync(join(FIXTURES, "agentshield-placeholder-secret.json"), "utf8"),
    ) as { findings: unknown[] };
    const mapped = mapAgentShieldFinding(report.findings[0]);
    expect(mapped!.severity).toBe("info");
    expect(mapped!.category).toBe("security_platform");
  });

  it("returns null for garbage input", () => {
    expect(mapAgentShieldFinding(null)).toBeNull();
    expect(mapAgentShieldFinding("nope")).toBeNull();
    expect(mapAgentShieldFinding({})).toBeNull();
  });

  it("maps injection/exposure/exfiltration/agents to product_architecture low", () => {
    for (const category of ["injection", "exposure", "exfiltration", "agents"]) {
      const mapped = mapAgentShieldFinding({
        id: `${category}-x`,
        title: category,
        category,
        severity: "high",
        evidence: "x",
        runtimeConfidence: "active-runtime",
      });
      expect(mapped!.category).toBe("product_architecture");
      expect(mapped!.severity).toBe("low");
    }
  });

  it("maps unknown category to engineering_craft", () => {
    const mapped = mapAgentShieldFinding({
      id: "other-x",
      title: "other",
      category: "other",
      evidence: "x",
      runtimeConfidence: "active-runtime",
    });
    expect(mapped!.category).toBe("engineering_craft");
  });

  it("does not double-prefix ids", () => {
    const mapped = mapAgentShieldFinding({
      id: "harness.agentshield.already",
      title: "x",
      category: "hooks",
      evidence: "x",
      runtimeConfidence: "active-runtime",
    });
    expect(mapped!.id).toBe("harness.agentshield.already");
  });

  it("redacts a token that only appears in title", () => {
    const mapped = mapAgentShieldFinding({
      id: "secrets-in-title",
      category: "secrets",
      title: `Hardcoded key ${FIXTURE_STRIPE_LIVE}`,
      description: "Found in config.",
      evidence: FIXTURE_STRIPE_LIVE,
      runtimeConfidence: "active-runtime",
    });
    expect(mapped!.title).not.toMatch(/sk_live_51/);
    expect(mapped!.severity).toBe("high");
  });

  it("keeps Claude sk-ant- high even when the description mentions examples/", () => {
    const mapped = mapAgentShieldFinding({
      id: "secrets-ant",
      category: "secrets",
      title: "Hardcoded Anthropic key",
      description: "Found key in examples/settings.json",
      evidence: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
      fix: { before: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", after: "${ANTHROPIC_API_KEY}", auto: true },
      runtimeConfidence: "docs-example",
    });
    expect(mapped!.severity).toBe("high");
    expect(mapped!.category).toBe("security_platform");
    expect(JSON.stringify(mapped)).not.toMatch(/sk-ant-api03-/);
  });

  it("keeps PEM-shaped secrets high even in docs-example", () => {
    const mapped = mapAgentShieldFinding({
      id: "secrets-pem",
      category: "secrets",
      title: "pem",
      evidence:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKFAKE\n-----END RSA PRIVATE KEY-----",
      runtimeConfidence: "docs-example",
    });
    expect(mapped!.severity).toBe("high");
    expect(mapped!.evidence).not.toMatch(/MIIEowIBAAKFAKE/);
  });
});

describe("buildAgentShieldArgv", () => {
  it("is scan --format json --path only — never --fix / MiniClaw / npx -y", () => {
    const built = buildAgentShieldArgv("/tmp/agents");
    expect(built.command).toBe("agentshield");
    expect(built.args).toEqual(["scan", "--format", "json", "--path", "/tmp/agents"]);
    const blob = [built.command, ...built.args].join(" ");
    for (const token of FORBIDDEN_AGENTSHIELD_SPAWN_TOKENS) {
      expect(blob).not.toContain(token);
    }
  });
});

describe("readAgentShieldJson", () => {
  it("ingests a fixture and prefixes ids", () => {
    const findings = readAgentShieldJson(materializeSecretFixture());
    expect(findings.some((f) => f.id === "harness.agentshield.ingested")).toBe(true);
    expect(
      findings.some((f) => f.id === "harness.agentshield.secrets-hardcoded-stripe-key"),
    ).toBe(true);
    expect(JSON.stringify(findings)).not.toMatch(/sk_live_51/);
  });

  it("returns a missing-file info finding", () => {
    const findings = readAgentShieldJson(join(FIXTURES, "no-such-file.json"));
    expect(findings.some((f) => f.id === "harness.agentshield.missing")).toBe(true);
  });

  it("returns unreadable finding for non-JSON", () => {
    const findings = readAgentShieldJson(join(FIXTURES, "agentshield-unreadable.txt"));
    expect(findings.some((f) => f.id === "harness.agentshield.unreadable")).toBe(true);
  });
});

describe("tryRunAgentShieldCli", () => {
  it("records a binary_not_found gap on ENOENT", () => {
    const result = tryRunAgentShieldCli("/tmp/agents", enoentSpawn());
    expect(result).toEqual({
      gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "binary_not_found" },
    });
  });

  it("ingests parseable JSON even when the CLI exits 2", () => {
    const json = readFileSync(materializeSecretFixture(), "utf8");
    const { spawn, calls } = recordingSpawn(() => ({
      status: 2,
      stdout: json,
      stderr: "critical findings",
    }));
    const result = tryRunAgentShieldCli("/abs/path", spawn);
    expect("findings" in result).toBe(true);
    if ("findings" in result) {
      expect(result.findings.some((f) => f.id === "harness.agentshield.ingested")).toBe(
        true,
      );
    }
    expect(calls[0]!.command).toBe("agentshield");
    expect(calls[0]!.args).not.toContain("--fix");
    expect(calls[0]!.args).not.toContain("--opus");
    expect(calls[0]!.args).not.toContain("--sandbox");
    expect(calls[0]!.args.join(" ")).not.toMatch(/miniclaw/i);
    expect(calls[0]!.args).not.toContain("npx");
  });

  it("records error_non_fatal when stdout is not JSON", () => {
    const result = tryRunAgentShieldCli("/abs/path", () => ({
      status: 0,
      stdout: "hello from agentshield",
      stderr: "",
    }));
    expect(result).toEqual({
      gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "error_non_fatal" },
    });
  });

  it("treats thrown ENOENT as binary_not_found", () => {
    const result = tryRunAgentShieldCli("/tmp/x", () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(result).toEqual({
      gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "binary_not_found" },
    });
  });

  it("treats thrown errors as error_non_fatal", () => {
    const result = tryRunAgentShieldCli("/tmp/x", () => {
      throw new Error("boom");
    });
    expect(result).toEqual({
      gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "error_non_fatal" },
    });
  });

  it("parses Buffer stdout", () => {
    const json = readFileSync(materializeSecretFixture(), "utf8");
    const result = tryRunAgentShieldCli("/tmp/x", () => ({
      status: 0,
      stdout: Buffer.from(json, "utf8"),
      stderr: "",
    }));
    expect("findings" in result).toBe(true);
  });

  it("treats empty stdout as error_non_fatal", () => {
    const result = tryRunAgentShieldCli("/tmp/x", () => ({
      status: 0,
      stdout: "   ",
      stderr: "",
    }));
    expect(result).toEqual({
      gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "error_non_fatal" },
    });
  });
});

describe("orr run + harness.agentshield", () => {
  it("parses --agentshield-json and --producer", () => {
    const p = parseArgs([
      "orr",
      "run",
      "--path",
      "/tmp/agents",
      "--producer",
      "harness.agentshield",
      "--agentshield-json",
      "/tmp/as.json",
    ]);
    const opts = orrRunOptionsFromArgs(p);
    expect(opts.agentshieldJsonPath).toBe("/tmp/as.json");
    expect(opts.producers).toContain(AGENTSHIELD_PRODUCER_ID);
  });

  it("ingests --agentshield-json secrets into security_platform without the raw token", () => {
    const root = emptyTree();
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json", "md"],
      producers: ["sa.first_party", AGENTSHIELD_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      agentshieldJsonPath: materializeSecretFixture(),
    });
    expect(result.exitCode).toBe(0);
    const secret = result.report.findings.find(
      (f) => f.id === "harness.agentshield.secrets-hardcoded-stripe-key",
    );
    expect(secret).toBeDefined();
    expect(secret!.category).toBe("security_platform");
    expect(secret!.severity).toBe("high");
    expect(JSON.stringify(result.report)).not.toMatch(/sk_live_51/);
    expect(result.report.coverage_gaps.some((g) => g.adapter_id === AGENTSHIELD_PRODUCER_ID)).toBe(
      false,
    );
    expect(result.report.coverage_gaps.some((g) => g.reason === "adapter_not_implemented_o1" && g.adapter_id === AGENTSHIELD_PRODUCER_ID)).toBe(
      false,
    );
    expect(formatHasNoDualPepAllow(result.report.findings)).toBe(true);
    const md = readFileSync(result.reportMdPath!, "utf8");
    expect(md).toMatch(/[Ss]ole PEP/);
    expect(md).not.toMatch(/is a second PEP|dual-PEP ALLOW/i);
    expect(md).not.toMatch(/sk_live_51/);
    expect(JSON.stringify(result.report)).not.toMatch(/sk-ant-api03-/);
  });

  it("redacts tokens from title in JSON and Markdown emit", () => {
    const root = emptyTree();
    const dump = join(root, "as.json");
    writeFileSync(
      dump,
      JSON.stringify({
        findings: [
          {
            id: "secrets-title",
            severity: "critical",
            category: "secrets",
            title: `key ${FIXTURE_STRIPE_LIVE}`,
            description: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
            evidence: FIXTURE_STRIPE_ELLIPSIS,
            runtimeConfidence: "active-runtime",
          },
        ],
      }),
    );
    const result = runOrr({
      path: root,
      out: join(root, "out-title"),
      rubric: "0",
      disableCategories: [],
      formats: ["json", "md"],
      producers: ["sa.first_party", AGENTSHIELD_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      agentshieldJsonPath: dump,
    });
    const json = readFileSync(result.reportJsonPath!, "utf8");
    const md = readFileSync(result.reportMdPath!, "utf8");
    expect(json).not.toMatch(/sk_live_51/);
    expect(json).not.toMatch(/sk-ant-api03-/);
    expect(md).not.toMatch(/sk_live_51/);
    expect(md).not.toMatch(/sk-ant-api03-/);
    const secret = result.report.findings.find((f) =>
      f.id.includes("secrets-title"),
    );
    expect(secret?.severity).toBe("high");
  });

  it("keeps template MCP at info so agent_control_plane rating matches SA probes alone", () => {
    const root = wrapTree();
    const saOnly = runOrr({
      path: root,
      out: join(root, "out-sa"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party"],
      skipOptionalProducers: true,
      quiet: true,
      jsonStdout: false,
    });
    const withAs = runOrr({
      path: root,
      out: join(root, "out-as"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", AGENTSHIELD_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      agentshieldJsonPath: join(FIXTURES, "agentshield-template-mcp.json"),
    });
    const saCp = saOnly.report.categories.find((c) => c.id === "agent_control_plane")!.rating;
    const asCp = withAs.report.categories.find((c) => c.id === "agent_control_plane")!.rating;
    expect(asCp).toBe(saCp);
    expect(
      withAs.report.findings.some(
        (f) => f.id.startsWith("harness.agentshield.") && f.severity === "info",
      ),
    ).toBe(true);
  });

  it("missing binary + no json → coverage gap, exit 0", () => {
    const root = emptyTree();
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", AGENTSHIELD_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      agentshieldSpawn: enoentSpawn(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.coverage_gaps).toContainEqual({
      adapter_id: AGENTSHIELD_PRODUCER_ID,
      reason: "binary_not_found",
    });
  });

  it("explicit producer still attempts when --skip-optional-producers is set", () => {
    const root = emptyTree();
    const { spawn, calls } = recordingSpawn(enoentSpawn());
    runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", AGENTSHIELD_PRODUCER_ID],
      skipOptionalProducers: true,
      quiet: true,
      jsonStdout: false,
      agentshieldSpawn: spawn,
    });
    expect(calls.length).toBe(1);
  });

  it("--skip-optional-producers without --producer harness.agentshield does not spawn", () => {
    const root = emptyTree();
    const { spawn, calls } = recordingSpawn(enoentSpawn());
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
      agentshieldSpawn: spawn,
    });
    expect(calls.length).toBe(0);
    expect(
      result.report.coverage_gaps.some((g) => g.adapter_id === AGENTSHIELD_PRODUCER_ID),
    ).toBe(false);
  });

  it("spawn argv never includes --fix / --opus / --sandbox / MiniClaw", () => {
    const root = emptyTree();
    const { spawn, calls } = recordingSpawn(enoentSpawn());
    runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: [AGENTSHIELD_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      agentshieldSpawn: spawn,
    });
    const argv = [calls[0]!.command, ...calls[0]!.args];
    for (const token of FORBIDDEN_AGENTSHIELD_SPAWN_TOKENS) {
      expect(argv.join(" ")).not.toContain(token);
    }
  });

  it("unknown producers still emit adapter_not_implemented_o1", () => {
    const root = emptyTree();
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", "opensource.openvuln"],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
    });
    expect(result.report.coverage_gaps).toContainEqual({
      adapter_id: "opensource.openvuln",
      reason: "adapter_not_implemented_o1",
    });
  });

  it("prefers SA first-party high/critical for primary_failure_mode when both exist", () => {
    const root = emptyTree();
    const sa = runSaFirstPartyProbes(root);
    expect(sa.some((f) => f.severity === "critical" || f.severity === "high")).toBe(true);
    const result = runOrr({
      path: root,
      out: join(root, "out"),
      rubric: "0",
      disableCategories: [],
      formats: ["json"],
      producers: ["sa.first_party", AGENTSHIELD_PRODUCER_ID],
      skipOptionalProducers: false,
      quiet: true,
      jsonStdout: false,
      agentshieldJsonPath: materializeSecretFixture(),
    });
    expect(result.report.primary_failure_mode).not.toMatch(/Hardcoded Stripe/i);
    expect(result.report.primary_failure_mode).toMatch(/evaluate|REQUIRE_APPROVE|control/i);
  });

  it("@shield-agent/kya does not depend on ecc-agentshield", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    expect(names).not.toContain("ecc-agentshield");
  });
});

describe("e2e: kya orr run CLI + AgentShield JSON", () => {
  it("writes a report from --agentshield-json and exits 0", async () => {
    const root = wrapTree();
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
        "--producer",
        AGENTSHIELD_PRODUCER_ID,
        "--agentshield-json",
        materializeSecretFixture(),
        "--quiet",
        "--json-stdout",
      ],
      io,
      {},
      root,
    );
    expect(code).toBe(0);
    const body = logs.join("\n");
    expect(body).toContain("harness.agentshield");
    expect(body).not.toMatch(/sk_live_51/);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as {
      findings: OrrFinding[];
      coverage_gaps: { adapter_id: string }[];
      rubric_version: string;
    };
    expect(report.rubric_version).toBe("0");
    expect(report.findings.some((f) => f.source_tool === AGENTSHIELD_PRODUCER_ID)).toBe(
      true,
    );
    expect(report.coverage_gaps.some((g) => g.adapter_id === AGENTSHIELD_PRODUCER_ID)).toBe(
      false,
    );
  });

  it("help names the producer id", async () => {
    const { io, logs } = captureIo();
    const code = await runCli(["--help"], io);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("harness.agentshield");
    expect(logs.join("\n")).toContain("--agentshield-json");
    expect(logs.join("\n").toLowerCase()).not.toContain("agentseal");
    expect(logs.join("\n")).not.toContain("harness.guard_report");
    expect(logs.join("\n")).not.toContain("--guard-json");
  });
});

function formatHasNoDualPepAllow(findings: readonly OrrFinding[]): boolean {
  return findings.every(
    (f) => !/"verdict"\s*:\s*"ALLOW"/i.test(`${f.title} ${f.detail}`),
  );
}
