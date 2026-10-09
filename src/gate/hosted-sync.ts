/**
 * OSS-side hosted sync client for the KYA Gateway.
 *
 * Pushes a gateway state/config payload to `POST /api/v1/kya/gateways`
 * on the hosted platform. The sync is fire-and-forget: it never throws,
 * never blocks gate startup/tool calls, and logs a one-line warning on
 * failure. Missing credentials short-circuit to a no-op.
 */
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { denyPatternsFor } from "./config-gen.js";
import { mcpServerDefaultTier } from "../mcp-servers.js";
import { readGateways, type GatewaysConfig, type GatewayServer } from "./config.js";
import { readGateState } from "./daemon.js";
import { pidAlive } from "../receipt/daemon.js";

export type GatewayHostedState = "not-set-up" | "configured-stopped" | "running";

export interface HostedGatewayPayload {
  gatewayUid: string;
  name?: string;
  state: GatewayHostedState;
  port?: number;
  otlpPort?: number;
  failureMode: "failOpen" | "failClosed";
  bindDetail: string;
  binaryVersion?: string;
  startedAt?: string;
  config: {
    port?: number;
    otlpPort?: number;
    failureMode: string;
    servers: HostedGatewayServer[];
  };
}

export interface HostedGatewayServer {
  id: string;
  transport: "stdio" | "http";
  cmd?: string[];
  url?: string;
  importedFrom?: string[];
  defaultTier?: "READ" | "WRITE" | "ADMIN";
  denyPatterns?: string[];
}

export interface SyncOpts {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly gatewaysConfig: GatewaysConfig;
  readonly supervisorState?: {
    readonly url?: string;
    readonly port?: number;
    readonly startedAt?: string;
    readonly state?: GatewayHostedState;
    readonly binaryVersion?: string;
  };
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
  readonly logger?: { readonly warn: (msg: string) => void };
  /** Bypass the config-hash short-circuit (used by heartbeats). */
  readonly force?: boolean;
}

interface LastSync {
  readonly ok: boolean;
  readonly at: string;
  readonly error?: string;
}

let lastSentHash: string | undefined;
let lastSyncResult: LastSync | undefined;

/** Reset the in-memory "already sent" hash and last result (tests). */
export function resetHostedSyncHash(): void {
  lastSentHash = undefined;
  lastSyncResult = undefined;
}

/** Snapshot of the most recent sync attempt, successful or not. */
export function lastHostedSyncResult(): LastSync | undefined {
  return lastSyncResult;
}

const LOOPBACK_BIND_DETAIL =
  "loopback-only (L4 allowlist 127.0.0.0/8 + ::1; stats/readiness/admin listeners off)";

function hashPayload(payload: HostedGatewayPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function resolveState(
  cfg: GatewaysConfig,
  env: NodeJS.ProcessEnv | undefined,
  supervisorState?: SyncOpts["supervisorState"],
): GatewayHostedState {
  if (supervisorState?.state) return supervisorState.state;
  const state = readGateState(env);
  if (state && pidAlive(state.pid)) return "running";
  if (cfg.servers.length > 0) return "configured-stopped";
  return "not-set-up";
}

function serverPayload(server: GatewayServer): HostedGatewayServer {
  const base: HostedGatewayServer = {
    id: server.id,
    transport: server.transport,
    ...(server.cmd ? { cmd: [...server.cmd] } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.importedFrom ? { importedFrom: [...server.importedFrom] } : {}),
  };
  const tier = mcpServerDefaultTier(server.id);
  if (tier) base.defaultTier = tier;
  const deny = denyPatternsFor(server.id);
  if (deny.length > 0) base.denyPatterns = [...deny];
  return base;
}

export function buildHostedGatewayPayload(opts: SyncOpts): HostedGatewayPayload {
  const cfg = opts.gatewaysConfig;
  const state = resolveState(cfg, opts.env, opts.supervisorState);
  return {
    gatewayUid: cfg.instanceId ?? `anonymous-${randomUUID()}`,
    name: basename(opts.cwd),
    state,
    port: opts.supervisorState?.port ?? cfg.port,
    otlpPort: cfg.otlpPort,
    failureMode: cfg.failureMode,
    bindDetail: LOOPBACK_BIND_DETAIL,
    binaryVersion: opts.supervisorState?.binaryVersion,
    startedAt: opts.supervisorState?.startedAt,
    config: {
      port: cfg.port,
      otlpPort: cfg.otlpPort,
      failureMode: cfg.failureMode,
      servers: cfg.servers.map(serverPayload),
    },
  };
}

export async function syncGatewayToHosted(opts: SyncOpts): Promise<void> {
  const baseUrl = opts.baseUrl?.trim();
  const apiKey = opts.apiKey?.trim();
  if (!baseUrl || !apiKey) return;

  const payload = buildHostedGatewayPayload(opts);
  const hash = hashPayload(payload);
  if (!opts.force && lastSentHash === hash) return;
  lastSentHash = hash;

  const fetchFn = opts.fetchFn ?? fetch;
  const logger = opts.logger ?? { warn: (m) => console.warn(m) };

  try {
    const res = await fetchFn(`${baseUrl}/api/v1/kya/gateways`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? ` ${text}` : ""}`);
    }
    lastSyncResult = { ok: true, at: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastSyncResult = { ok: false, at: new Date().toISOString(), error: message };
    logger.warn(`hosted gateway sync failed: ${message}`);
  }
}

export interface HostedSyncEnvInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly state?: GatewayHostedState;
  readonly binaryVersion?: string;
  readonly logger?: { readonly warn: (msg: string) => void };
  readonly force?: boolean;
}

/** Convenience trigger that reads credentials from the environment and fires-and-forgets. */
export function triggerHostedSyncFromEnv(input: HostedSyncEnvInput): void {
  try {
    const env = input.env ?? process.env;
    const apiKey = (env.KYA_API_KEY ?? env.SHIELD_API_KEY ?? "").trim();
    const baseUrl = (env.KYA_BASE_URL ?? "").trim();
    if (!apiKey || !baseUrl) return;
    void syncGatewayToHosted({
      cwd: input.cwd,
      env,
      gatewaysConfig: readGateways(env),
      supervisorState: input.state
        ? { state: input.state, binaryVersion: input.binaryVersion }
        : undefined,
      baseUrl,
      apiKey,
      logger: input.logger,
      force: input.force,
    });
  } catch {
    /* best-effort - sync must never break gate commands */
  }
}
