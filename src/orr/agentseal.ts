/**
 * Optional ORR producer for getagentseal/agentseal (CLI `agentseal`).
 * Evidence only — never a PEP. Never vendors AgentSeal (FSL-1.1); operator installs the binary.
 * Never ALLOW from trust score. Never spawn their `shield` watcher as our product surface.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { OrrCoverageGap, OrrFinding, OrrSeverity } from "../commands/orr.js";
import { redactEvidence } from "./agentshield.js";
import { sanitizedScorecardEnv } from "./scorecard.js";

export const AGENTSEAL_PRODUCER_ID = "harness.agentseal";

export const FORBIDDEN_AGENTSEAL_SPAWN_TOKENS = [
  "shield", // their desktop watcher — name collision; not our product
  "--fix",
  "npx",
  "-y",
  "scan-mcp", // operator runs scan-mcp themselves; ORR only ingests JSON/SARIF
] as const;

export interface AgentSealSpawnResult {
  readonly status: number | null;
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
  readonly error?: NodeJS.ErrnoException;
}

export type AgentSealSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
) => AgentSealSpawnResult;

/** Spawn only `agentseal guard`. scan-mcp is operator-run → `--agentseal-json`. */
export function buildAgentSealArgv(absPath: string): {
  command: "agentseal";
  args: readonly string[];
} {
  return {
    command: "agentseal",
    args: ["guard", "--output", "json", "--path", absPath],
  };
}

/** Reject argv that would invoke forbidden tokens (defense in depth). */
export function assertSafeAgentSealArgv(args: readonly string[]): void {
  const lower = args.map((a) => a.toLowerCase());
  for (const tok of FORBIDDEN_AGENTSEAL_SPAWN_TOKENS) {
    if (lower.includes(tok.toLowerCase())) {
      throw new Error(`forbidden agentseal spawn token: ${tok}`);
    }
  }
}

export function mapAgentSealFinding(raw: unknown): OrrFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;

  const idRaw =
    (typeof rec.id === "string" && rec.id.trim()) ||
    (typeof rec.ruleId === "string" && rec.ruleId.trim()) ||
    (typeof rec.check_id === "string" && rec.check_id.trim()) ||
    "";
  const titleRaw =
    (typeof rec.title === "string" && rec.title.trim()) ||
    (typeof rec.message === "string" && rec.message.trim()) ||
    (typeof rec.name === "string" && rec.name.trim()) ||
    "";
  if (!idRaw && !titleRaw) return null;

  const title = titleRaw || idRaw;
  const description =
    (typeof rec.description === "string" && rec.description) ||
    (typeof rec.detail === "string" && rec.detail) ||
    (typeof rec.message === "string" && rec.message !== titleRaw ? rec.message : "") ||
    "";
  const evidenceRaw =
    (typeof rec.evidence === "string" && rec.evidence) ||
    (typeof rec.file === "string" && rec.file) ||
    (typeof rec.path === "string" && rec.path) ||
    "";
  const categoryRaw =
    (typeof rec.category === "string" && rec.category) ||
    (typeof rec.kind === "string" && rec.kind) ||
    "";
  const severityRaw =
    (typeof rec.severity === "string" && rec.severity) ||
    (typeof rec.level === "string" && rec.level) ||
    "";

  return {
    id: stableFindingId(idRaw || title),
    category: mapOrrCategory(categoryRaw, title),
    severity: mapOrrSeverity(severityRaw, categoryRaw),
    title: redactEvidence(title),
    detail: redactEvidence(description || title),
    evidence: redactEvidence(
      evidenceRaw || `${AGENTSEAL_PRODUCER_ID}:${idRaw || title}`,
    ),
    source_tool: AGENTSEAL_PRODUCER_ID,
  };
}

export function ingestAgentSealReport(parsed: unknown): OrrFinding[] {
  const mapped = collectRawFindings(parsed)
    .map(mapAgentSealFinding)
    .filter((f): f is OrrFinding => f !== null);

  const trust =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).trust_score ??
        (parsed as Record<string, unknown>).trustScore
      : undefined;
  const trustNote =
    typeof trust === "number"
      ? ` Trust score ${trust} is observe-only and never authorizes a write.`
      : "";

  return [
    {
      id: "harness.agentseal.ingested",
      category: "engineering_craft",
      severity: "info",
      title: "AgentSeal report ingested as evidence",
      detail: `${mapped.length} finding(s) mapped. Evidence only — not a PEP.${trustNote}`,
      evidence: "harness.agentseal JSON/SARIF ingest",
      source_tool: AGENTSEAL_PRODUCER_ID,
    },
    ...mapped,
  ];
}

