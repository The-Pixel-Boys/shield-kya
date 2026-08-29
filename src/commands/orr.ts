/**
 * kya orr run — Phase O1 read-only ORR board emitter.
 * Reporting orchestrator only: not a second PEP; never mints principals or allows side effects.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { UsageError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagBool, flagString } from "../parse-args.js";
import {
  AGENTSHIELD_PRODUCER_ID,
  readAgentShieldJson,
  tryRunAgentShieldCli,
  type AgentShieldSpawnFn,
} from "../orr/agentshield.js";
import {
  buildShowback,
  parseUsageRecords,
  type ShowbackReport,
} from "../showback/cost-per-task.js";

export type OrrRating = "green" | "amber" | "red";
export type OrrDisposition = "go" | "conditional" | "no_go";
export type OrrSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface OrrFinding {
  readonly id: string;
  readonly category: string;
  readonly severity: OrrSeverity;
  readonly title: string;
  readonly detail: string;
  readonly evidence?: string;
  readonly source_tool?: string;
}

export interface OrrCategory {
  readonly id: string;
  readonly label: string;
  readonly rating: OrrRating;
  readonly tldr: string;
}

export interface OrrCoverageGap {
  readonly adapter_id: string;
  readonly reason: string;
}

export interface OrrReport {
  readonly rubric_version: "0";
  readonly generated_at: string;
  readonly target: {
    readonly name: string;
    readonly path: string;
    readonly commit_sha?: string;
    readonly kind: "path" | "repo";
  };
  readonly scope: {
    readonly description: string;
    readonly disabled_categories: readonly string[];
    readonly producers_requested: readonly string[];
  };
  readonly overall: OrrRating;
  readonly disposition: OrrDisposition;
  readonly primary_failure_mode: string;
  readonly most_urgent_fix: string;
  readonly categories: readonly OrrCategory[];
  readonly scorecards: readonly {
    readonly category: string;
    readonly name: string;
    readonly result: "pass" | "fail" | "partial" | "not_evaluated";
    readonly hardness: "hard" | "soft";
    readonly note?: string;
  }[];
  readonly findings: readonly OrrFinding[];
  readonly coverage_gaps: readonly OrrCoverageGap[];
  /** Observe-only token/USD showback. Never a PEP or billing meter. */
  readonly showback?: ShowbackReport;
}

export interface OrrRunOptions {
  readonly path: string;
  readonly out: string;
  readonly name?: string;
  readonly rubric: string;
  readonly disableCategories: readonly string[];
  readonly formats: readonly ("json" | "md")[];
  readonly commitSha?: string;
  readonly producers: readonly string[];
  readonly skipOptionalProducers: boolean;
  readonly failOn?: "no_go" | "conditional";
  readonly quiet: boolean;
  readonly jsonStdout: boolean;
  /** Optional OpenSSF Scorecard / readiness JSON. Evidence only — not a PEP. */
  readonly scorecardPath?: string;
  /** Optional AgentShield SecurityReport JSON dump. Evidence only — not a PEP. */
  readonly agentshieldJsonPath?: string;
  /** Optional usage JSON (array). Observe-only showback. */
  readonly usagePath?: string;
  /** Test seam. Production uses spawnSync("agentshield", ...). Never --fix. */
  readonly agentshieldSpawn?: AgentShieldSpawnFn;
}

const CATEGORY_META: readonly { id: string; label: string }[] = [
  { id: "engineering_craft", label: "Engineering craft" },
  { id: "security_platform", label: "Security and platform" },
  { id: "enterprise_readiness", label: "Enterprise readiness" },
  { id: "agent_control_plane", label: "Agent control plane" },
  { id: "product_architecture", label: "Product / architecture" },
  { id: "scale_operations", label: "Scale and operations" },
  { id: "cost_budget_gates", label: "Cost and budget gates" },
  { id: "packaging_supply_chain", label: "Packaging / supply chain" },
  { id: "agent_factory_lifecycle", label: "Agent factory / lifecycle" },
];

