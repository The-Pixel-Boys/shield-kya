/**
 * Optional ORR producer for affaan-m/agentshield (CLI `agentshield`).
 * Evidence only — never a PEP. Never `--fix`, never MiniClaw, never npx -y.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { OrrCoverageGap, OrrFinding, OrrSeverity } from "../commands/orr.js";
import { sanitizedScorecardEnv } from "./scorecard.js";

export const AGENTSHIELD_PRODUCER_ID = "harness.agentshield";

export const FORBIDDEN_AGENTSHIELD_SPAWN_TOKENS = [
  "--fix",
  "--opus",
  "--sandbox",
  "--injection",
  "--taint",
  "miniclaw",
  "npx",
] as const;

const LOW_CONFIDENCE = new Set([
  "template-example",
  "docs-example",
  "plugin-manifest",
  "project-local-optional",
]);

const PLACEHOLDER_RE =
  /your[_-]?api[_-]?key|changeme|placeholder|insert[_-]?key|<token>|<secret>|dummy(?:[_-]?key)?|fake[_-]?key|\$\{[A-Z][A-Z0-9_]*\}/i;

const TOKEN_SHAPE_RE =
  /\b(sk_live_|rk_live_|whsec_|ghp_|github_pat_|sk-ant-|sk-proj-|AKIA|npm_|AIza|xai-|hf_|sk_test_[A-Za-z0-9]{16,}|rk_test_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,})/;

export interface AgentShieldSpawnResult {
  readonly status: number | null;
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
  readonly error?: NodeJS.ErrnoException;
}

export type AgentShieldSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
) => AgentShieldSpawnResult;

export function buildAgentShieldArgv(absPath: string): {
  command: "agentshield";
  args: readonly string[];
} {
  return {
    command: "agentshield",
    args: ["scan", "--format", "json", "--path", absPath],
  };
}

export function redactEvidence(s: string): string {
  let out = s;
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-pem]",
  );
  // AgentShield maskSecretValue form: first8...last4
  out = out.replace(
    /\b(sk_live_|sk_test_|rk_live_|rk_test_|whsec_|ghp_|github_pat_|sk-ant-|sk-proj-|npm_|AIza|xai-|hf_|AKIA)[A-Za-z0-9+/=_-]*\.{3}[A-Za-z0-9+/=_-]+/g,
    "$1[redacted]",
  );
  out = out.replace(/\bsk_(live|test)_[A-Za-z0-9]+/g, "sk_$1_[redacted]");
  out = out.replace(/\brk_(live|test)_[A-Za-z0-9]+/g, "rk_$1_[redacted]");
  out = out.replace(/\bwhsec_[A-Za-z0-9]+/g, "whsec_[redacted]");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_[redacted]");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, "gh*_[redacted]");
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]");
  out = out.replace(/\bsk-proj-[A-Za-z0-9_-]+/g, "sk-proj-[redacted]");
  out = out.replace(/\bAKIA[0-9A-Z]{8,}/g, "AKIA[redacted]");
  out = out.replace(/\bnpm_[A-Za-z0-9]+/g, "npm_[redacted]");
  out = out.replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "AIza[redacted]");
  out = out.replace(/\bxai-[A-Za-z0-9]+/g, "xai-[redacted]");
  out = out.replace(/\bhf_[A-Za-z0-9]+/g, "hf_[redacted]");
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}/g, "sk-[redacted]");
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]+/g, "xox*-[redacted]");
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "[redacted-jwt]",
  );
  out = out.replace(
    /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"']+/gi,
    "[redacted-uri]",
  );
  out = out.replace(
    /https:\/\/hooks\.slack\.com\/services\/[^\s"']+/gi,
    "https://hooks.slack.com/services/[redacted]",
  );
  return out;
}

export function looksLikeRealSecret(s: string): boolean {
  if (!s) return false;
  if (TOKEN_SHAPE_RE.test(s) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) {
    return true;
  }
  if (PLACEHOLDER_RE.test(s)) return false;
  return false;
}

/** Secrets category: judge evidence / fix.before only — never path/title text. */
export function secretsValueLooksReal(evidence: string, fixBefore: string): boolean {
  const value = [evidence, fixBefore].filter(Boolean).join("\n");
  if (!value.trim()) return false;
  if (looksLikeRealSecret(value)) return true;
  return !PLACEHOLDER_RE.test(value);
}

export function mapAgentShieldFinding(raw: unknown): OrrFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const idRaw = typeof rec.id === "string" ? rec.id.trim() : "";
  const titleRaw = typeof rec.title === "string" ? rec.title.trim() : "";
  if (!idRaw && !titleRaw) return null;

  const asCategory = typeof rec.category === "string" ? rec.category : "";
  const title = titleRaw || idRaw;
  if (isNoise(idRaw, title, asCategory)) return null;

  const description = typeof rec.description === "string" ? rec.description : "";
  const evidenceRaw = typeof rec.evidence === "string" ? rec.evidence : "";
  const fix = rec.fix && typeof rec.fix === "object" ? (rec.fix as Record<string, unknown>) : {};
  const fixBefore = typeof fix.before === "string" ? fix.before : "";
  const conf = typeof rec.runtimeConfidence === "string" ? rec.runtimeConfidence : "";
  const asSeverity = typeof rec.severity === "string" ? rec.severity : "";

  const category = mapOrrCategory(asCategory);
  const severity = mapOrrSeverity(asCategory, conf, evidenceRaw, fixBefore, asSeverity);
  const id = stableFindingId(idRaw || title);

  return {
    id,
    category,
    severity,
    title: redactEvidence(title),
    detail: redactEvidence(description || title),
    evidence: redactEvidence(
      evidenceRaw || `${String(rec.file ?? "agentshield")}:${String(rec.line ?? "?")}`,
    ),
    source_tool: AGENTSHIELD_PRODUCER_ID,
  };
}

