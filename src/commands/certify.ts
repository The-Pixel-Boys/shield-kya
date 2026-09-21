/**
 * kya certify — Agent Trust Baseline gap report from local evidence.
 * Evidence only: not a second PEP; never mints principals, never ALLOWs,
 * DENYs, or blocks anything. Local-first: no network, no account, no key check.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { kyaHome, resolveGateMode } from "../config.js";
import { assertNoSecrets } from "../dash/render.js";
import { UsageError } from "../errors.js";
import { flagBool, flagString, type ParsedArgs } from "../parse-args.js";
import { loadCatalog } from "../certify/catalog.js";
import {
  evaluateRequirement,
  trailWindow,
  type CertifyReport,
  type CertifyTrailStats,
  type EvidenceContext,
} from "../certify/evaluate.js";
import { formatCertifyMarkdown, renderCertifyHtml } from "../certify/render.js";
import {
  loadAttestations,
  recordAttestation,
  type AttestationRecord,
} from "../certify/attest.js";
import {
  loadIdentity,
  loadOrrCard,
  loadOrrCategoryRatings,
  loadSandboxes,
  loadShowbackCard,
  loadWiredHosts,
} from "../receipt/enrich.js";
import { readTrail, receiptsDir, type TrailEvent } from "../trail.js";
import {
  buildEvidenceBundle,
  loadOrCreateEvidenceKey,
} from "../sign/evidence-bundle.js";

export interface CertifyCliOptions {
  readonly windowDays: number;
  readonly catalogPath?: string;
  readonly out: string;
  readonly formats: readonly ("json" | "md" | "html")[];
  readonly jsonStdout: boolean;
  readonly open: boolean;
  readonly quiet: boolean;
  readonly failOn: "gap" | "never";
  readonly sign: boolean;
  readonly attest?: { readonly requirementId: string; readonly text: string };
}

export type CertifyOptions = CertifyCliOptions & {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Test seam for time-dependent checks. */
  readonly now?: Date;
};

export interface CertifyResult {
  readonly report: CertifyReport;
  readonly jsonPath?: string;
  readonly mdPath?: string;
  readonly htmlPath?: string;
  readonly bundlePath?: string;
  /** Present only with --sign: fingerprint of the key that signed the bundle. */
  readonly keyFingerprint?: string;
  /** Present only with --sign: true when this run generated the signing key. */
  readonly keyCreated?: boolean;
  readonly attestationRecorded?: AttestationRecord;
  readonly exitCode: number;
}

export function certifyOptionsFromArgs(parsed: ParsedArgs): CertifyCliOptions {
  const windowRaw = flagString(parsed.flags, "window");
  let windowDays = 30;
  if (windowRaw !== undefined) {
    if (!/^\d+$/.test(windowRaw)) {
      throw new UsageError("--window must be an integer between 1 and 366");
    }
    const n = Number.parseInt(windowRaw, 10);
    if (n < 1 || n > 366) {
      throw new UsageError("--window must be an integer between 1 and 366");
    }
    windowDays = n;
  }
  const formatRaw = flagString(parsed.flags, "format") ?? "json,md,html";
  const tokens = formatRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const invalid = tokens.filter((s) => s !== "json" && s !== "md" && s !== "html");
  if (tokens.length === 0 || invalid.length > 0) {
    throw new UsageError(
      `--format must be a comma-separated list of: json, md, html (got ${JSON.stringify(formatRaw)})`,
    );
  }
  const formats = [...new Set(tokens)] as ("json" | "md" | "html")[];
  const failOnRaw = flagString(parsed.flags, "fail-on") ?? "gap";
  if (failOnRaw !== "gap" && failOnRaw !== "never") {
    throw new UsageError("--fail-on must be gap or never");
  }
  const attestId = flagString(parsed.flags, "attest");
  let attest: CertifyCliOptions["attest"];
  if (attestId !== undefined) {
    const text = flagString(parsed.flags, "text");
    if (!text) throw new UsageError('--attest requires --text "…"');
    attest = { requirementId: attestId, text };
  }
  return {
    windowDays,
    catalogPath: flagString(parsed.flags, "catalog"),
    out: flagString(parsed.flags, "out") ?? ".kya/certify",
    formats,
    jsonStdout: flagBool(parsed.flags, "json-stdout"),
    open: flagBool(parsed.flags, "open"),
    quiet: flagBool(parsed.flags, "quiet"),
    failOn: failOnRaw,
    sign: flagBool(parsed.flags, "sign"),
    ...(attest ? { attest } : {}),
  };
}

/** Receipt artifacts (html/json/md) in .kya/receipts. */
export function countReceipts(cwd: string): number {
  try {
    const dir = receiptsDir(cwd);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
    return readdirSync(dir).filter((n) => /\.(html|json|md)$/i.test(n)).length;
  } catch {
    return 0;
  }
}

function trailStats(events: readonly TrailEvent[]): CertifyTrailStats {
  const verdictMix = { ALLOW: 0, DENY: 0, REQUIRE_APPROVE: 0 };
  const modes = { observe: 0, hold: 0, offline: 0 };
  for (const e of events) {
    const v = e.verdict.toUpperCase();
    if (v === "ALLOW") verdictMix.ALLOW++;
    else if (v === "DENY") verdictMix.DENY++;
    else if (v === "REQUIRE_APPROVE") verdictMix.REQUIRE_APPROVE++;
    if (e.mode === "observe") modes.observe++;
    else if (e.mode === "hold") modes.hold++;
    else modes.offline++;
  }
  return { eventCount: events.length, verdictMix, modes };
}