const ALL_CATEGORY_IDS = new Set(CATEGORY_META.map((c) => c.id));

export function orrRunOptionsFromArgs(parsed: ParsedArgs): OrrRunOptions {
  const path = flagString(parsed.flags, "path");
  if (!path) {
    throw new UsageError("orr run requires --path <dir>");
  }
  const out = flagString(parsed.flags, "out") ?? "./orr-report";
  const name = flagString(parsed.flags, "name");
  const rubric = flagString(parsed.flags, "rubric") ?? "0";
  const disableRaw = collectMulti(parsed, "disable-category");
  const formatRaw = flagString(parsed.flags, "format") ?? "json,md";
  const formats = formatRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is "json" | "md" => s === "json" || s === "md");
  if (formats.length === 0) {
    throw new UsageError("--format must include json and/or md");
  }
  const commitSha = flagString(parsed.flags, "commit-sha");
  let producers = collectMulti(parsed, "producer");
  if (producers.length === 0) producers = ["sa.first_party"];
  const skipOptionalProducers = flagBool(parsed.flags, "skip-optional-producers");
  const failOnRaw = flagString(parsed.flags, "fail-on");
  let failOn: "no_go" | "conditional" | undefined;
  if (failOnRaw === "no_go" || failOnRaw === "conditional") failOn = failOnRaw;
  else if (failOnRaw) throw new UsageError("--fail-on must be no_go or conditional");

  return {
    path,
    out,
    name,
    rubric,
    disableCategories: disableRaw,
    formats,
    commitSha,
    producers,
    skipOptionalProducers,
    failOn,
    quiet: flagBool(parsed.flags, "quiet"),
    jsonStdout: flagBool(parsed.flags, "json-stdout"),
    scorecardPath: flagString(parsed.flags, "scorecard"),
    agentshieldJsonPath: flagString(parsed.flags, "agentshield-json"),
    usagePath: flagString(parsed.flags, "usage"),
  };
}

function collectMulti(parsed: ParsedArgs, name: string): string[] {
  const out: string[] = [];
  const v = parsed.flags[name];
  if (typeof v === "string" && v.length > 0) out.push(v);
  // parse-args keeps last flag only; support comma-separated multi
  for (const item of out.flatMap((s) => s.split(",").map((x) => x.trim()).filter(Boolean))) {
    if (!out.includes(item)) out.push(item);
  }
  // re-unique
  return [...new Set(out.flatMap((s) => s.split(",").map((x) => x.trim()).filter(Boolean)))];
}

export interface OrrRunResult {
  readonly report: OrrReport;
  readonly reportJsonPath?: string;
  readonly reportMdPath?: string;
  readonly exitCode: number;
}

