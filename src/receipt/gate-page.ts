/**
 * Full Gateway page model for the live report's #gateway zone. Extends the
 * compact GateCard used by the System tab and hero grid with config-derived
 * policy, bind-scope posture, binary metadata, and a playground evaluator.
 */
import { bindScopeFromYaml } from "../commands/gate.js";
import { gateBinaryPath, inspectGateBinary } from "../gate/binary.js";
import { denyPatternsFor, LOOPBACK_RULE } from "../gate/config-gen.js";
import { readGateways, type GateFailureMode } from "../gate/config.js";
import { readGateState } from "../gate/daemon.js";
import { mcpServerDefaultTier } from "../mcp-servers.js";
import type { TrailEvent } from "../trail.js";
import {
  GATE_NOT_SETUP_QUICKSTART,
  loadGateCard,
  toolServerPrefix,
  type GateCard,
  type GateServerRow,
  type GateServerWorst,
  type GateState,
} from "./gate-card.js";

export { toolServerPrefix };

export {
  GATE_NOT_SETUP_QUICKSTART,
  loadGateCard,
  type GateCard,
  type GateServerRow,
  type GateServerWorst,
  type GateState,
};

export interface GateListener {
  readonly name: string;
  readonly protocol: string;
  readonly address: string;
  readonly state: "running" | "stopped";
  /** ISO timestamp when running; omitted when stopped. */
  readonly uptime?: string;
  /** Extra detail line, escaped before render. */
  readonly detail?: string;
}

export interface GateRoute {
  readonly pattern: string;
  readonly backend: string;
  readonly backendLabel: string;
  readonly tier: "READ" | "WRITE" | "ADMIN" | undefined;
  readonly denyCount: number;
  readonly events: number;
  readonly worst: GateServerWorst;
  readonly deniedTools: readonly string[];
}

export interface GatePolicySummary {
  readonly networkRule: string;
  readonly failureMode: GateFailureMode;
  readonly totalPolicies: number;
  readonly verdicts: {
    readonly allow: number;
    readonly deny: number;
    readonly hold: number;
    readonly never: number;
  };
}

export interface GatePage extends GateCard {
  readonly failureMode: GateFailureMode;
  readonly otlpPort: number;
  /** Loopback-only posture from the generated YAML. */
  readonly bindScope: { readonly loopbackOnly: boolean; readonly detail: string };
  readonly binaryPath: string;
  readonly servers: readonly GatePageServerRow[];
  /** Window events whose toolId matches a configured server (<id>__<tool>). */
  readonly gateEvents: readonly TrailEvent[];
  /** MCP listener + OTLP receiver. */
  readonly listeners: readonly GateListener[];
  /** Tool-call route per configured server. */
  readonly routes: readonly GateRoute[];
  /** Network rule, failure mode, per-server policies, and window verdict mix. */
  readonly policySummary: GatePolicySummary;
  /** Recent distinct tool names for the playground sampler. */
  readonly playgroundSamples: readonly string[];
}

export interface GatePageServerRow extends GateServerRow {
  readonly importedFrom: readonly string[];
  readonly policy: {
    readonly defaultTier: "READ" | "WRITE" | "ADMIN" | undefined;
    readonly denyPatterns: readonly string[];
  };
  /** Distinct tool names from gateEvents for this server that match its deny patterns. */
  readonly deniedTools: readonly string[];
  /** Original server command (stdio) or URL (http), surfaced in the targets table. */
  readonly cmd?: readonly string[];
  readonly url?: string;
}

/** Re-export the loopback rule so the report can render it verbatim. */
export { LOOPBACK_RULE };

/** Extract the tool name from a `<id>__<tool>` toolId. */
export function toolNameFromToolId(toolId: string): string | undefined {
  const m = /^[a-z0-9][a-z0-9-]*__(.+)/i.exec(toolId.trim());
  return m ? m[1] : undefined;
}

/**
 * Build a single deny RegExp from a server's deny patterns. Returns undefined
 * when patterns is empty or invalid so callers can fall back to allow.
 */
function buildDenyRegex(patterns: readonly string[]): RegExp | undefined {
  if (patterns.length === 0) return undefined;
  try {
    return new RegExp(patterns.map((p) => `(?:${p})`).join("|"));
  } catch {
    return undefined;
  }
}

/**
 * Evaluate whether a specific tool on a specific server would be allowed or
 * denied by the generated gateway policy. Never throws: invalid regex falls
 * back to allow.
 */
export function evaluateGatewayTool(
  serverId: string,
  toolName: string,
): { verdict: "allow" | "deny"; reason: string } {
  const re = buildDenyRegex(denyPatternsFor(serverId));
  if (re && re.test(toolName)) {
    return { verdict: "deny", reason: "matches destructive/admin pattern" };
  }
  return { verdict: "allow", reason: "allowed by policy (observe mode)" };
}

