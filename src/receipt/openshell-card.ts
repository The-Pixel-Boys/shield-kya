/**
 * OpenShell card for the live Agent-activity report (NVIDIA OpenShell,
 * github.com/NVIDIA/OpenShell). One dedicated panel aggregating the three
 * places OpenShell shows up today: imported openshell trail events
 * (reasonCode OPENSHELL_POLICY, toolId openshell.network / openshell.http),
 * openshell-backend sandbox rows in .kya/sandboxes.json, and the locally
 * detected openshell CLI / openshell-prover binaries.
 *
 * Fail-safe like every enrich loader: the pure rollup never throws, every
 * runtime probe degrades to a "not detected" row on a missing binary, a
 * failing --version, or a missing file, and the loader returns undefined
 * (panel omitted entirely) when no OpenShell signal exists at all - fresh
 * installs must not see the panel. The SAFE-06 certify outcome is reused
 * from the already-computed certify card, never recomputed here.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { OPENSHELL_MIN_VERSION } from "../sandbox/openshell-driver.js";
import { openshellPolicyPath } from "../sandbox/openshell-policy.js";
import { resolveOpenshellProver } from "../certify/openshell-prover.js";
import { loadSandboxState } from "../sandbox/runtime.js";
import type { TrailEvent } from "../trail.js";

const OPENSHELL_TOOLS = new Set(["openshell.network", "openshell.http"]);
const MAX_DST_LEN = 80;
const TOP_DESTINATIONS = 5;

export interface OpenshellDestinationRow {
  readonly dst: string;
  readonly count: number;
}

/** Pure rollup of openshell trail events; undefined when there are none. */
export interface OpenshellActivity {
  readonly total: number;
  readonly deny: number;
  readonly allow: number;
  /** toolId openshell.network count. */
  readonly network: number;
  /** toolId openshell.http count. */
  readonly http: number;
  /** Top 5 destinations parsed from event summaries, sorted desc then dst asc. */
  readonly topDestinations: readonly OpenshellDestinationRow[];
  /** ts of the newest openshell event ("" when none parse). */
  readonly lastTs: string;
}

export interface OpenshellSandboxRow {
  readonly sandboxId: string;
  readonly status: string;
  readonly createdAt: string;
  /** Backend-side name, when the backend keeps its own. */
  readonly externalName: string | undefined;
  /** .kya/openshell/policy-<sandboxId>.yaml exists on disk. */
  readonly policyFile: boolean;
}

export interface OpenshellSafe06 {
  /** Certify requirement status for SAFE-06 (pass, gap, insufficient_evidence, attested). */
  readonly status: string;
  /** Redacted one-liner from the certify evaluation; safe for reports. */
  readonly evidence: string;
}

export interface OpenshellRuntime {
  readonly cliFound: boolean;
  /** Parsed x.y.z from `openshell --version`; undefined when the probe failed. */
  readonly cliVersion: string | undefined;
  /** docker or podman when one is on PATH. */
  readonly containerRuntime: "docker" | "podman" | undefined;
  /** Pinned floor from OPENSHELL_MIN_VERSION. */
  readonly minVersion: string;
  readonly proverFound: boolean;
  /** SAFE-06 outcome reused from the certify card, when one was computed. */
  readonly safe06: OpenshellSafe06 | undefined;
}

export interface OpenshellCard {
  readonly activity: OpenshellActivity | undefined;
  readonly sandboxes: readonly OpenshellSandboxRow[];
  readonly runtime: OpenshellRuntime;
}

/** One report panel signal: an openshell tool or the OPENSHELL_POLICY reason. */
export function isOpenshellEvent(e: TrailEvent): boolean {
  return OPENSHELL_TOOLS.has(e.toolId) || e.reasonCode === "OPENSHELL_POLICY";
}

/**
 * The importer writes a redacted `dst: host:port` rendering into the event
 * summary; parse it defensively - summaries are user-editable trail data.
 */
function destinationFromSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const dst = /(?:^|\s)dst:\s*(\S+)/i.exec(summary.trim())?.[1]?.trim();
  if (!dst) return undefined;
  return dst.length <= MAX_DST_LEN ? dst : dst.slice(0, MAX_DST_LEN);
}

