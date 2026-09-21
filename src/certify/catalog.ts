/**
 * Agent Trust Baseline catalog: types, loader, validator.
 * The bundled catalog/agent-trust-baseline-v0.json at the package root is the
 * source of truth (shipped via package.json "files"). Evidence only — a
 * catalog requirement never ALLOWs anything.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UsageError } from "../errors.js";

export type RequirementSeverity = "critical" | "high" | "medium" | "low";

export interface TrailMatch {
  readonly verdict?: string;
  readonly reasonCode?: string;
  readonly mode?: "observe" | "hold" | "offline";
  readonly neverEvent?: boolean;
}

export type RequirementCheck =
  | { readonly kind: "config_mode"; readonly not: "observe" }
  | { readonly kind: "hooks_wired"; readonly min: number }
  | { readonly kind: "trail_zero"; readonly windowDays: number; readonly match: TrailMatch }
  | { readonly kind: "trail_min"; readonly windowDays: number; readonly match: TrailMatch; readonly min: number }
  | { readonly kind: "trail_ratio"; readonly windowDays: number; readonly match: TrailMatch; readonly maxRatio: number }
  | { readonly kind: "orr_overall"; readonly max: "green" | "amber" }
  | { readonly kind: "orr_category"; readonly id: string; readonly max: "green" | "amber" }
  | { readonly kind: "orr_fresh"; readonly maxAgeDays: number }
  | { readonly kind: "sandbox_inventory"; readonly min: number }
  | { readonly kind: "receipts_present"; readonly min: number }
  | { readonly kind: "showback_present" }
  | { readonly kind: "attest"; readonly prompt: string };

export interface CatalogRequirement {
  readonly id: string;
  readonly domain: string;
  readonly title: string;
  readonly text: string;
  readonly severity: RequirementSeverity;
  readonly check: RequirementCheck;
}

export interface Catalog {
  readonly id: string;
  readonly version: string;
  readonly updated: string;
  readonly domains: readonly string[];
  readonly requirements: readonly CatalogRequirement[];
}

export const MAX_CATALOG_BYTES = 512 * 1024;

const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);
const CHECK_KINDS = new Set<string>([
  "config_mode",
  "hooks_wired",
  "trail_zero",
  "trail_min",
  "trail_ratio",
  "orr_overall",
  "orr_category",
  "orr_fresh",
  "sandbox_inventory",
  "receipts_present",
  "showback_present",
  "attest",
]);
const ORR_MAX = new Set<string>(["green", "amber"]);
const TRAIL_MODES = new Set<string>(["observe", "hold", "offline"]);
const REQ_ID = /^[A-Z]+-\d+$/;

/** Bundled catalog: <pkg>/catalog/… — works from both src/ (vitest) and dist/ (built). */
export function defaultCatalogPath(): string {
  return fileURLToPath(
    new URL("../../catalog/agent-trust-baseline-v0.json", import.meta.url),
  );
}

