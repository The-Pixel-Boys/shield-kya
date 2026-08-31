/**
 * Optional ORR producer for OpenSSF Scorecard (CLI `scorecard`).
 * Evidence only — never a PEP. Never --fix, never npx -y.
 */

import { spawnSync } from "node:child_process";
import type { OrrCoverageGap, OrrFinding } from "../commands/orr.js";

export const SCORECARD_PRODUCER_ID = "openssf.scorecard";

export interface ScorecardSpawnResult {
  readonly status: number | null;
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
  readonly error?: NodeJS.ErrnoException;
}

export type ScorecardSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
) => ScorecardSpawnResult;

export function buildScorecardArgv(absPath: string): {
  command: string;
  args: readonly string[];
} {
  const fromEnv = process.env.SCORECARD_BIN?.trim();
  return {
    command: fromEnv && fromEnv.length > 0 ? fromEnv : "scorecard",
    args: ["--local", absPath, "--format", "json"],
  };
}

/** Map Scorecard JSON dump into observational findings. Never maps to ALLOW. */
export function ingestScorecardJson(
  parsed: unknown,
  evidencePath: string,
): OrrFinding[] {
  const obj =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
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
      evidence: evidencePath,
      source_tool: SCORECARD_PRODUCER_ID,
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
      evidence: evidencePath,
      source_tool: SCORECARD_PRODUCER_ID,
    });
  }
  return findings;
}

export function tryRunScorecardCli(
  targetPath: string,
  spawn?: ScorecardSpawnFn,
): { findings: OrrFinding[] } | { gap: OrrCoverageGap } {
  const run = spawn ?? defaultScorecardSpawn;
  const { command, args } = buildScorecardArgv(targetPath);
  let result: ScorecardSpawnResult;
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
      return { gap: { adapter_id: SCORECARD_PRODUCER_ID, reason: "binary_not_found" } };
    }
    return { gap: { adapter_id: SCORECARD_PRODUCER_ID, reason: "error_non_fatal" } };
  }
  if (result.error?.code === "ENOENT") {
    return { gap: { adapter_id: SCORECARD_PRODUCER_ID, reason: "binary_not_found" } };
  }
  const stdout = bufferToString(result.stdout);
  const parsed = tryParseJson(stdout);
  if (parsed === undefined) {
    return { gap: { adapter_id: SCORECARD_PRODUCER_ID, reason: "error_non_fatal" } };
  }
  return { findings: ingestScorecardJson(parsed, `scorecard://local/${targetPath}`) };
}

function defaultScorecardSpawn(
  command: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
): ScorecardSpawnResult {
  return spawnSync(command, [...args], {
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide,
    shell: false,
    env: sanitizedScorecardEnv(process.env),
  });
}

/** Do not leak KYA / cloud tokens into Scorecard child process. */
export function sanitizedScorecardEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    const upper = key.toUpperCase();
    if (
      upper === "KYA_API_KEY" ||
      upper === "NODE_AUTH_TOKEN" ||
      upper.includes("API_KEY") ||
      upper.includes("SECRET") ||
      upper.includes("TOKEN") ||
      upper.includes("PASSWORD") ||
      upper.startsWith("AWS_") ||
      upper.startsWith("GH_") ||
      upper === "GITHUB_TOKEN"
    ) {
      delete out[key];
    }
  }
  return out;
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
