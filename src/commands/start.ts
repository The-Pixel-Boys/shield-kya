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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { configDir, type ResolvedConfig } from "../config.js";
import { projectWritePath, writeProjectFile } from "../fs-atomic.js";
import { diffChange, isTracked, liveJournal } from "../manifest.js";
import { WriteJournal, withJournal } from "../write-journal.js";
import { UsageError } from "../errors.js";
import { DEMO_CALLS, PROMISE, demoLabels } from "../guard-demo.js";
import { runInit } from "./init.js";
import { openPath, runReceipt } from "./receipt.js";
import { ensureReceiptDaemon } from "../receipt/daemon.js";
import { appendTrail, defaultSessionId, receiptsDir, trailPath } from "../trail.js";
import { hostReload, hostRunning, listProcessNames, reloadMessage } from "../host-reload.js";
import {
  CONNECT_REGISTRY,
  connectableHosts,
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
  /** Guard proof: the three demo calls sent through the hook path. Absent when it could not run. */
  readonly proof?: GuardProof;
  readonly liveUrl?: string;
  readonly reportPid?: number;
  readonly reportReused?: boolean;
  readonly next: string;
}

export interface GuardProof {
  /** Always true: the calls are built-in samples, never your activity. */
  readonly demo: true;
  readonly results: readonly { readonly label: string; readonly blocked: boolean }[];
  /** Hook-capable hosts whose PreToolUse hook points at kya (new or already wired). */
  readonly guardedHosts: readonly string[];
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

/**
 * Send the three demo calls through the real hook (`runHook`) and report what it did.
 * The hook writes its trail row under a throw-away KYA_HOME that is deleted at the end, so the real trail never sees
 * the demo. HOME stays real: the guard reads the person's own guard settings from it. Never throws.
 */
export async function guardProof(cwd: string, guardedHosts: readonly string[]): Promise<GuardProof | undefined> {
  let tmp: string | undefined;
  try {
    const { runHook } = await import("./hook.js");
    tmp = mkdtempSync(join(tmpdir(), "kya-proof-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME?.trim() || homedir(), KYA_HOME: tmp, KYA_OFFLINE: "1" };
    const results: { label: string; blocked: boolean }[] = [];
    for (const call of DEMO_CALLS) {
      const r = await runHook({
        host: "claude",
        strict: false,
        stdinText: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "kya-demo", cwd, tool_name: call.toolName, tool_input: call.toolInput(cwd) }),
        env,
        cwd,
      });
      results.push({ label: call.label, blocked: r.exitCode === 2 });
    }
    return { demo: true, results, guardedHosts: [...guardedHosts] };
  } catch {
    return undefined;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** The closing lines of `kya start`. It claims "guarded" only when all three demo calls were blocked and a host hook is in place. */
export function formatProofLines(p: GuardProof): string[] {
  const blocked = p.results.filter((r) => r.blocked).map((r) => r.label);
  const open = p.results.filter((r) => !r.blocked).map((r) => r.label);
  const head = `Guard demo (${p.results.length} built-in calls, not saved to your trail):`;
  if (open.length > 0) {
    return [head, `${blocked.length ? `Blocked: ${demoLabels(blocked.map((label) => ({ label })))}. ` : ""}Not blocked: ${demoLabels(open.map((label) => ({ label })))} (check the guard settings in ~/.kya/config.json).`];
  }
  const all = demoLabels(p.results);
  if (p.guardedHosts.length === 0) {
    return [head, `Blocked: ${all}. No coding host with hooks was found, so no agent is guarded yet. Wire one: kya connect claude --hooks`];
  }
  return [head, `Blocked: ${all}. Your agent is now guarded.`];
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

export interface StartInput {
  force?: boolean;
  open?: boolean;
  procs?: ReadonlySet<string>;
  /** Test hook: home dir for user-level host wiring. */
  home?: string;
  /** Set false to skip the gateway auto-bootstrap (--no-gate). */
  gate?: boolean;
  /** Test hooks for the gateway bootstrap (binary install, supervisor start). */
  gateDeps?: GateBootstrapDeps;
}

interface WirePhase {
  readonly initCreated: readonly string[];
  readonly wired: string[];
  readonly skipped: string[];
  readonly wiredHosts: WiredUserHost[];
  readonly hooksWired: WiredUserHost[];
  /** Hosts whose kya hook is in place after this phase: newly wired, or already there. */
  readonly hooksPresent: string[];
  readonly hostNotesIds: Set<string>;
}

/** True when cwd or a parent holds a .git entry (a repo or a worktree). */
function inGitRepo(cwd: string): boolean {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** .kya, .kya/, .kya/*, .kya/** (each with an optional leading slash) already hide the folder. */
const KYA_IGNORE_LINE = /^\/?\.kya(\/(\*\*?)?)?$/;

/**
 * Append `.kya/*` and `!.kya/policy.json` to <cwd>/.gitignore in a git repo, once. The negation keeps the
 * team policy that `kya team init` tells teams to commit. Returns true when it wrote.
 */
export function ensureGitignore(cwd: string): boolean {
  if (!inGitRepo(cwd)) return false;
  const path = join(cwd, ".gitignore");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.split(/\r?\n/).some((l) => KYA_IGNORE_LINE.test(l.trim()))) return false;
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  writeProjectFile(path, `${text}${sep}.kya/*\n!.kya/policy.json\n`, cwd);
  return true;
}

/** Every config write of `kya start` (steps 1 to 4). Under a dry journal it writes nothing. */
function wirePhase(config: ResolvedConfig, force: boolean, home: string): WirePhase {
  // Refuse before writing anything when a project file or .kya leaves the project (ProjectPathError, exit 1).
  projectWritePath(configDir(config.cwd), config.cwd, true);
  projectWritePath(receiptsDir(config.cwd), config.cwd, true);
  const init = runInit({ cwd: config.cwd, force: false, configOnly: true });
  const wired: string[] = [];
  const skipped: string[] = [...init.skipped];
  const wiredHosts: WiredUserHost[] = [];
  const hostNotesIds = new Set<string>();

  // Project files only for hosts found on this machine: Claude Code (.mcp.json)
  // and Cursor (.cursor/mcp.json). The generic project mcp.json is no longer written.
  for (const hostId of ["claude", "cursor"]) {
    if (!hostInstalled(hostId, home)) continue;
    try {
      const p = CONNECT_REGISTRY[hostId]!.projectPath!(config.cwd);
      projectWritePath(p, config.cwd);
      const r = wireHost({ host: hostId, scope: "project", force, home, cwd: config.cwd });
      if (r.status === "skipped") skipped.push(r.path);
      else wired.push(r.path);
      hostNotesIds.add(r.host);
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
  const hooksPresent: string[] = [];
  for (const id of hookHosts) {
    try {
      const r = wireHook({ host: id, home, force });
      hooksPresent.push(id);
      if (r.status !== "skipped") hooksWired.push({ host: r.host, label: r.label, path: r.path });
    } catch (err) {
      if (err instanceof UsageError) skipped.push(String(err.message));
      else throw err;
    }
  }

  ensureGitignore(config.cwd);
  return { initCreated: init.created, wired, skipped, wiredHosts, hooksWired, hooksPresent, hostNotesIds };
}

export interface PlanItem {
  readonly path: string;
  readonly action: "create" | "merge" | "append";
  /** Exact keys, tables or lines added. */
  readonly keys: readonly string[];
}

export interface StartPlan {
  readonly items: readonly PlanItem[];
  /** Extra effects that are not file writes (report server, gateway). */
  readonly notes: readonly string[];
  /** True when every file is already wired: applying changes no config file. */
  readonly nothingToWrite: boolean;
  /** True when applying changes config files or host configs (so it needs a yes). */
  readonly needsConsent: boolean;
}

/** What `kya start` would do, computed by running the real wiring under a dry journal. Writes nothing. */
export async function planStart(
  config: ResolvedConfig,
  input: Pick<StartInput, "force" | "open" | "home" | "gate"> = {},
): Promise<StartPlan> {
  const home = input.home?.trim() || process.env.KYA_HOME?.trim() || homedir();
  const journal = new WriteJournal(true);
  await withJournal(journal, () => wirePhase(config, Boolean(input.force), home));
  const ctx = { globalDir: join(home, ".kya"), cwd: config.cwd };
  const items: PlanItem[] = [];
  for (const t of journal.touched()) {
    if (!isTracked(t.path, ctx)) continue;
    const change = diffChange(t.path, t.before?.toString("utf8"), t.after.toString("utf8"));
    items.push({
      path: t.path,
      action: t.before === undefined ? "create" : basename(t.path) === ".gitignore" ? "append" : "merge",
      keys: basename(t.path) === "kya-hook" ? ["hook launcher script (runs kya hook; fails open if node or kya is missing)"] : change.keys,
    });
  }
  const notes: string[] = [".kya/ in this project holds the activity trail and report files (KYA's own data; start also writes them)."];
  const absent = connectableHosts()
    .filter((h) => CONNECT_REGISTRY[h]!.globalPath && !hostInstalled(h, home))
    .map((h) => CONNECT_REGISTRY[h]!.label);
  if (absent.length > 0) notes.push(`not found on this machine, so not wired: ${absent.join(", ")} (kya connect <host> wires one by hand).`);
  if (gateBootstrapEnabled(input.gate)) {
    const found = discoverGateServers(home);
    const gwPath = join(home, ".kya", "gateways.json");
    if (!existsSync(gwPath)) {
      items.push({
        path: gwPath,
        action: "create",
        keys: ["port", "failureMode", "instanceId", "servers", "recipes", ...(found.length ? [`servers: ${found.length} imported (${found.map((c) => c.id).join(", ")})`] : [])],
      });
    }
    if (found.length) {
      // Only if the gateway binary installs and the listener starts; until then host configs stay untouched.
      const byHost = new Map<string, string[]>();
      for (const c of found) for (const h of c.foundIn) byHost.set(h, [...(byHost.get(h) ?? []), c.id]);
      for (const [h, ids] of byHost) {
        const spec = CONNECT_REGISTRY[h];
        const path = spec?.globalPath?.(home);
        if (!spec || !path) continue;
        const keys = [`${spec.rootKey}.shield-kya-gate (gateway entry)`, ...ids.map((id) => `- ${spec.rootKey}.${id} (moved to the gateway; original backed up)`)];
        const idx = items.findIndex((i) => real(i.path) === real(path));
        if (idx >= 0) items[idx] = { ...items[idx]!, keys: [...items[idx]!.keys, ...keys] };
        else items.push({ path, action: "merge", keys });
      }
      notes.push(
        `gateway: ${found.length} third-party MCP server${found.length === 1 ? "" : "s"} (${found.map((c) => c.id).join(", ")}) move behind the local gateway, only if the gateway binary installs and the listener starts. Skip with --no-gate. kya uninstall puts them back.`,
      );
    }
  }
  if (input.open !== false) notes.push("starts the local report server in the background and opens the report (stop it with kya stop; skip with --no-open).");
  return { items, notes, nothingToWrite: items.length === 0, needsConsent: items.length > 0 };
}

/** realpath of the nearest existing ancestor plus the rest (the target may not exist yet). */
function real(p: string): string {
  const rest: string[] = [];
  for (let d = resolve(p); ; d = dirname(d)) {
    try {
      return join(realpathSync(d), ...rest.reverse());
    } catch {
      rest.push(basename(d));
    }
    if (dirname(d) === d) return p;
  }
}

function displayPath(p: string, cwd: string, home: string): string {
  const rel = relative(real(cwd), real(p));
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  const h = relative(real(home), real(p));
  if (h !== "" && !h.startsWith("..") && !isAbsolute(h)) return `~/${h}`;
  return p;
}

export function formatPlanHuman(plan: StartPlan, cwd: string, home: string): string {
  const lines = [PROMISE, "", "KYA start will make these changes:"];
  for (const i of plan.items) {
    lines.push(`  ${i.action.padEnd(6)} ${displayPath(i.path, cwd, home)}`);
    for (const k of i.keys) lines.push(`           + ${k}`);
  }
  if (plan.items.length === 0) lines.push("  (no config file changes: everything is already wired)");
  for (const n of plan.notes) lines.push(`  note   ${n}`);
  lines.push(
    "Merged files are backed up under ~/.kya/undo/ and every write is recorded in ~/.kya/manifest.json.",
    "Undo everything with: kya uninstall",
  );
  return lines.join("\n");
}

export async function runStart(config: ResolvedConfig, input: StartInput = {}): Promise<StartResult> {
  const home = input.home?.trim() || process.env.KYA_HOME?.trim() || homedir();
  const { journal, finish } = liveJournal({ globalDir: join(home, ".kya"), cwd: config.cwd });
  try {
    return await withJournal(journal, () => applyStart(config, input, home));
  } finally {
    finish();
  }
}

async function applyStart(config: ResolvedConfig, input: StartInput, home: string): Promise<StartResult> {
  const force = Boolean(input.force);
  const open = input.open !== false;
  const { initCreated, wired, skipped, wiredHosts, hooksWired, hooksPresent, hostNotesIds } = wirePhase(config, force, home);
  const init = { created: initCreated };

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

  const proof = await guardProof(config.cwd, hooksPresent);

  let liveUrl: string | undefined;
  let reportPid: number | undefined;
  let reportReused: boolean | undefined;
  if (open) {
    // Static artifacts first, then the live report as a detached background
    // server so the user gets their terminal back.
    await runReceipt(config, { open: false, days: 3 });
    // KYA_ORR_AUTO=off: the report server must not create orr-report/ in the project; `kya orr run` owns it.
    const daemon = await ensureReceiptDaemon(config, { days: 3, env: { KYA_ORR_AUTO: "off" } });
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
    ...(proof ? { proof } : {}),
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
    r.liveUrl
      ? `report: ${r.liveUrl}${
          r.reportReused
            ? ` (already running, pid ${r.reportPid}; to restart it run kya stop, then kya start)`
            : ""
        }`
      : undefined,
    r.next,
    ...(r.proof ? formatProofLines(r.proof) : []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** "Apply? [Y/n]" on stderr. Empty or y/yes applies; anything else, or a closed stdin, does not. */
export function askApply(question = "Apply? [Y/n]"): Promise<string> {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let done = false;
    const finish = (a: string): void => {
      if (done) return;
      done = true;
      rl.close();
      resolvePromise(a);
    };
    rl.once("close", () => finish("n"));
    rl.question(`${question} `, finish);
  });
}

/** KYA_YES=1|true|yes|on skips the question (same as --yes). */
export function envYes(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(env.KYA_YES?.trim() ?? "");
}