export function runCertify(options: CertifyOptions): CertifyResult {
  const catalog = loadCatalog(options.catalogPath);
  const now = options.now ?? new Date();

  let attestationRecorded: AttestationRecord | undefined;
  if (options.attest) {
    const wanted = options.attest.requirementId.trim();
    if (!catalog.requirements.some((r) => r.id === wanted)) {
      throw new UsageError(`unknown requirement id for --attest: ${wanted}`);
    }
    attestationRecorded = recordAttestation(options.cwd, wanted, options.attest.text);
  }

  const events = readTrail(options.cwd, options.env);
  const wiredHosts = loadWiredHosts(options.cwd, kyaHome(options.env));
  const sandboxes = loadSandboxes(options.cwd, options.env);
  const ctx: EvidenceContext = {
    now,
    events,
    // The shared resolver the gate itself uses (config.ts) — certify can
    // never report a mode the gate would not actually run.
    gateMode: resolveGateMode({ cwd: options.cwd, env: options.env }),
    wiredHostCount: wiredHosts.filter((h) => h.wired !== "none").length,
    orr: loadOrrCard(options.cwd),
    orrCategories: loadOrrCategoryRatings(options.cwd),
    sandboxCount: sandboxes.sandboxes.length,
    receiptCount: countReceipts(options.cwd),
    showbackPresent: loadShowbackCard(options.cwd) !== undefined,
    attestations: loadAttestations(options.cwd),
  };

  const requirements = catalog.requirements.map((r) => evaluateRequirement(r, ctx));
  const inWindow = trailWindow(events, options.windowDays, now);
  const counts = { pass: 0, gap: 0, insufficientEvidence: 0, attested: 0 };
  for (const r of requirements) {
    if (r.status === "pass") counts.pass++;
    else if (r.status === "gap") counts.gap++;
    else if (r.status === "attested") counts.attested++;
    else counts.insufficientEvidence++;
  }
  const report: CertifyReport = {
    format: "shield-kya-certify-report",
    version: 1,
    generatedAt: now.toISOString(),
    catalog: { id: catalog.id, version: catalog.version, updated: catalog.updated },
    window: {
      days: options.windowDays,
      since: new Date(now.getTime() - options.windowDays * 24 * 60 * 60 * 1000).toISOString(),
      until: now.toISOString(),
    },
    trail: trailStats(inWindow),
    requirements,
    overall: {
      ...counts,
      // Fail-closed: zero certifiable evidence (all insufficient_evidence)
      // must never headline as pass — a green badge requires real evidence.
      result: counts.gap > 0 ? "gap" : counts.pass + counts.attested > 0 ? "pass" : "gap",
    },
  };

  const outDir = resolve(options.cwd, options.out);
  mkdirSync(outDir, { recursive: true });
  let jsonPath: string | undefined;
  let mdPath: string | undefined;
  if (options.formats.includes("json")) {
    jsonPath = join(outDir, "report.json");
    const json = `${JSON.stringify(report, null, 2)}\n`;
    assertNoSecrets(json);
    writeFileSync(jsonPath, json, "utf8");
  }
  if (options.formats.includes("md")) {
    mdPath = join(outDir, "report.md");
    writeFileSync(mdPath, formatCertifyMarkdown(report), "utf8");
  }
  let htmlPath: string | undefined;
  if (options.formats.includes("html")) {
    htmlPath = join(outDir, "report.html");
    writeFileSync(htmlPath, renderCertifyHtml(report), "utf8");
  }

  let bundlePath: string | undefined;
  let keyFingerprint: string | undefined;
  let keyCreated: boolean | undefined;
  if (options.sign) {
    const key = loadOrCreateEvidenceKey(options.env);
    keyFingerprint = key.fingerprint;
    keyCreated = key.created;
    const identity = loadIdentity(options.cwd);
    // baseUrl is deliberately never copied into the bundle (inert display text only).
    const agent = identity
      ? {
          ...(identity.agentId ? { agentId: identity.agentId } : {}),
          ...(identity.agentName ? { agentName: identity.agentName } : {}),
          ...(identity.host ? { host: identity.host } : {}),
        }
      : undefined;
    const bundle = buildEvidenceBundle(
      { report, windowEvents: inWindow, ...(agent ? { agent } : {}) },
      key,
    );
    bundlePath = join(outDir, "evidence-bundle.json");
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  }

  let exitCode = 0;
  if (options.failOn === "gap" && report.overall.result === "gap") exitCode = 1;
  return {
    report,
    ...(jsonPath ? { jsonPath } : {}),
    ...(mdPath ? { mdPath } : {}),
    ...(htmlPath ? { htmlPath } : {}),
    ...(bundlePath ? { bundlePath } : {}),
    ...(keyFingerprint !== undefined ? { keyFingerprint } : {}),
    ...(keyCreated !== undefined ? { keyCreated } : {}),
    ...(attestationRecorded ? { attestationRecorded } : {}),
    exitCode,
  };
}

export function formatCertifySummary(report: CertifyReport): string {
  const o = report.overall;
  const lines = [
    `certify ${report.catalog.id} v${report.catalog.version} — ${o.result.toUpperCase()}`,
    `${o.pass} pass · ${o.gap} gap · ${o.insufficientEvidence} insufficient evidence · ${o.attested} attested`,
  ];
  if (o.result === "gap" && o.gap === 0) {
    lines.push("  no certifiable evidence in window — run the gate first (kya wrap / kya connect)");
  }
  for (const r of report.requirements.filter((x) => x.status === "gap").slice(0, 10)) {
    lines.push(`  gap ${r.id} [${r.severity}] ${r.title}`);
  }
  if (o.gap > 10) lines.push(`  … and ${o.gap - 10} more (see report)`);
  return lines.join("\n");
}
