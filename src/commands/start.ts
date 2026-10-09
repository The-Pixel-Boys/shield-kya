/**
 * One-shot OSS onboarding: init → wire local MCP → bootstrap the gateway →
 * open live activity report.
 *
 * Wiring has three tiers: project files (`.mcp.json`, `mcp.json`,
 * `.cursor/mcp.json` in cwd), user-level MCP configs for hosts with evidence
 * of installation (config file present, or the host's config dir exists),
 * and PreToolUse hooks for hook-capable hosts (claude, grok, kimi).
 * All go through merge-only logic - never clobber. The gateway bootstrap
 * (bootstrapGate) then imports third-party MCP servers found in those host
 * configs into gateways.json and routes them through the local gateway -
 * warn-and-continue throughout, skippable via --no-gate / KYA_GATE=off.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../config.js";
import { UsageError } from "../errors.js";
import { runInit } from "./init.js";
import { openPath, runReceipt } from "./receipt.js";
import { ensureReceiptDaemon } from "../receipt/daemon.js";
import { appendTrail, defaultSessionId, trailPath } from "../trail.js";
import { hostReload, hostRunning, listProcessNames, reloadMessage } from "../host-reload.js";
import {
  CONNECT_REGISTRY,
  connectableHosts,
  mergeJsonHostConfig,
  standardServerBlock,
  wireHost,
} from "./connect.js";
import { HOOK_HOSTS, wireHook } from "./wire-hooks.js";
import { runGateRun, type GateRunResult } from "./gate.js";
import { ensureGateBinary, type EnsureBinaryResult } from "../gate/binary.js";
import { readGateways, scaffoldGateways, type GatewayServer } from "../gate/config.js";
import {
  discoverGateServers,
  importGateCandidates,
  removeHostServerEntries,
} from "../gate/discover.js";

export interface WiredUserHost {
  readonly host: string;
  readonly label: string;
  readonly path: string;
}

export interface StartResult {
  readonly initCreated: readonly string[];
  readonly wired: readonly string[];
  readonly skipped: readonly string[];
  /** User-level host configs wired (or created) because the host is installed. */
  readonly wiredHosts: readonly WiredUserHost[];
  /** PreToolUse hook wiring for installed hook-capable hosts (claude/grok/kimi). */
  readonly hooksWired: readonly WiredUserHost[];
  /** Gateway auto-bootstrap outcome; absent when disabled (--no-gate / KYA_GATE=off). */
  readonly gate?: GateBootstrapResult;
  readonly liveUrl?: string;
  readonly reportPid?: number;
  readonly reportReused?: boolean;
  readonly next: string;
}

export interface GateBootstrapResult {
  /** Server ids newly imported into gateways.json this run. */
  readonly imported: readonly string[];
  /** Total servers configured in gateways.json after import. */
  readonly serverCount: number;
  readonly running: boolean;
  /** Listener URL (no /mcp suffix) when running. */
  readonly url?: string;
  readonly backups: readonly string[];
  /** Hosts whose imported entries now route through the gateway. */
  readonly rewiredHosts: readonly string[];
  readonly warnings: readonly string[];
  readonly summary: string;
}

export interface GateBootstrapDeps {
  /** Test hook: binary install (defaults to ensureGateBinary). */
  readonly ensureBinary?: (env: NodeJS.ProcessEnv) => Promise<EnsureBinaryResult>;
  /** Test hook: supervisor start (defaults to runGateRun). */
  readonly runGate?: (config: ResolvedConfig, env: NodeJS.ProcessEnv) => Promise<GateRunResult>;
}