export function ingestAgentShieldReport(parsed: unknown): OrrFinding[] {
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const mapped: OrrFinding[] = [];
  for (const raw of rawFindings) {
    const finding = mapAgentShieldFinding(raw);
    if (finding) mapped.push(finding);
  }
  return [
    {
      id: "harness.agentshield.ingested",
      category: "engineering_craft",
      severity: "info",
      title: "AgentShield report ingested as evidence",
      detail: `${mapped.length} finding(s) mapped. Evidence only — not a PEP.`,
      evidence: "harness.agentshield JSON ingest",
      source_tool: AGENTSHIELD_PRODUCER_ID,
    },
    ...mapped,
  ];
}

export function readAgentShieldJson(path: string): OrrFinding[] {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return [
      {
        id: "harness.agentshield.missing",
        category: "engineering_craft",
        severity: "info",
        title: "AgentShield JSON not found",
        detail: `${path} was requested as an optional producer. Evidence only — not a PEP.`,
        evidence: abs,
        source_tool: AGENTSHIELD_PRODUCER_ID,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return [
      {
        id: "harness.agentshield.unreadable",
        category: "engineering_craft",
        severity: "low",
        title: "AgentShield JSON unreadable",
        detail: "Could not parse --agentshield-json file. ORR stays observational.",
        evidence: abs,
        source_tool: AGENTSHIELD_PRODUCER_ID,
      },
    ];
  }
  return ingestAgentShieldReport(parsed);
}

export function tryRunAgentShieldCli(
  targetPath: string,
  spawn?: AgentShieldSpawnFn,
): { findings: OrrFinding[] } | { gap: OrrCoverageGap } {
  const run = spawn ?? defaultAgentShieldSpawn;
  const abs = resolve(targetPath);
  const { command, args } = buildAgentShieldArgv(abs);
  let result: AgentShieldSpawnResult;
  try {
    result = run(command, args, {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return { gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "binary_not_found" } };
    }
    return { gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "error_non_fatal" } };
  }
  if (result.error?.code === "ENOENT") {
    return { gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "binary_not_found" } };
  }
  const stdout = bufferToString(result.stdout);
  const parsed = tryParseJson(stdout);
  if (parsed === undefined) {
    return { gap: { adapter_id: AGENTSHIELD_PRODUCER_ID, reason: "error_non_fatal" } };
  }
  return { findings: ingestAgentShieldReport(parsed) };
}

function defaultAgentShieldSpawn(
  command: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
): AgentShieldSpawnResult {
  return spawnSync(command, [...args], {
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide,
    shell: false,
    env: sanitizedScorecardEnv(process.env),
  });
}

function bufferToString(value: string | Buffer): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isNoise(id: string, title: string, category: string): boolean {
  const blob = `${id} ${title}`.toLowerCase();
  if (/observation[-_ ]hook|continuous-learning|homunculus|instinct-/.test(blob)) {
    return true;
  }
  if (/^skills?-/.test(id) || /skill prompt/.test(blob)) return true;
  if (category === "mcp" && /missing description/.test(blob)) return true;
  return false;
}

function mapOrrCategory(asCategory: string): string {
  switch (asCategory) {
    case "secrets":
      return "security_platform";
    case "permissions":
    case "mcp":
      return "agent_control_plane";
    case "hooks":
    case "misconfiguration":
      return "engineering_craft";
    case "agents":
    case "injection":
    case "exposure":
    case "exfiltration":
      return "product_architecture";
    default:
      return "engineering_craft";
  }
}

const SEVERITY_RANK: readonly OrrSeverity[] = ["info", "low", "medium", "high"];

function mapOrrSeverity(
  asCategory: string,
  conf: string,
  evidence: string,
  fixBefore: string,
  asSeverity: string,
): OrrSeverity {
  if (asCategory === "secrets") {
    return secretsValueLooksReal(evidence, fixBefore) ? "high" : "info";
  }
  if (LOW_CONFIDENCE.has(conf)) return "info";
  const mapped: OrrSeverity =
    asCategory === "permissions" || asCategory === "mcp" ? "medium" : "low";
  return minSeverity(mapped, capFromAgentShieldSeverity(asSeverity));
}

function capFromAgentShieldSeverity(asSeverity: string): OrrSeverity {
  switch (asSeverity) {
    case "critical":
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "info":
      return "info";
    default:
      return "medium";
  }
}

function minSeverity(a: OrrSeverity, b: OrrSeverity): OrrSeverity {
  return SEVERITY_RANK.indexOf(a) <= SEVERITY_RANK.indexOf(b) ? a : b;
}

function stableFindingId(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.startsWith("harness.agentshield.")) return slug;
  return `${AGENTSHIELD_PRODUCER_ID}.${slug || "finding"}`;
}
