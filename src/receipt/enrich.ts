/**
 * Fail-safe loaders for the local Agent-activity report.
 * Every loader returns undefined (or an empty list) on missing, corrupt, or
 * oversize state and never throws — the report renders with zero optional
 * state. Nothing here ever reads .kya/receipt-server.json (loopback token).
 */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CONNECT_REGISTRY } from "../commands/connect.js";
import type { OrrDisposition, OrrRating, OrrReport } from "../commands/orr.js";
import { readFileConfig, type KyaFileConfig } from "../config.js";
import {
  hostReload,
  hostRunning,
  listProcessNames,
  type HostReload,
} from "../host-reload.js";
import { loadSandboxState } from "../sandbox/runtime.js";
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

/** Local identity from .kya/config.json; config.json never holds the API key.
 * Only string fields pass through; baseUrl is inert display text (never a link). */
export function loadIdentity(cwd: string): KyaFileConfig | undefined {
  try {
    const raw = readFileConfig(cwd) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of ["agentId", "agentName", "host", "baseUrl"] as const) {
      const v = raw[key];
      if (typeof v !== "string" || !v.trim()) continue;
      if (key === "host" && v !== "ide" && v !== "runtime") continue;
      out[key] = v;
    }
    return Object.keys(out).length > 0 ? (out as KyaFileConfig) : undefined;
  } catch {
    return undefined;
  }
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
  let sandboxes: SandboxRecord[] = [];
  try {
    sandboxes = loadSandboxState(cwd);
  } catch {
    sandboxes = [];
  }
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
  const path = confinedFile(join(cwd, "orr-report", "report.json"), cwd);
  if (!path) return undefined;
  try {
    if (statSync(path).size > MAX_ORR_REPORT_BYTES) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
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
  } catch {
    return undefined;
  }
}

/** Observe-only showback from .kya/usage.json inside cwd. */
export function loadShowbackCard(cwd: string): ShowbackReport | undefined {
  const path = confinedFile(join(cwd, ".kya", "usage.json"), cwd);
  if (!path) return undefined;
  try {
    if (statSync(path).size > MAX_USAGE_FILE_BYTES) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
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

function hasWiredEntry(path: string, rootKey: string): boolean {
  try {
    if (statSync(path).size > MAX_HOST_CONFIG_BYTES) return false;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const servers = (raw as Record<string, unknown>)[rootKey];
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
  home: string = homedir(),
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
      ? hasWiredEntry(spec.globalPath(home), spec.rootKey)
      : false;
    const projectWired = spec.projectPath
      ? hasWiredEntry(spec.projectPath(cwd), spec.rootKey)
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
