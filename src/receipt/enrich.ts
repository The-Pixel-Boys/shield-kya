/**
 * Fail-safe loaders for the local Agent-activity report.
 * Every loader returns undefined (or an empty list) on missing, corrupt, or
 * oversize state and never throws — the report renders with zero optional
 * state. Nothing here ever reads .kya/receipt-server.json (loopback token).
 */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { computeLiveCertify } from "../certify/live.js";
import type { RequirementSeverity } from "../certify/catalog.js";
import { CONNECT_REGISTRY, type HostSpec } from "../commands/connect.js";
import type { OrrDisposition, OrrRating, OrrReport } from "../commands/orr.js";
import type { KyaFileConfig } from "../config.js";
import {
  hostReload,
  hostRunning,
  listProcessNames,
  type HostReload,
} from "../host-reload.js";
import type { SandboxRecord } from "../sandbox/types.js";
import {
  buildShowback,
  type ShowbackReport,
} from "../showback/cost-per-task.js";
import {
  MAX_USAGE_FILE_BYTES,
  parseUsageFilePayload,
} from "../showback/usage-file.js";

const MAX_ORR_REPORT_BYTES = 256 * 1024;
const MAX_ORR_TEXT_CHARS = 500;
const MAX_HOST_CONFIG_BYTES = 1024 * 1024;

function insideRoot(file: string, root: string): boolean {
  const a = resolve(file);
  const b = resolve(root);
  const prefix = b.endsWith(sep) ? b : b + sep;
  return a === b || a.startsWith(prefix);
}

/** Resolve a file strictly inside root; refuse symlinks and escapes. */
function confinedFile(file: string, root: string): string | undefined {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    const realFile = realpathSync(file);
    const realRoot = realpathSync(root);
    if (!insideRoot(realFile, realRoot)) return undefined;
    return realFile;
  } catch {
    return undefined;
  }
}

const MAX_CWD_STATE_BYTES = 1024 * 1024;

/**
 * Parse a JSON file strictly inside cwd: symlink refusal, realpath jail,
 * regular-file check, size cap. Returns undefined on any failure.
 */
