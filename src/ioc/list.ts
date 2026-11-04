/**
 * Shipped IoC list (data/iocs.json, schema 1). Read-only data; the scan engine is in scan.ts.
 * Loaded from the package, so both src/ (tests) and dist/ (installed) reach it with the same path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type IocSeverity = "critical" | "high" | "medium";
export type IocCheckKind = "extension" | "ssh_authorized_keys_comment" | "net_indicator" | "file_exists";
export type IocWhere = "crontab" | "launchagents" | "systemd_user" | "ssh_config" | "shell_rc";

export interface IocCheck {
  readonly kind: IocCheckKind;
  /** extension: extension id (for example anthropic.claude-code). */
  readonly id?: string;
  /** extension: versions to flag. Empty list flags any version of the id. */
  readonly versions?: readonly string[];
  /** ssh_authorized_keys_comment: exact comment label. net_indicator: string to find. file_exists: path under ~. */
  readonly value?: string;
  /** net_indicator: which config sources to search. */
  readonly where?: readonly IocWhere[];
}

export interface IocEntry {
  readonly id: string;
  readonly title: string;
  readonly severity: IocSeverity;
  readonly source: string;
  readonly checks: readonly IocCheck[];
}

export interface IocList {
  readonly schema: 1;
  readonly version: string;
  readonly iocs: readonly IocEntry[];
}

const KINDS: readonly string[] = ["extension", "ssh_authorized_keys_comment", "net_indicator", "file_exists"];
const SEVERITIES: readonly string[] = ["critical", "high", "medium"];

/** Loads and checks the shipped list. A malformed file throws: the list is part of the package, not user input. */
export function loadIocList(): IocList {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/iocs.json", import.meta.url)), "utf8")) as IocList;
  if (raw.schema !== 1 || typeof raw.version !== "string" || !Array.isArray(raw.iocs)) {
    throw new Error("iocs.json: unsupported schema");
  }
  for (const ioc of raw.iocs) {
    if (!SEVERITIES.includes(ioc.severity)) throw new Error(`iocs.json: ${ioc.id} has an unknown severity`);
    for (const c of ioc.checks) {
      if (!KINDS.includes(c.kind)) throw new Error(`iocs.json: ${ioc.id} has an unknown check kind`);
    }
  }
  return raw;
}