export function readAgentSealJson(path: string): OrrFinding[] {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return [
      {
        id: "harness.agentseal.missing",
        category: "engineering_craft",
        severity: "info",
        title: "AgentSeal JSON not found",
        detail: `${path} was requested as an optional producer. Evidence only — not a PEP.`,
        evidence: abs,
        source_tool: AGENTSEAL_PRODUCER_ID,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return [
      {
        id: "harness.agentseal.unreadable",
        category: "engineering_craft",
        severity: "low",
        title: "AgentSeal JSON unreadable",
        detail: "Could not parse --agentseal-json file. ORR stays observational.",
        evidence: abs,
        source_tool: AGENTSEAL_PRODUCER_ID,
      },
    ];
  }
  return ingestAgentSealReport(parsed);
}

export function tryRunAgentSealCli(
  targetPath: string,
  spawn?: AgentSealSpawnFn,
): { findings: OrrFinding[] } | { gap: OrrCoverageGap } {
  const run = spawn ?? defaultAgentSealSpawn;
  const abs = resolve(targetPath);
  const { command, args } = buildAgentSealArgv(abs);
  try {
    assertSafeAgentSealArgv(args);
  } catch {
    return { gap: { adapter_id: AGENTSEAL_PRODUCER_ID, reason: "error_non_fatal" } };
  }
  let result: AgentSealSpawnResult;
  try {
    result = run(command, args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return { gap: { adapter_id: AGENTSEAL_PRODUCER_ID, reason: "binary_not_found" } };
    }
    return { gap: { adapter_id: AGENTSEAL_PRODUCER_ID, reason: "error_non_fatal" } };
  }
  if (result.error?.code === "ENOENT") {
    return { gap: { adapter_id: AGENTSEAL_PRODUCER_ID, reason: "binary_not_found" } };
  }
  const stdout = bufferToString(result.stdout);
  const parsed = tryParseJson(stdout);
  if (parsed === undefined) {
    return { gap: { adapter_id: AGENTSEAL_PRODUCER_ID, reason: "error_non_fatal" } };
  }
  return { findings: ingestAgentSealReport(parsed) };
}

function defaultAgentSealSpawn(
  command: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
): AgentSealSpawnResult {
  return spawnSync(command, [...args], {
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide,
    shell: false,
    env: sanitizedScorecardEnv(process.env),
  });
}

function collectRawFindings(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.findings)) return obj.findings;
  if (Array.isArray(obj.issues)) return obj.issues;
  if (Array.isArray(obj.results)) return obj.results;

  // SARIF 2.1
  if (Array.isArray(obj.runs)) {
    const out: unknown[] = [];
    for (const run of obj.runs) {
      if (!run || typeof run !== "object") continue;
      const results = (run as Record<string, unknown>).results;
      if (!Array.isArray(results)) continue;
      for (const r of results) {
        if (!r || typeof r !== "object") continue;
        const rec = r as Record<string, unknown>;
        const msg =
          rec.message && typeof rec.message === "object"
            ? (rec.message as Record<string, unknown>).text
            : undefined;
        const loc = Array.isArray(rec.locations) ? rec.locations[0] : undefined;
        let file = "";
        if (loc && typeof loc === "object") {
          const pl = (loc as Record<string, unknown>).physicalLocation;
          if (pl && typeof pl === "object") {
            const art = (pl as Record<string, unknown>).artifactLocation;
            if (art && typeof art === "object") {
              file = String((art as Record<string, unknown>).uri ?? "");
            }
          }
        }
        out.push({
          id: typeof rec.ruleId === "string" ? rec.ruleId : "sarif",
          title: typeof msg === "string" ? msg : String(rec.ruleId ?? "sarif finding"),
          severity: typeof rec.level === "string" ? rec.level : "warning",
          category: "mcp",
          file,
          evidence: file,
        });
      }
    }
    return out;
  }

  return [];
}

function mapOrrCategory(categoryRaw: string, title: string): string {
  const blob = `${categoryRaw} ${title}`.toLowerCase();
  if (/secret|credential|key|token/.test(blob)) return "security_platform";
  if (/mcp|tool.?poison|toxic|exfil|skill|supply.?chain|rug.?pull/.test(blob)) {
    return "agent_control_plane";
  }
  if (/inject|prompt|extract|jailbreak/.test(blob)) return "product_architecture";
  if (/packag|dependenc|npm|pypi/.test(blob)) return "packaging_supply_chain";
  return "engineering_craft";
}

function mapOrrSeverity(severityRaw: string, categoryRaw: string): OrrSeverity {
  switch (severityRaw.toLowerCase()) {
    case "critical":
    case "error":
      return "high";
    case "high":
      return "high";
    case "medium":
    case "warning":
      return "medium";
    case "low":
    case "note":
      return "low";
    case "info":
      return "info";
    default:
      break;
  }
  if (/mcp|poison|exfil|secret/i.test(categoryRaw)) return "medium";
  return "low";
}

function stableFindingId(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.startsWith("harness.agentseal.")) return slug;
  return `${AGENTSEAL_PRODUCER_ID}.${slug || "finding"}`;
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
