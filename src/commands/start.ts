/**
 * One-shot OSS onboarding: init → wire local MCP → open live activity report.
 *
 * Wiring has three tiers: project files (`.mcp.json`, `mcp.json`,
 * `.cursor/mcp.json` in cwd), user-level MCP configs for hosts with evidence
 * of installation (config file present, or the host's config dir exists),
 * and PreToolUse hooks for hook-capable hosts (claude, grok, kimi).
 * All go through merge-only logic — never clobber.
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
  readonly liveUrl?: string;
  readonly reportPid?: number;
  readonly reportReused?: boolean;
  readonly next: string;
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
    summary: "KYA started — wire MCP in your host, then wrap tools here",
  });
}

/**
 * Config dirs that count as evidence a host is installed even before its
 * config file exists (home dir itself never counts — ~/.claude.json's parent
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
    liveUrl,
    reportPid,
    reportReused,
    next:
      `${hostNotes} ` +
      "The report runs in the background — reopen with `kya receipt --open`, " +
      "stop with `kya stop`." +
      (hooksWired.length
        ? " Hooks take effect in new sessions — claude, grok, and kimi all load hooks at session start."
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
      ? `hooks: ${r.hooksWired.map((h) => h.label).join(", ")} (PreToolUse interception — applies to new sessions)`
      : undefined,
    r.liveUrl ? `report: ${r.liveUrl}` : undefined,
    r.next,
  ]
    .filter(Boolean)
    .join("\n");
}