function readConfinedJsonFile(
  cwd: string,
  relPath: string,
  maxBytes: number,
): unknown | undefined {
  const path = confinedFile(join(cwd, relPath), cwd);
  if (!path) return undefined;
  try {
    if (statSync(path).size > maxBytes) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Local identity from .kya/config.json; config.json never holds the API key.
 * Only string fields pass through; baseUrl is inert display text (never a link). */
export function loadIdentity(cwd: string): KyaFileConfig | undefined {
  const raw = readConfinedJsonFile(cwd, join(".kya", "config.json"), MAX_CWD_STATE_BYTES);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["agentId", "agentName", "host", "baseUrl"] as const) {
    const v = source[key];
    if (typeof v !== "string" || !v.trim()) continue;
    if (key === "host" && v !== "ide" && v !== "runtime") continue;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? (out as KyaFileConfig) : undefined;
}

export interface SandboxCard {
  /** Configured backend from KYA_SANDBOX, when set. */
  readonly backend: string | undefined;
  readonly sandboxes: readonly SandboxRecord[];
}

export function loadSandboxes(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): SandboxCard {
  const backend = env.KYA_SANDBOX?.trim().toLowerCase() || undefined;
  const raw = readConfinedJsonFile(cwd, join(".kya", "sandboxes.json"), MAX_CWD_STATE_BYTES);
  const sandboxes: SandboxRecord[] = Array.isArray(raw) ? (raw as SandboxRecord[]) : [];
  return { backend, sandboxes };
}

export interface OrrScorecardCounts {
  readonly pass: number;
  readonly fail: number;
  readonly partial: number;
  readonly notEvaluated: number;
}

export interface OrrCard {
  readonly overall: OrrRating;
  readonly disposition: OrrDisposition;
  readonly primaryFailureMode: string;
  readonly mostUrgentFix: string;
  readonly generatedAt: string;
  readonly targetName: string | undefined;
  readonly scorecards: OrrScorecardCounts;
}

const ORR_RATINGS = new Set<string>(["green", "amber", "red"]);
const ORR_DISPOSITIONS = new Set<string>(["go", "conditional", "no_go"]);

function strOr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Slim ORR card from <cwd>/orr-report/report.json (default orr --out). */
export function loadOrrCard(cwd: string): OrrCard | undefined {
  const raw = readConfinedJsonFile(
    cwd,
    join("orr-report", "report.json"),
    MAX_ORR_REPORT_BYTES,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const report = raw as Partial<OrrReport>;
  if (
    typeof report.overall !== "string" ||
    !ORR_RATINGS.has(report.overall) ||
    typeof report.disposition !== "string" ||
    !ORR_DISPOSITIONS.has(report.disposition)
  ) {
    return undefined;
  }
  const counts = { pass: 0, fail: 0, partial: 0, notEvaluated: 0 };
  if (Array.isArray(report.scorecards)) {
    for (const card of report.scorecards) {
      switch ((card as { result?: unknown } | null)?.result) {
        case "pass":
          counts.pass += 1;
          break;
        case "fail":
          counts.fail += 1;
          break;
        case "partial":
          counts.partial += 1;
          break;
        case "not_evaluated":
          counts.notEvaluated += 1;
          break;
      }
    }
  }
  const targetName =
    report.target && typeof report.target.name === "string"
      ? report.target.name.slice(0, MAX_ORR_TEXT_CHARS)
      : undefined;
  return {
    overall: report.overall,
    disposition: report.disposition,
    primaryFailureMode: strOr(report.primary_failure_mode).slice(0, MAX_ORR_TEXT_CHARS),
    mostUrgentFix: strOr(report.most_urgent_fix).slice(0, MAX_ORR_TEXT_CHARS),
    generatedAt: strOr(report.generated_at),
    targetName,
    scorecards: counts,
  };
}

/**
 * Per-category ratings from <cwd>/orr-report/report.json — sibling of the slim
 * OrrCard for consumers that need category granularity (certify). Same
 * confined-read pattern; invalid entries are dropped, not fatal.
 */
export function loadOrrCategoryRatings(
  cwd: string,
): Record<string, OrrRating> | undefined {
  const raw = readConfinedJsonFile(
    cwd,
    join("orr-report", "report.json"),
    MAX_ORR_REPORT_BYTES,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const categories = (raw as Partial<OrrReport>).categories;
  if (!Array.isArray(categories)) return undefined;
  const out: Record<string, OrrRating> = {};
  for (const c of categories) {
    const id = (c as { id?: unknown } | null)?.id;
    const rating = (c as { rating?: unknown } | null)?.rating;
    if (typeof id === "string" && typeof rating === "string" && ORR_RATINGS.has(rating)) {
      out[id] = rating as OrrRating;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface CertifyCard {
  readonly result: "pass" | "gap";
  readonly pass: number;
  readonly gap: number;
  readonly insufficientEvidence: number;
  readonly attested: number;
  readonly windowDays: number;
  readonly trailEvents: number;
  readonly topGaps: readonly { id: string; severity: RequirementSeverity }[];
}

const CERTIFY_SEVERITY_RANK: Record<RequirementSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Live Agent Trust Baseline card, recomputed from local evidence on every
 * call via computeLiveCertify (read-only, no writes). Fail-safe like every
 * loader here: any internal error yields undefined, never a throw — the
 * report renders without the panel rather than not at all.
 */
export function loadCertifyCard(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): CertifyCard | undefined {
  try {
    const report = computeLiveCertify(cwd, env, 30);
    const topGaps = report.requirements
      .filter((r) => r.status === "gap")
      .map((r) => ({ id: r.id, severity: r.severity }))
      .sort(
        (a, b) =>
          CERTIFY_SEVERITY_RANK[a.severity] - CERTIFY_SEVERITY_RANK[b.severity] ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 5);
    return {
      result: report.overall.result,
      pass: report.overall.pass,
      gap: report.overall.gap,
      insufficientEvidence: report.overall.insufficientEvidence,
      attested: report.overall.attested,
      windowDays: report.window.days,
      trailEvents: report.trail.eventCount,
      topGaps,
    };
  } catch {
    return undefined;
  }
}

/** Observe-only showback from .kya/usage.json inside cwd. */
export function loadShowbackCard(cwd: string): ShowbackReport | undefined {
  const raw = readConfinedJsonFile(cwd, join(".kya", "usage.json"), MAX_USAGE_FILE_BYTES);
  if (raw === undefined) return undefined;
  try {
    const records = parseUsageFilePayload(raw);
    if (records.length === 0) return undefined;
    return buildShowback(records);
  } catch {
    return undefined;
  }
}

export type WiredState = "global" | "project" | "both" | "none";

export interface WiredHostRow {
  readonly id: string;
  readonly label: string;
  readonly wired: WiredState;
  readonly reload: HostReload | undefined;
  readonly running: boolean;
  /** Docs recipe path for hosts with no safe auto-wire. */
  readonly recipeOnly: string | undefined;
}

function hasWiredEntry(path: string, spec: HostSpec): boolean {
  try {
    // statSync follows symlinks on purpose (dotfile setups symlink host
    // configs) — but only regular files are ever read: FIFOs, devices and
    // sockets would block or stream forever.
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_HOST_CONFIG_BYTES) return false;
    const text = readFileSync(path, "utf8");
    if (spec.shape === "grok-toml") {
      return /^\s*\[mcp_servers\.shield-kya\]\s*(?:#.*)?$/m.test(text);
    }
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const servers = (raw as Record<string, unknown>)[spec.rootKey];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return false;
    }
    return Boolean((servers as Record<string, unknown>)["shield-kya"]);
  } catch {
    return false;
  }
}

export function loadWiredHosts(
  cwd: string,
  home: string = process.env.KYA_HOME?.trim() || homedir(),
  procs?: ReadonlySet<string>,
): WiredHostRow[] {
  const running = procs ?? listProcessNames();
  return Object.entries(CONNECT_REGISTRY).map(([id, spec]): WiredHostRow => {
    const reload = hostReload(id);
    const isRunning = reload ? hostRunning(reload, running) : false;
    // recipeOnly hosts have no verified config file — never probe for one.
    if (spec.recipeOnly) {
      return {
        id,
        label: spec.label,
        wired: "none",
        reload,
        running: isRunning,
        recipeOnly: spec.recipeOnly,
      };
    }
    const globalWired = spec.globalPath
      ? hasWiredEntry(spec.globalPath(home), spec)
      : false;
    const projectWired = spec.projectPath
      ? hasWiredEntry(spec.projectPath(cwd), spec)
      : false;
    const wired: WiredState =
      globalWired && projectWired
        ? "both"
        : globalWired
          ? "global"
          : projectWired
            ? "project"
            : "none";
    return {
      id,
      label: spec.label,
      wired,
      reload,
      running: isRunning,
      recipeOnly: undefined,
    };
  });
}