/** Pure rollup of openshell events for the panel's Policy activity card. */
export function aggregateOpenshellEvents(
  events: readonly TrailEvent[],
): OpenshellActivity | undefined {
  let total = 0;
  let deny = 0;
  let allow = 0;
  let network = 0;
  let http = 0;
  let lastTs = "";
  const dstCounts = new Map<string, number>();
  for (const e of events) {
    if (!isOpenshellEvent(e)) continue;
    total++;
    const v = e.verdict.toUpperCase();
    if (v === "DENY") deny++;
    else if (v === "ALLOW") allow++;
    if (e.toolId === "openshell.http") http++;
    else network++;
    if (e.ts > lastTs) lastTs = e.ts;
    const dst = destinationFromSummary(e.summary);
    if (dst) dstCounts.set(dst, (dstCounts.get(dst) ?? 0) + 1);
  }
  if (total === 0) return undefined;
  const topDestinations: OpenshellDestinationRow[] = [...dstCounts.entries()]
    .map(([dst, count]) => ({ dst, count }))
    .sort((a, b) => b.count - a.count || a.dst.localeCompare(b.dst))
    .slice(0, TOP_DESTINATIONS);
  return { total, deny, allow, network, http, topDestinations, lastTs };
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the openshell CLI the way the sandbox driver does: KYA_SANDBOX_OPENSHELL
 * (absolute path, basename openshell) wins, else PATH. Never throws: a malformed
 * env override or a missing binary yields undefined ("not detected").
 */
function resolveOpenshellCli(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.KYA_SANDBOX_OPENSHELL?.trim();
  if (fromEnv) {
    if (!fromEnv.startsWith("/") || basename(fromEnv) !== "openshell") return undefined;
    return executable(fromEnv) ? fromEnv : undefined;
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || dir === "." || dir.startsWith(".")) continue;
    const candidate = join(dir, "openshell");
    if (!candidate.startsWith("/")) continue;
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/** One --version probe per resolved binary per process, never per refresh. */
const versionCache = new Map<string, string | undefined>();

/** Test hook: drop cached `openshell --version` results. */
export function openshellCardResetForTests(): void {
  versionCache.clear();
}

function probeOpenshellVersion(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  if (versionCache.has(bin)) return versionCache.get(bin);
  let version: string | undefined;
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, OPENSHELL_TELEMETRY_ENABLED: "false" },
      timeout: 10_000,
    }).trim();
    version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? out.split("\n")[0]?.trim() ?? undefined;
    if (!version) version = undefined;
  } catch {
    version = undefined;
  }
  versionCache.set(bin, version);
  return version;
}

function containerRuntimeOnPath(env: NodeJS.ProcessEnv): "docker" | "podman" | undefined {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || dir === "." || dir.startsWith(".")) continue;
    for (const rt of ["docker", "podman"] as const) {
      const candidate = join(dir, rt);
      if (candidate.startsWith("/") && executable(candidate)) return rt;
    }
  }
  return undefined;
}

function openshellSandboxRows(cwd: string): OpenshellSandboxRow[] {
  let rows;
  try {
    rows = loadSandboxState(cwd);
  } catch {
    return [];
  }
  return rows
    .filter((r) => r.backend === "openshell")
    .map((r) => {
      let policyFile = false;
      try {
        policyFile = existsSync(openshellPolicyPath(cwd, r.sandboxId));
      } catch {
        policyFile = false;
      }
      return {
        sandboxId: r.sandboxId,
        status: r.status,
        createdAt: r.createdAt,
        externalName: r.externalName,
        policyFile,
      };
    });
}

/** Minimal duck-type of the certify card; only the SAFE-06 row is read. */
export interface OpenshellCertifyLike {
  readonly requirements: readonly {
    readonly id: string;
    readonly status: string;
    readonly evidence: string;
  }[];
}

export interface LoadOpenshellCardInput {
  readonly cwd: string;
  readonly events: readonly TrailEvent[];
  readonly env?: NodeJS.ProcessEnv;
  /** Already-computed certify card; the SAFE-06 outcome is reused, never recomputed. */
  readonly certify?: OpenshellCertifyLike;
}

/**
 * Build the OpenShell card. Returns undefined when nothing OpenShell-related
 * exists (no trail events, no openshell sandboxes, no openshell CLI or prover
 * on PATH): the report omits the panel entirely on fresh installs. Every probe
 * is defensive and never throws.
 */
export function loadOpenshellCard(input: LoadOpenshellCardInput): OpenshellCard | undefined {
  const env = input.env ?? process.env;
  const activity = aggregateOpenshellEvents(input.events);
  const sandboxes = openshellSandboxRows(input.cwd);
  const cli = resolveOpenshellCli(env);
  const safe06Row = input.certify?.requirements.find((r) => r.id === "SAFE-06");
  const runtime: OpenshellRuntime = {
    cliFound: cli !== undefined,
    cliVersion: cli ? probeOpenshellVersion(cli, env) : undefined,
    containerRuntime: containerRuntimeOnPath(env),
    minVersion: OPENSHELL_MIN_VERSION,
    proverFound: resolveOpenshellProver(env) !== undefined,
    safe06: safe06Row ? { status: safe06Row.status, evidence: safe06Row.evidence } : undefined,
  };
  if (!activity && sandboxes.length === 0 && !runtime.cliFound && !runtime.proverFound) {
    return undefined;
  }
  return { activity, sandboxes, runtime };
}