/** --no-gate wins; KYA_GATE=off/false/no/0 disables the bootstrap too. */
export function gateBootstrapEnabled(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (flag === false) return false;
  const v = env.KYA_GATE?.trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "no" && v !== "0";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Gate bootstrap for `kya start`: scaffold gateways.json, import third-party
 * servers discovered in host configs, then - only when there is something to
 * govern - install the binary, start the supervisor, and route the source
 * hosts through the gateway (direct entries removed, originals backed up
 * under .kya/backups). Every step warns and continues: start never fails
 * because of the gateway, and host configs are only touched once the
 * listener is actually up.
 */
export async function bootstrapGate(
  config: ResolvedConfig,
  input: { home: string; env?: NodeJS.ProcessEnv; deps?: GateBootstrapDeps },
): Promise<GateBootstrapResult> {
  const env = input.env ?? { ...process.env, KYA_HOME: input.home };
  const warnings: string[] = [];
  scaffoldGateways(env);
  const candidates = discoverGateServers(input.home);
  let imported: readonly GatewayServer[];
  let servers: readonly GatewayServer[];
  try {
    imported = importGateCandidates(candidates, env).imported;
    servers = readGateways(env).servers;
  } catch (err) {
    warnings.push(`gateways.json needs a hand fix (${errMsg(err)}) - gateway bootstrap skipped`);
    return {
      imported: [],
      serverCount: 0,
      running: false,
      backups: [],
      rewiredHosts: [],
      warnings,
      summary: "gateway: gateways.json is not usable - fix it by hand, then re-run kya start",
    };
  }
  const importedIds = imported.map((s) => s.id);
  if (servers.length === 0) {
    return {
      imported: [],
      serverCount: 0,
      running: false,
      backups: [],
      rewiredHosts: [],
      warnings,
      summary:
        "gateway: no third-party MCP servers found - add one to any host config and re-run kya start",
    };
  }

  const ensure = input.deps?.ensureBinary ?? ((e: NodeJS.ProcessEnv) => ensureGateBinary({ env: e }));
  try {
    await ensure(env);
  } catch (err) {
    warnings.push(
      `gateway binary could not be installed (${errMsg(err)}) - continuing without the gateway; host configs untouched`,
    );
    return {
      imported: importedIds,
      serverCount: servers.length,
      running: false,
      backups: [],
      rewiredHosts: [],
      warnings,
      summary: `gateway: ${servers.length} server${servers.length === 1 ? "" : "s"} configured but the binary is unavailable (offline?) - re-run kya start when online`,
    };
  }

  const runGate =
    input.deps?.runGate ?? ((c: ResolvedConfig, e: NodeJS.ProcessEnv) => runGateRun(c, { env: e }));
  let run: GateRunResult;
  try {
    run = await runGate(config, env);
  } catch (err) {
    warnings.push(`gateway failed to start (${errMsg(err)}) - continuing without it; host configs untouched`);
    return {
      imported: importedIds,
      serverCount: servers.length,
      running: false,
      backups: [],
      rewiredHosts: [],
      warnings,
      summary: "gateway: configured but the listener did not come up - see `kya gate doctor`",
    };
  }

  // Route only entries the gateway actually imported from that host: the gate
  // entry goes in first (merge-only), then the direct entries are removed
  // from a backed-up original. Hand-configured servers and shield-kya entries
  // are never touched.
  const gateUrl = `${run.url}/mcp`;
  const importedFrom = new Map(
    servers.filter((s) => s.importedFrom).map((s) => [s.id, s.importedFrom!] as const),
  );
  const byHost = new Map<string, string[]>();
  for (const c of candidates) {
    const from = importedFrom.get(c.id);
    if (!from) continue;
    for (const h of c.foundIn) {
      if (!from.includes(h)) continue;
      const ids = byHost.get(h) ?? [];
      ids.push(c.id);
      byHost.set(h, ids);
    }
  }
  const backups: string[] = [];
  const rewiredHosts: string[] = [];
  for (const [host, ids] of byHost) {
    try {
      wireHost({ host, scope: "global", home: input.home, cwd: config.cwd, gateUrl });
      const removal = removeHostServerEntries({ host, ids, home: input.home, env });
      if (removal) backups.push(removal.backup);
      rewiredHosts.push(host);
    } catch (err) {
      warnings.push(`${host}: could not route through the gateway (${errMsg(err)}) - its existing servers are kept`);
    }
  }

  const addr = run.url.replace(/^https?:\/\//, "");
  const summary = importedIds.length
    ? `gateway: ${importedIds.length} server${importedIds.length === 1 ? "" : "s"} imported (${importedIds.join(", ")}), gateway running on ${addr}` +
      (backups.length ? " - originals backed up to .kya/backups/" : "")
    : `gateway: running on ${addr} (${servers.length} server${servers.length === 1 ? "" : "s"}: ${servers.map((s) => s.id).join(", ")})`;
  return {
    imported: importedIds,
    serverCount: servers.length,
    running: true,
    url: run.url,
    backups,
    rewiredHosts,
    warnings,
    summary,
  };
}

function seedTrailIfEmpty(cwd: string): void {
  const trail = trailPath(cwd);
  if (existsSync(trail) && readFileSync(trail, "utf8").trim()) return;
  appendTrail(cwd, {
    ts: new Date().toISOString(),
    sessionId: defaultSessionId(),
    product: "ide",
    toolId: "kya.start",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    summary: "KYA started - wire MCP in your host, then wrap tools here",
  });
}

/**
 * Config dirs that count as evidence a host is installed even before its
 * config file exists (home dir itself never counts - ~/.claude.json's parent
 * is ~). Any other host qualifies only when its config file already exists.
 */
const EVIDENCE_DIRS: Readonly<Record<string, (home: string) => string>> = {
  claude: (h) => join(h, ".claude"),
  kimi: (h) => join(h, ".kimi-code"),
  grok: (h) => join(h, ".grok"),
  cursor: (h) => join(h, ".cursor"),
};

function hostInstalled(hostId: string, home: string): boolean {
  const globalPath = CONNECT_REGISTRY[hostId]?.globalPath?.(home);
  if (globalPath && existsSync(globalPath)) return true;
  const evidence = EVIDENCE_DIRS[hostId]?.(home);
  return Boolean(evidence && existsSync(evidence));
}

export async function runStart(
  config: ResolvedConfig,
  input: {
    force?: boolean;
    open?: boolean;
    procs?: ReadonlySet<string>;
    /** Test hook: home dir for user-level host wiring. */
    home?: string;
    /** Set false to skip the gateway auto-bootstrap (--no-gate). */
    gate?: boolean;
    /** Test hooks for the gateway bootstrap (binary install, supervisor start). */
    gateDeps?: GateBootstrapDeps;
  } = {},
): Promise<StartResult> {
  const force = Boolean(input.force);
  const open = input.open !== false;
  const home = input.home?.trim() || process.env.KYA_HOME?.trim() || homedir();

  const init = runInit({ cwd: config.cwd, force: false });
  const wired: string[] = [];
  const skipped: string[] = [...init.skipped];
  const wiredHosts: WiredUserHost[] = [];
  const hostNotesIds = new Set<string>();

  // Project files: Claude Code (.mcp.json), the generic mcp.json, and
  // Cursor's project MCP (.cursor/mcp.json).
  const projectWiring: readonly (() => {
    host?: string;
    path: string;
    status: string;
  })[] = [
    () => wireHost({ host: "claude", scope: "project", force, home, cwd: config.cwd }),
    () => ({
      path: join(config.cwd, "mcp.json"),
      status: mergeJsonHostConfig(
        join(config.cwd, "mcp.json"),
        "mcpServers",
        standardServerBlock("generic"),
        force,
      ),
    }),
    () => wireHost({ host: "cursor", scope: "project", force, home, cwd: config.cwd }),
  ];
  for (const wire of projectWiring) {
    try {
      const r = wire();
      if (r.status === "skipped") skipped.push(r.path);
      else wired.push(r.path);
      if (r.host) hostNotesIds.add(r.host);
    } catch (err) {
      if (err instanceof UsageError) skipped.push(String(err.message));
      else throw err;
    }
  }

  // User-level configs for hosts with evidence of installation.
  for (const hostId of connectableHosts()) {
    const spec = CONNECT_REGISTRY[hostId]!;
    if (!spec.globalPath || !hostInstalled(hostId, home)) continue;
    try {
      const r = wireHost({ host: hostId, scope: "global", force, home, cwd: config.cwd });
      if (r.status === "skipped") skipped.push(r.path);
      else wiredHosts.push({ host: r.host, label: r.label, path: r.path });
      hostNotesIds.add(r.host);
    } catch (err) {
      if (err instanceof UsageError) skipped.push(String(err.message));
      else throw err;
    }
  }

  // PreToolUse hook wiring for installed hook-capable hosts.
  const hookHosts = HOOK_HOSTS.filter((id) => hostInstalled(id, home));
  const hooksWired: WiredUserHost[] = [];
  for (const id of hookHosts) {
    try {
      const r = wireHook({ host: id, home, force });
      if (r.status !== "skipped") hooksWired.push({ host: r.host, label: r.label, path: r.path });
    } catch (err) {
      if (err instanceof UsageError) skipped.push(String(err.message));
      else throw err;
    }
  }

  seedTrailIfEmpty(config.cwd);

  // Gateway auto-bootstrap: after host wiring (discovery must see the final
  // configs), before the report opens (the panel reflects the outcome).
  let gate: GateBootstrapResult | undefined;
  if (gateBootstrapEnabled(input.gate)) {
    try {
      gate = await bootstrapGate(config, {
        home,
        ...(input.gateDeps ? { deps: input.gateDeps } : {}),
      });
    } catch (err) {
      gate = {
        imported: [],
        serverCount: 0,
        running: false,
        backups: [],
        rewiredHosts: [],
        warnings: [`gateway bootstrap failed (${errMsg(err)}) - continuing without it`],
        summary: "gateway: bootstrap failed - kya start continues without the gateway",
      };
    }
  }

  let liveUrl: string | undefined;
  let reportPid: number | undefined;
  let reportReused: boolean | undefined;
  if (open) {
    // Static artifacts first, then the live report as a detached background
    // server so the user gets their terminal back.
    await runReceipt(config, { open: false, days: 3 });
    const daemon = await ensureReceiptDaemon(config, { days: 3 });
    liveUrl = daemon.url;
    reportPid = daemon.pid;
    reportReused = daemon.reused;
    openPath(daemon.url);
  }

  // Reload note per host actually wired (project or user level), not a
  // blanket "restart everything".
  const procs = input.procs ?? listProcessNames();
  const hostNotes = [...hostNotesIds]
    .map((id) => {
      const info = hostReload(id);
      const label = CONNECT_REGISTRY[id]?.label;
      return info && label
        ? reloadMessage(info, label, hostRunning(info, procs))
        : undefined;
    })
    .filter((note): note is string => Boolean(note))
    .join(" ");

  return {
    initCreated: init.created,
    wired,
    skipped,
    wiredHosts,
    hooksWired,
    ...(gate ? { gate } : {}),
    liveUrl,
    reportPid,
    reportReused,
    next:
      `${hostNotes} ` +
      "The report runs in the background - reopen with `kya receipt --open`, " +
      "stop with `kya stop`." +
      (hooksWired.length
        ? " Hooks take effect in new sessions - claude, grok, and kimi all load hooks at session start."
        : ""),
  };
}

export function formatStartHuman(r: StartResult): string {
  return [
    "KYA start",
    r.initCreated.length ? `init: ${r.initCreated.join(", ")}` : "init: ok",
    r.wired.length ? `wired: ${r.wired.join(", ")}` : undefined,
    r.wiredHosts.length
      ? `wired hosts: ${r.wiredHosts.map((h) => `${h.label} (${h.path})`).join(", ")}`
      : undefined,
    r.hooksWired.length
      ? `hooks: ${r.hooksWired.map((h) => h.label).join(", ")} (PreToolUse interception - applies to new sessions)`
      : undefined,
    r.gate ? r.gate.summary : undefined,
    ...(r.gate?.warnings.map((w) => `gateway warning: ${w}`) ?? []),
    r.liveUrl ? `report: ${r.liveUrl}` : undefined,
    r.next,
  ]
    .filter(Boolean)
    .join("\n");
}
