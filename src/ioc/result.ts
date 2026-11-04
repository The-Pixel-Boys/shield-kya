/**
 * Last IoC scan result (~/.kya/ioc-latest.json). Display code reads it; only scan.ts writes it.
 * Reads fail open: a missing or damaged file means "no result", never an error in the caller.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";

export interface IocFinding {
  readonly ioc: string;
  readonly check: string;
  readonly severity: string;
  /** Path with ~ for the home directory, or a short label. Never file contents. */
  readonly evidence: string;
  readonly hint: string;
}

export interface IocResult {
  readonly schema: 1;
  readonly checkedAt: string;
  readonly listVersion: string;
  readonly skipped: number;
  readonly findings: readonly IocFinding[];
}

export function iocResultPath(env: NodeJS.ProcessEnv): string {
  return join(globalConfigDir(env), "ioc-latest.json");
}

const str = (v: unknown): v is string => typeof v === "string";

export function readIocResult(env: NodeJS.ProcessEnv): IocResult | undefined {
  try {
    const raw = JSON.parse(readFileSync(iocResultPath(env), "utf8")) as Partial<IocResult>;
    if (raw.schema !== 1 || !str(raw.checkedAt) || !str(raw.listVersion)) return undefined;
    if (typeof raw.skipped !== "number" || !Array.isArray(raw.findings)) return undefined;
    const findings = raw.findings.filter(
      (f): f is IocFinding => !!f && str(f.ioc) && str(f.check) && str(f.severity) && str(f.evidence) && str(f.hint),
    );
    return { schema: 1, checkedAt: raw.checkedAt, listVersion: raw.listVersion, skipped: raw.skipped, findings };
  } catch {
    return undefined;
  }
}