export function runOrr(options: OrrRunOptions): OrrRunResult {
  if (options.rubric !== "0") {
    throw new UsageError(`unsupported rubric version "${options.rubric}" (O1 supports 0 only)`);
  }
  const absPath = resolve(options.path);
  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
    throw new UsageError(`--path must be an existing directory: ${options.path}`);
  }
  for (const id of options.disableCategories) {
    if (!ALL_CATEGORY_IDS.has(id)) {
      throw new UsageError(`unknown category id for --disable-category: ${id}`);
    }
  }

  const commitSha =
    options.commitSha ??
    tryReadGitHead(absPath) ??
    undefined;
  const findings = [...runSaFirstPartyProbes(absPath)];
  const coverageGaps: OrrCoverageGap[] = [];
  const producersRequested = [...options.producers];
  if (options.scorecardPath && !producersRequested.includes("openssf.scorecard")) {
    producersRequested.push("openssf.scorecard");
  }
  if (
    options.agentshieldJsonPath &&
    !producersRequested.includes(AGENTSHIELD_PRODUCER_ID)
  ) {
    producersRequested.push(AGENTSHIELD_PRODUCER_ID);
  }

  if (options.scorecardPath) {
    findings.push(...readScorecardEvidence(options.scorecardPath));
  }

  const agentShieldRequested =
    producersRequested.includes(AGENTSHIELD_PRODUCER_ID) ||
    Boolean(options.agentshieldJsonPath);
  if (agentShieldRequested) {
    if (options.agentshieldJsonPath) {
      findings.push(...readAgentShieldJson(options.agentshieldJsonPath));
    } else {
      const asResult = tryRunAgentShieldCli(absPath, options.agentshieldSpawn);
      if ("findings" in asResult) findings.push(...asResult.findings);
      else coverageGaps.push(asResult.gap);
    }
  }

  if (!options.skipOptionalProducers) {
    for (const p of producersRequested) {
      if (p === "sa.first_party") continue;
      if (p === AGENTSHIELD_PRODUCER_ID) continue;
      if (p === "openssf.scorecard") {
        if (options.scorecardPath) continue;
        coverageGaps.push({
          adapter_id: p,
          reason: "binary_not_found_or_not_run_in_o1",
        });
      } else {
        coverageGaps.push({
          adapter_id: p,
          reason: "adapter_not_implemented_o1",
        });
      }
    }
  }

  const disabled = new Set(options.disableCategories);
  const scorecards = buildScorecards(findings, absPath, disabled);
  const categories = scoreCategories(findings, scorecards, disabled);
  const showback = loadShowback(absPath, options.usagePath);
  const overall = rollupOverall(categories);
  const disposition = rollupDisposition(overall, categories);
  const primary = pickPrimaryFailure(findings);
  const report: OrrReport = {
    rubric_version: "0",
    generated_at: new Date().toISOString(),
    target: {
      name: options.name ?? basename(absPath),
      path: absPath,
      ...(commitSha ? { commit_sha: commitSha } : {}),
      kind: existsSync(join(absPath, ".git")) ? "repo" : "path",
    },
    scope: {
      description: `Read-only ORR O1 scan of ${absPath}`,
      disabled_categories: [...options.disableCategories],
      producers_requested: producersRequested,
    },
    overall,
    disposition,
    primary_failure_mode: primary
      ? `${primary.title} (${primary.category})`
      : "No critical control-plane findings from SA first-party probes",
    most_urgent_fix: primary
      ? primary.detail
      : "Keep sole PEP on Shield; wire evaluate/wrap for irreversible tools",
    categories,
    scorecards,
    findings,
    coverage_gaps: coverageGaps,
    ...(showback ? { showback } : {}),
  };

  const outDir = resolve(options.out);
  mkdirSync(outDir, { recursive: true });
  let reportJsonPath: string | undefined;
  let reportMdPath: string | undefined;
  if (options.formats.includes("json")) {
    reportJsonPath = join(outDir, "report.json");
    writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (options.formats.includes("md")) {
    reportMdPath = join(outDir, "report.md");
    writeFileSync(reportMdPath, formatOrrMarkdown(report), "utf8");
  }

  let exitCode = 0;
  if (options.failOn === "no_go" && disposition === "no_go") exitCode = 3;
  if (
    options.failOn === "conditional" &&
    (disposition === "conditional" || disposition === "no_go")
  ) {
    exitCode = 4;
  }

  return { report, reportJsonPath, reportMdPath, exitCode };
}

/**
 * Ingest an OpenSSF Scorecard / readiness JSON dump as **evidence**.
 * Never maps a score to ALLOW. Missing file is a coverage gap finding.
 */