/** Build the full Gateway page model from trail events + environment state. */
export function loadGatePage(
  events: readonly TrailEvent[],
  env: NodeJS.ProcessEnv = process.env,
): GatePage {
  const card = loadGateCard(events, env);
  let config;
  try {
    config = readGateways(env);
  } catch {
    config = { port: 3930, otlpPort: 3931, failureMode: "failOpen" as GateFailureMode, servers: [] };
  }

  const bin = inspectGateBinary(env);
  const binPath = gateBinaryPath(env);
  const state = readGateState(env);

  let bindScope: { loopbackOnly: boolean; detail: string };
  try {
    bindScope = bindScopeFromYaml(env);
  } catch {
    bindScope = { loopbackOnly: false, detail: "could not read generated config" };
  }

  const cardServerMap = new Map(card.servers.map((r) => [r.id, r]));
  const configured = new Set(config.servers.map((s) => s.id));

  const gateEvents = events.filter((e) => {
    const id = toolServerPrefix(e.toolId);
    return id !== undefined && configured.has(id);
  });

  const rows: GatePageServerRow[] = config.servers.map((s) => {
    const base = cardServerMap.get(s.id);
    const serverGateEvents = gateEvents.filter((e) => toolServerPrefix(e.toolId) === s.id);
    const denied = new Set<string>();
    const patterns = denyPatternsFor(s.id);
    const re = buildDenyRegex(patterns);
    for (const e of serverGateEvents) {
      const tool = toolNameFromToolId(e.toolId);
      if (!tool || !re) continue;
      if (re.test(tool)) denied.add(tool);
      if (denied.size >= 10) break;
    }

    return {
      id: s.id,
      transport: s.transport,
      events: base?.events ?? 0,
      worst: base?.worst ?? "none",
      serverFacet: base?.serverFacet ?? s.id,
      importedFrom: s.importedFrom ?? ["manual"],
      policy: {
        defaultTier: mcpServerDefaultTier(s.id),
        denyPatterns: patterns,
      },
      deniedTools: [...denied],
      ...(s.transport === "stdio" ? { cmd: s.cmd } : {}),
      ...(s.transport === "http" ? { url: s.url } : {}),
    };
  });

  const running = card.state === "running";
  const listeners: GateListener[] = [
    {
      name: "MCP listener",
      protocol: "MCP over HTTP",
      address: card.url ? card.url : `port ${card.port ?? config.port}`,
      state: running ? "running" : "stopped",
      ...(running && card.startedAt ? { uptime: card.startedAt } : {}),
      detail: "local proxy for host MCP clients",
    },
    {
      name: "OTLP receiver",
      protocol: "OTLP/HTTP",
      address: `port ${state?.otlpPort ?? config.otlpPort}`,
      state: running ? "running" : "stopped",
      detail: "telemetry ingestion",
    },
  ];

  const routes: GateRoute[] = rows.map((s) => ({
    pattern: `${s.id}__*`,
    backend: s.id,
    backendLabel: s.serverFacet,
    tier: s.policy.defaultTier,
    denyCount: s.policy.denyPatterns.length,
    events: s.events,
    worst: s.worst,
    deniedTools: s.deniedTools,
  }));

  const verdicts = { allow: 0, deny: 0, hold: 0, never: 0 };
  for (const e of gateEvents) {
    if (e.neverEvent || e.reasonCode === "NEVER_EVENT") verdicts.never++;
    else if (e.verdict.toUpperCase() === "DENY") verdicts.deny++;
    else if (e.verdict.toUpperCase() === "REQUIRE_APPROVE") verdicts.hold++;
    else if (e.verdict.toUpperCase() === "ALLOW") verdicts.allow++;
  }

  const seenTools = new Set<string>();
  const playgroundSamples: string[] = [];
  for (const e of [...gateEvents].sort((a, b) => b.ts.localeCompare(a.ts))) {
    const tool = toolNameFromToolId(e.toolId);
    if (!tool || seenTools.has(tool)) continue;
    seenTools.add(tool);
    playgroundSamples.push(tool);
    if (playgroundSamples.length >= 6) break;
  }

  return {
    ...card,
    failureMode: config.failureMode,
    otlpPort: state?.otlpPort ?? config.otlpPort,
    bindScope,
    binaryPath: binPath,
    servers: rows,
    gateEvents,
    listeners,
    routes,
    policySummary: {
      networkRule: LOOPBACK_RULE,
      failureMode: config.failureMode,
      totalPolicies: 1 + rows.length,
      verdicts,
    },
    playgroundSamples,
    ...(bin.version ? { binaryVersion: bin.version } : {}),
  };
}
