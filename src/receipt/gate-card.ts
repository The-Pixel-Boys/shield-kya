/**
 * Gateway card for the Agent-activity report: the local kya gateway's setup
 * state (gateways.json + supervisor state file + installed binary) plus
 * per-server activity from the trail events in the current window. Fail-safe
 * like every receipt loader - unreadable or corrupt state degrades toward
 * "not set up" / "stopped", never a throw.
 */
import { inspectGateBinary } from "../gate/binary.js";
import { readGateways, type GatewayServer } from "../gate/config.js";
import { pidAlive, readGateState } from "../gate/daemon.js";
import { mcpServerLabel } from "../mcp-servers.js";
import type { TrailEvent } from "../trail.js";

export type GateState = "not-set-up" | "configured-stopped" | "running";

/** not-set-up quickstart line, shared by the HTML panel and the markdown artifact. */
export const GATE_NOT_SETUP_QUICKSTART =
  "Add any MCP server to a host config (or run `kya gate init` to pick from recipes) - `kya start` routes it through the gateway automatically.";

export type GateServerWorst = "never" | "deny" | "hold" | "allow" | "none";

export interface GateServerRow {
  readonly id: string;
  readonly transport: GatewayServer["transport"];
  /** Trail events in the window whose toolId is `<id>__<tool>`. */
  readonly events: number;
  /** never > deny > hold > allow; "none" when the window has no events. */
  readonly worst: GateServerWorst;
  /** Servers-facet value: the registry label, matching the feed's data-server stamp. */
  readonly serverFacet: string;
}

export interface GateCard {
  readonly state: GateState;
  readonly servers: readonly GateServerRow[];
  /** Gateway events in the window across all configured servers. */
  readonly events: number;
  /** Listener URL/port when running (from the supervisor state file). */
  readonly url?: string;
  readonly port?: number;
  /** Supervisor start timestamp - the uptime anchor when running. */
  readonly startedAt?: string;
  readonly binaryPresent: boolean;
  readonly binaryVersion?: string;
}

/** Gateway target ids are `<id>__<tool>` prefixes on trail toolIds. */
export function toolServerPrefix(toolId: string): string | undefined {
  const m = /^([a-z0-9][a-z0-9-]*)__/i.exec(toolId.trim());
  return m ? m[1]!.toLowerCase() : undefined;
}

export function loadGateCard(
  events: readonly TrailEvent[],
  env: NodeJS.ProcessEnv = process.env,
): GateCard {
  let servers: readonly GatewayServer[] = [];
  try {
    servers = readGateways(env).servers;
  } catch {
    // Corrupt gateways.json - the report degrades to not-set-up, never throws.
    servers = [];
  }
  const bin = inspectGateBinary(env);
  const state = readGateState(env);
  const running = Boolean(state && pidAlive(state.pid));

  const counts = new Map<string, { events: number; deny: number; hold: number; never: number }>();
  const configured = new Set(servers.map((s) => s.id));
  let total = 0;
  for (const e of events) {
    const id = toolServerPrefix(e.toolId);
    if (!id || !configured.has(id)) continue;
    let c = counts.get(id);
    if (!c) {
      c = { events: 0, deny: 0, hold: 0, never: 0 };
      counts.set(id, c);
    }
    c.events++;
    total++;
    if (e.neverEvent || e.reasonCode === "NEVER_EVENT") c.never++;
    const v = e.verdict.toUpperCase();
    if (v === "DENY") c.deny++;
    else if (v === "REQUIRE_APPROVE") c.hold++;
  }

  const rows: GateServerRow[] = servers.map((s) => {
    const c = counts.get(s.id);
    const worst: GateServerWorst = !c
      ? "none"
      : c.never > 0
        ? "never"
        : c.deny > 0
          ? "deny"
          : c.hold > 0
            ? "hold"
            : "allow";
    return {
      id: s.id,
      transport: s.transport,
      events: c?.events ?? 0,
      worst,
      serverFacet: mcpServerLabel(s.id),
    };
  });

  return {
    // Running wins over "nothing configured": a live listener with zero
    // targets is a real state (governed gateway up, no servers moved yet),
    // not the not-set-up quickstart.
    state: running ? "running" : servers.length === 0 ? "not-set-up" : "configured-stopped",
    servers: rows,
    events: total,
    ...(running && state ? { url: state.url, port: state.port, startedAt: state.startedAt } : {}),
    binaryPresent: bin.present,
    ...(bin.version ? { binaryVersion: bin.version } : {}),
  };
}