export function loadCatalog(path?: string): Catalog {
  const file = path ?? defaultCatalogPath();
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new UsageError(`catalog not found: ${file}`);
  }
  if (statSync(file).size > MAX_CATALOG_BYTES) {
    throw new UsageError(`catalog exceeds ${MAX_CATALOG_BYTES} bytes: ${file}`);
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`catalog is not readable: ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError(`catalog is not valid JSON: ${file}`);
  }
  return validateCatalog(raw);
}

function reqErr(id: string, msg: string): UsageError {
  return new UsageError(`catalog requirement ${id}: ${msg}`);
}

function posInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseMatch(id: string, raw: unknown): TrailMatch {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw reqErr(id, "match must be an object");
  }
  const m = raw as Record<string, unknown>;
  const out: {
    verdict?: string;
    reasonCode?: string;
    mode?: "observe" | "hold" | "offline";
    neverEvent?: boolean;
  } = {};
  if (m.verdict !== undefined) {
    if (!nonEmpty(m.verdict)) throw reqErr(id, "match.verdict must be a non-empty string");
    out.verdict = m.verdict;
  }
  if (m.reasonCode !== undefined) {
    if (!nonEmpty(m.reasonCode)) throw reqErr(id, "match.reasonCode must be a non-empty string");
    out.reasonCode = m.reasonCode;
  }
  if (m.mode !== undefined) {
    if (typeof m.mode !== "string" || !TRAIL_MODES.has(m.mode)) {
      throw reqErr(id, "match.mode must be observe|hold|offline");
    }
    out.mode = m.mode as TrailMatch["mode"];
  }
  if (m.neverEvent !== undefined) {
    if (typeof m.neverEvent !== "boolean") throw reqErr(id, "match.neverEvent must be boolean");
    out.neverEvent = m.neverEvent;
  }
  return out;
}

function windowDaysOf(id: string, c: Record<string, unknown>): number {
  if (!posInt(c.windowDays)) throw reqErr(id, "trail checks require positive integer windowDays");
  return c.windowDays;
}

function minOf(id: string, c: Record<string, unknown>, kind: string): number {
  if (!posInt(c.min)) throw reqErr(id, `${kind} requires positive integer min`);
  return c.min;
}

function orrMaxOf(id: string, c: Record<string, unknown>): "green" | "amber" {
  if (typeof c.max !== "string" || !ORR_MAX.has(c.max)) {
    throw reqErr(id, 'orr checks require max "green" or "amber"');
  }
  return c.max as "green" | "amber";
}

function parseCheck(id: string, raw: unknown): RequirementCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw reqErr(id, "check must be an object");
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.kind !== "string" || !CHECK_KINDS.has(c.kind)) {
    throw reqErr(id, `unknown check kind ${JSON.stringify(c.kind)}`);
  }
  switch (c.kind) {
    case "config_mode":
      if (c.not !== "observe") {
        throw reqErr(id, 'config_mode requires not:"observe"');
      }
      return { kind: "config_mode", not: "observe" };
    case "hooks_wired":
      return { kind: "hooks_wired", min: minOf(id, c, "hooks_wired") };
    case "sandbox_inventory":
      return { kind: "sandbox_inventory", min: minOf(id, c, "sandbox_inventory") };
    case "receipts_present":
      return { kind: "receipts_present", min: minOf(id, c, "receipts_present") };
    case "trail_zero":
      return {
        kind: "trail_zero",
        windowDays: windowDaysOf(id, c),
        match: parseMatch(id, c.match),
      };
    case "trail_min":
      return {
        kind: "trail_min",
        windowDays: windowDaysOf(id, c),
        match: parseMatch(id, c.match),
        min: minOf(id, c, "trail_min"),
      };
    case "trail_ratio": {
      const maxRatio = c.maxRatio;
      if (typeof maxRatio !== "number" || !(maxRatio > 0) || maxRatio > 1) {
        throw reqErr(id, "trail_ratio requires 0 < maxRatio <= 1");
      }
      return {
        kind: "trail_ratio",
        windowDays: windowDaysOf(id, c),
        match: parseMatch(id, c.match),
        maxRatio,
      };
    }
    case "orr_overall":
      return { kind: "orr_overall", max: orrMaxOf(id, c) };
    case "orr_category": {
      if (!nonEmpty(c.id)) throw reqErr(id, "orr_category requires non-empty id");
      return { kind: "orr_category", id: c.id, max: orrMaxOf(id, c) };
    }
    case "orr_fresh": {
      if (!posInt(c.maxAgeDays)) throw reqErr(id, "orr_fresh requires positive integer maxAgeDays");
      return { kind: "orr_fresh", maxAgeDays: c.maxAgeDays };
    }
    case "showback_present":
      return { kind: "showback_present" };
    case "attest": {
      if (!nonEmpty(c.prompt)) throw reqErr(id, "attest requires non-empty prompt");
      // Prompts are interpolated into one-line evidence — no control chars.
      if (/[\x00-\x1f\x7f]/.test(c.prompt)) {
        throw reqErr(id, "attest prompt must not contain control characters");
      }
      return { kind: "attest", prompt: c.prompt };
    }
  }
  // Unreachable: kind membership checked above.
  throw reqErr(id, `unknown check kind ${JSON.stringify(c.kind)}`);
}

export function validateCatalog(raw: unknown): Catalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError("catalog root must be an object");
  }
  const c = raw as Record<string, unknown>;
  for (const k of ["id", "version", "updated"] as const) {
    if (!nonEmpty(c[k])) throw new UsageError(`catalog.${k} must be a non-empty string`);
  }
  if (
    !Array.isArray(c.domains) ||
    c.domains.length === 0 ||
    !c.domains.every((d) => typeof d === "string" && d.length > 0)
  ) {
    throw new UsageError("catalog.domains must be a non-empty string array");
  }
  if (!Array.isArray(c.requirements) || c.requirements.length === 0) {
    throw new UsageError("catalog.requirements must be a non-empty array");
  }
  const domains = c.domains as string[];
  const domainSet = new Set(domains);
  const seen = new Set<string>();
  const requirements: CatalogRequirement[] = [];
  for (const item of c.requirements) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new UsageError("catalog requirement must be an object");
    }
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    if (!REQ_ID.test(id)) {
      throw new UsageError(
        `catalog requirement id must match ^[A-Z]+-\\d+$: ${JSON.stringify(rec.id)}`,
      );
    }
    if (seen.has(id)) throw new UsageError(`duplicate requirement id ${id}`);
    seen.add(id);
    if (typeof rec.domain !== "string" || !domainSet.has(rec.domain)) {
      throw reqErr(id, `unknown domain ${JSON.stringify(rec.domain)}`);
    }
    if (!nonEmpty(rec.title)) throw reqErr(id, "title required");
    if (!nonEmpty(rec.text)) throw reqErr(id, "text required");
    if (typeof rec.severity !== "string" || !SEVERITIES.has(rec.severity)) {
      throw reqErr(id, `bad severity ${JSON.stringify(rec.severity)}`);
    }
    requirements.push({
      id,
      domain: rec.domain,
      title: rec.title,
      text: rec.text,
      severity: rec.severity as RequirementSeverity,
      check: parseCheck(id, rec.check),
    });
  }
  return {
    id: c.id as string,
    version: c.version as string,
    updated: c.updated as string,
    domains,
    requirements,
  };
}