export function readScorecardEvidence(scorecardPath: string): OrrFinding[] {
  const abs = resolve(scorecardPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return [
      {
        id: "sa.scorecard.missing",
        category: "enterprise_readiness",
        severity: "info",
        title: "Scorecard file not found",
        detail:
          `${scorecardPath} was requested as an optional producer. Evidence only — not a PEP.`,
        evidence: abs,
        source_tool: "openssf.scorecard",
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return [
      {
        id: "sa.scorecard.unreadable",
        category: "enterprise_readiness",
        severity: "low",
        title: "Scorecard JSON unreadable",
        detail: "Could not parse --scorecard file. ORR stays observational.",
        evidence: abs,
        source_tool: "openssf.scorecard",
      },
    ];
  }
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const score = typeof obj.score === "number" ? obj.score : undefined;
  const checks = Array.isArray(obj.checks) ? obj.checks : [];
  const findings: OrrFinding[] = [
    {
      id: "sa.scorecard.ingested",
      category: "enterprise_readiness",
      severity: "info",
      title: "Scorecard ingested as evidence",
      detail:
        score === undefined
          ? "Scorecard dump loaded. Does not ALLOW side effects."
          : `Scorecard score=${score} (evidence only — not a PEP).`,
      evidence: abs,
      source_tool: "openssf.scorecard",
    },
  ];
  for (const raw of checks.slice(0, 24)) {
    if (!raw || typeof raw !== "object") continue;
    const check = raw as Record<string, unknown>;
    const name = typeof check.name === "string" ? check.name : "check";
    const checkScore = check.score;
    findings.push({
      id: `sa.scorecard.check.${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      category: "enterprise_readiness",
      severity: "info",
      title: `Scorecard ${name}`,
      detail: `score=${String(checkScore ?? "n/a")} — evidence only`,
      evidence: abs,
      source_tool: "openssf.scorecard",
    });
  }
  return findings;
}

/** SA first-party probes: evidence only; scanners never ALLOW. */
export function runSaFirstPartyProbes(root: string): OrrFinding[] {
  const findings: OrrFinding[] = [];
  const tree = listTreeSample(root, 400);
  const textBlob = tree
    .filter((p) => /\.(ts|js|java|md|json|yml|yaml)$/i.test(p))
    .slice(0, 80)
    .map((p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");

  const hasEvaluate =
    /policy\/evaluate|evaluatePolicy|wrapTool|kya\.policy_evaluate|PolicyEngine/.test(
      textBlob,
    );
  const hasRequireApprove = /REQUIRE_APPROVE|require_approve|requireApprove/.test(
    textBlob,
  );
  const hasDualPlane = /host\s*[=:]\s*["']?(ide|runtime)|AgentHost|KYA_HOST/.test(
    textBlob,
  );
  const hasTrail =
    /EventLog|ToolEvent|AT-20|argsHash|POLICY_ALLOW|POLICY_DENY/.test(textBlob);
  const hasCustomToolId = /toolId|tool_id|org\.sample\.|ToolDescriptor/.test(
    textBlob,
  );
  const dualPepSmell =
    /dual.?pep|second.?pep|scanner.?allow|edge.?approv/i.test(textBlob) &&
    /allow.?without.?shield|bypass.?kya/i.test(textBlob);
  const secretsSmell =
    /(?:api[_-]?key|secret|password)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}/i.test(
      textBlob,
    );
  const factoryGated =
    /org\.kya\.agent\.create|factory.*toolId|AGENT_REGISTERED/.test(textBlob);
  const registerWithoutPolicy =
    /register-agent|AgentRegistry\.register|POST.*\/kya\/agents/.test(textBlob) &&
    !factoryGated;

  if (!hasEvaluate) {
    findings.push({
      id: "sa.probe.no_evaluate_path",
      category: "agent_control_plane",
      severity: "critical",
      title: "No fail-closed evaluate/wrap path detected",
      detail:
        "Tree lacks policy evaluate / wrapTool / PolicyEngine signals. Irreversible tools may run without Shield PEP.",
      evidence: "sa.first_party text probe",
    });
  }
  if (!hasRequireApprove) {
    findings.push({
      id: "sa.probe.no_require_approve",
      category: "agent_control_plane",
      severity: "high",
      title: "REQUIRE_APPROVE not detected",
      detail:
        "High-stakes irreversible tools should map to REQUIRE_APPROVE (or DENY), never silent ALLOW.",
      evidence: "sa.first_party text probe",
    });
  }
  if (!hasDualPlane) {
    findings.push({
      id: "sa.probe.no_dual_plane",
      category: "product_architecture",
      severity: "medium",
      title: "Dual-plane host labels not detected",
      detail: "Tag sessions host=ide (authoring) vs host=runtime (production).",
      evidence: "sa.first_party text probe",
    });
  }
  if (!hasTrail) {
    findings.push({
      id: "sa.probe.no_trail",
      category: "agent_control_plane",
      severity: "medium",
      title: "Policy/tool trail signals weak or missing",
      detail: "Prefer hash-linked trail for evaluate and approval create (AT-20).",
      evidence: "sa.first_party text probe",
    });
  }
  if (!hasCustomToolId) {
    findings.push({
      id: "sa.probe.no_custom_toolid",
      category: "engineering_craft",
      severity: "low",
      title: "Custom toolId / descriptor patterns not found",
      detail: "Custom tools should be first-class via stable toolId + metadata (packs optional).",
      evidence: "sa.first_party text probe",
    });
  }
  if (dualPepSmell) {
    findings.push({
      id: "sa.probe.dual_pep_smell",
      category: "agent_control_plane",
      severity: "critical",
      title: "Dual-PEP smell in tree",
      detail:
        "Evidence suggests scanner/edge might ALLOW high-stakes actions. Sole PEP must remain Shield KYA.",
      evidence: "sa.first_party text probe",
    });
  }
  if (secretsSmell) {
    findings.push({
      id: "sa.probe.secrets_in_tree",
      category: "security_platform",
      severity: "critical",
      title: "Possible hardcoded secrets",
      detail: "Rotate credentials; load secrets from env or a secret manager.",
      evidence: "sa.first_party text probe",
    });
  }
  if (registerWithoutPolicy) {
    findings.push({
      id: "sa.probe.factory_not_gated",
      category: "agent_factory_lifecycle",
      severity: "high",
      title: "Agent create path may be scope-auth only",
      detail:
        "Factory doctrine: principal mint should be policy-gated (APPROVED). ORR reports only — does not mint.",
      evidence: "sa.first_party text probe",
    });
  }

  
  const hasMaxSteps = /max[_-]?steps|maxSteps|MAX_STEPS/.test(textBlob);
  const hasMaxTokens = /max[_-]?tokens|maxTokens|MAX_TOKENS/.test(textBlob);
  const hasRetryCeiling =
    /max[_-]?retries|maxRetries|MAX_RETRIES|boundedRetries|retry.?ceiling/i.test(
      textBlob,
    );
  const hasRunBudget =
    /maxCost|max_cost|max[_-]?budget|maxBudget|per[_-]?run[_-]?budget/i.test(
      textBlob,
    );
  const hasInLoopCeiling =
    hasMaxSteps || hasMaxTokens || hasRetryCeiling || hasRunBudget;
  if (!hasInLoopCeiling) {
    findings.push({
      id: "sa.probe.no_in_loop_ceilings",
      category: "cost_budget_gates",
      severity: "info",
      title: "No in-loop step/token/retry ceilings detected",
      detail:
        "Look for max_steps, max_tokens, max_retries, or maxCost in the agent loop. Soft gate only — ORR does not kill spend.",
      evidence: "sa.first_party text probe",
    });
  }

return findings.map((f) =>
    f.source_tool ? f : { ...f, source_tool: "sa.first_party" },
  );
}

function pickPrimaryFailure(findings: readonly OrrFinding[]): OrrFinding | undefined {
  const isSa = (f: OrrFinding) =>
    f.source_tool === "sa.first_party" ||
    f.id.startsWith("sa.probe.") ||
    f.id.startsWith("sa.scorecard.");
  const highish = (f: OrrFinding) =>
    f.severity === "critical" || f.severity === "high";
  return (
    findings.find((f) => isSa(f) && highish(f)) ??
    findings.find(highish) ??
    findings[0]
  );
}

function scoreCategories(
  findings: readonly OrrFinding[],
  scorecards: OrrReport["scorecards"],
  disabled: Set<string>,
): OrrCategory[] {
  return CATEGORY_META.filter((c) => !disabled.has(c.id)).map((c) => {
    const catFindings = findings.filter((f) => f.category === c.id);
    let rating: OrrRating = "green";
    if (catFindings.some((f) => f.severity === "critical")) rating = "red";
    else if (
      catFindings.some((f) => f.severity === "high" || f.severity === "medium")
    ) {
      rating = "amber";
    }
    const softPartial = scorecards.some(
      (sc) =>
        sc.category === c.id &&
        sc.hardness === "soft" &&
        sc.result === "partial",
    );
    if (rating === "green" && softPartial) rating = "amber";
    const top = catFindings[0];
    let tldr = top ? top.title : "No findings from SA first-party probes";
    if (!top && softPartial) {
      tldr = "Soft gate partial: in-loop ceilings not detected";
    }
    return {
      id: c.id,
      label: c.label,
      rating,
      tldr,
    };
  });
}

function buildScorecards(
  findings: readonly OrrFinding[],
  root: string,
  disabled: Set<string>,
) {
  const hasEval = !findings.some((f) => f.id === "sa.probe.no_evaluate_path");
  const hasRa = !findings.some((f) => f.id === "sa.probe.no_require_approve");
  const dualPep = findings.some((f) => f.id === "sa.probe.dual_pep_smell");
  const secrets = findings.some((f) => f.id === "sa.probe.secrets_in_tree");
  const factory = findings.some((f) => f.id === "sa.probe.factory_not_gated");

  const cards: Array<OrrReport["scorecards"][number]> = [];
  if (!disabled.has("agent_control_plane")) {
    cards.push(
      {
        category: "agent_control_plane",
        name: "fail_closed_tool_path",
        result: hasEval ? "pass" : "fail",
        hardness: "hard",
        note: hasEval ? "evaluate/wrap signals present" : "missing evaluate path",
      },
      {
        category: "agent_control_plane",
        name: "irreversible_require_approve",
        result: hasRa ? "pass" : "fail",
        hardness: "hard",
      },
      {
        category: "agent_control_plane",
        name: "sole_pep",
        result: dualPep ? "fail" : "pass",
        hardness: "hard",
        note: dualPep ? "dual-PEP smell" : "no dual-PEP evidence",
      },
    );
  }
  if (!disabled.has("agent_factory_lifecycle")) {
    cards.push({
      category: "agent_factory_lifecycle",
      name: "factory_tool_gated",
      result: factory ? "fail" : "partial",
      hardness: "hard",
      note: factory
        ? "create path looks scope-auth only"
        : "no clear factory gap or no create path",
    });
  }
  if (!disabled.has("security_platform")) {
    cards.push({
      category: "security_platform",
      name: "secrets_in_tree",
      result: secrets ? "fail" : "pass",
      hardness: "hard",
      note: `scanned sample under ${basename(root)}`,
    });
  }
  if (!disabled.has("cost_budget_gates")) {
    const hasCeilings = !findings.some(
      (f) => f.id === "sa.probe.no_in_loop_ceilings",
    );
    cards.push({
      category: "cost_budget_gates",
      name: "in_loop_ceilings",
      result: hasCeilings ? "pass" : "partial",
      hardness: "soft",
      note: hasCeilings
        ? "step/token/retry or run-budget signal present"
        : "no in-loop ceilings detected (soft)",
    });
  }
  return cards;
}

function rollupOverall(categories: readonly OrrCategory[]): OrrRating {
  if (categories.some((c) => c.rating === "red")) return "red";
  if (categories.some((c) => c.rating === "amber")) return "amber";
  return "green";
}

function rollupDisposition(
  overall: OrrRating,
  categories: readonly OrrCategory[],
): OrrDisposition {
  const reds = categories.filter((c) => c.rating === "red").length;
  if (overall === "red" || reds >= 2) return "no_go";
  if (overall === "amber" || reds === 1) return "conditional";
  return "go";
}

export function formatOrrMarkdown(report: OrrReport): string {
  const cats = report.categories
    .map((c) => `| ${c.id} | ${c.rating} | ${c.tldr} |`)
    .join("\n");
  const findings = report.findings
    .map((f) => `- **[${f.severity}]** ${f.title} (\`${f.category}\`): ${f.detail}`)
    .join("\n");
  const gaps =
    report.coverage_gaps.length === 0
      ? "- (none)"
      : report.coverage_gaps
          .map((g) => `- \`${g.adapter_id}\`: ${g.reason}`)
          .join("\n");
  const showbackMd = formatShowbackMarkdown(report.showback);
  const cards = report.scorecards
    .map(
      (s) =>
        `- \`${s.category}\` / \`${s.name}\`: **${s.result}** (${s.hardness})${s.note ? ` — ${s.note}` : ""}`,
    )
    .join("\n");

  return `# ORR: ${report.target.name}

- **Overall:** ${report.overall}
- **Disposition:** ${report.disposition}
- **Rubric:** v${report.rubric_version}
- **Generated:** ${report.generated_at}
- **Path:** ${report.target.path}
- **Commit:** ${report.target.commit_sha ?? "n/a"}

## Primary failure mode
${report.primary_failure_mode}

## Most urgent fix
${report.most_urgent_fix}

## Categories
| Category | Rating | TL;DR |
|----------|--------|-------|
${cats}

## Scorecards
${cards || "- (none)"}

## Findings
${findings || "- (none)"}

## Coverage gaps
${gaps}

## Showback
${showbackMd}

---
*ORR is a reporting orchestrator. Sole PEP remains Shield KYA (ALLOW / DENY / REQUIRE_APPROVE). Scanners are evidence only - never a second PEP. Showback is estimate-only and not a billing meter.*
`;
}


function loadShowback(
  root: string,
  usagePath: string | undefined,
): ShowbackReport | undefined {
  const candidates = [
    usagePath ? resolve(usagePath) : undefined,
    join(root, ".kya", "usage.json"),
  ].filter((x): x is string => Boolean(x));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const records = parseUsageRecords(
        Array.isArray(raw) ? raw : (raw as { usage?: unknown }).usage,
      );
      if (records.length === 0) continue;
      return buildShowback(records);
    } catch {
      /* ignore bad usage file; coverage stays empty */
    }
  }
  return undefined;
}

function formatShowbackMarkdown(showback: ShowbackReport | undefined): string {
  if (!showback) {
    return "- (none: pass --usage or .kya/usage.json for observe-only cost-per-task)";
  }
  const runs = showback.perRun
    .slice(0, 20)
    .map((r) => {
      const usd =
        r.estimatedUsd === null ? " (USD n/a)" : " (~$" + String(r.estimatedUsd) + ")";
      const subs = r.subagentIds.length
        ? "; subagents: " + r.subagentIds.join(", ")
        : "";
      return (
        '- run `' +
        r.runId +
        '` agent `' +
        r.parentAgentId +
        '`: ' +
        String(r.tokensIn) +
        " in / " +
        String(r.tokensOut) +
        " out" +
        usd +
        subs
      );
    })
    .join("\n");
  const totalUsd =
    showback.estimatedUsd === null
      ? " (USD n/a)"
      : " (~$" + String(showback.estimatedUsd) + ")";
  return [
    "- **Disclaimer:** " + showback.disclaimer,
    "- **billingMeter:** false",
    "- **Totals:** " +
      showback.totalTokensIn +
      " in / " +
      showback.totalTokensOut +
      " out" +
      totalUsd,
    runs || "- (no runs)",
  ].join("\n");
}

function tryReadGitHead(root: string): string | undefined {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      const sha = readFileSync(join(root, ".git", ref), "utf8").trim();
      if (/^[0-9a-f]{7,64}$/i.test(sha)) return sha;
    }
    if (/^[0-9a-f]{7,64}$/i.test(head)) return head;
  } catch {
    /* ignore */
  }
  return undefined;
}

function listTreeSample(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const skip = new Set([
    "node_modules",
    "target",
    ".git",
    "dist",
    "coverage",
    ".idea",
    "vendor",
  ]);

  function walk(dir: string): void {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      if (skip.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size < 512_000) out.push(p);
    }
  }

  walk(root);
  return out;
}
