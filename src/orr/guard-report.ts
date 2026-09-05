/**
 * Optional ORR producer: ingest a guard / SARIF JSON report as evidence.
 * Evidence only — never a PEP. No third-party product names on the CLI surface.
 * Ingest only (no external binary spawn).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { OrrFinding, OrrSeverity } from "../commands/orr.js";
import { redactEvidence } from "./agentshield.js";

export const GUARD_REPORT_PRODUCER_ID = "harness.guard_report";

export function mapGuardReportFinding(raw: unknown): OrrFinding | null {
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
      evidenceRaw || `${GUARD_REPORT_PRODUCER_ID}:${idRaw || title}`,
    ),
    source_tool: GUARD_REPORT_PRODUCER_ID,
  };
}

export function ingestGuardReport(parsed: unknown): OrrFinding[] {
  const mapped = collectRawFindings(parsed)
    .map(mapGuardReportFinding)
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
      id: "harness.guard_report.ingested",
      category: "engineering_craft",
      severity: "info",
      title: "Guard report ingested as evidence",
      detail: `${mapped.length} finding(s) mapped. Evidence only — not a PEP.${trustNote}`,
      evidence: "harness.guard_report JSON/SARIF ingest",
      source_tool: GUARD_REPORT_PRODUCER_ID,
    },
    ...mapped,
  ];
}

export function readGuardReportJson(path: string): OrrFinding[] {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return [
      {
        id: "harness.guard_report.missing",
        category: "engineering_craft",
        severity: "info",
        title: "Guard report JSON not found",
        detail: `${path} was requested as an optional producer. Evidence only — not a PEP.`,
        evidence: abs,
        source_tool: GUARD_REPORT_PRODUCER_ID,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return [
      {
        id: "harness.guard_report.unreadable",
        category: "engineering_craft",
        severity: "low",
        title: "Guard report JSON unreadable",
        detail: "Could not parse --guard-json file. ORR stays observational.",
        evidence: abs,
        source_tool: GUARD_REPORT_PRODUCER_ID,
      },
    ];
  }
  return ingestGuardReport(parsed);
}

function collectRawFindings(parsed: unknown): unknown[] {
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.findings)) return obj.findings;
  if (Array.isArray(obj.issues)) return obj.issues;
  if (Array.isArray(obj.results)) return obj.results;

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
  if (slug.startsWith("harness.guard_report.")) return slug;
  return `${GUARD_REPORT_PRODUCER_ID}.${slug || "finding"}`;
}
