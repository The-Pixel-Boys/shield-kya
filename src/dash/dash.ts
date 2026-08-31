import type { ResolvedConfig } from "../config.js";
import { KyaHttpClient, type PolicyEvaluateResponse } from "../client.js";
import { evaluateOffline } from "../offline-evaluate.js";
import { CLI_VERSION } from "../version.js";
import {
  type DashPane,
  type Entitlement,
  paneAllowed,
  resolveEntitlement,
} from "./entitlement.js";
import { assertNoSecrets, frame, type StatusStrip } from "./render.js";
import {
  agentsLiveBody,
  agentsOfflineBody,
  approvalsLiveBody,
  homeBody,
  mcpBody,
  needsPlaneBody,
  orrBody,
  policyLiveBody,
  policyOfflineBody,
  sandboxBody,
  sessionsLiveBody,
} from "./screens/free.js";
import { loadSandboxState } from "../sandbox/runtime.js";
import {
  casesBody,
  dashboardBody,
  edgeBody,
  metricsBody,
  settingsBody,
} from "./screens/enterprise.js";
import { lockedPane } from "./render.js";

export const DASH_VERSION = CLI_VERSION;

export interface DashIo {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
  readonly isTty?: boolean;
}

export interface DashOptions {
  readonly once: boolean;
  readonly offline: boolean;
  readonly pane: DashPane;
  readonly client?: KyaHttpClient;
  readonly fetchPlaneEntitlement?: () => Promise<{ plan?: string; features?: string[] }>;
  readonly cursor?: number;
  readonly orrSummary?: { overall?: string; disposition?: string; path?: string };
  /** When set, live policy samples use this cache (avoids evaluate-on-every-paint). */
  readonly policyCache?: import("./policy-cache.js").PolicySampleCache;
  /** Force a fresh live policy sample (ignores TTL). */
  readonly forcePolicyEval?: boolean;
}

export interface DashSnapshot {
  readonly frame: string;
  readonly plan: Entitlement["plan"];
  readonly pane: DashPane;
  readonly agents: readonly { id: string; name: string; status?: string }[];
  readonly approvals: readonly { id: string; status: string; action?: string }[];
  readonly sessions: readonly { id: string; risk?: string; host?: string; clearance?: string }[];
}

export async function renderDash(
  config: ResolvedConfig,
  options: DashOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DashSnapshot> {
  const plane = options.fetchPlaneEntitlement
    ? await options.fetchPlaneEntitlement().catch(() => undefined)
    : undefined;
  const ent = resolveEntitlement({ env, cwd: config.cwd, plane });
  const offline = options.offline || config.offline;
  const pane = options.pane;
  const hasKey = Boolean(config.apiKey && config.apiKey.trim());
  const packed = await bodyFor(config, { ...options, offline }, ent, pane, hasKey, env);

  const status: StatusStrip = {
    plan: ent.plan === "enterprise" ? "ENTERPRISE" : "FREE",
    host: config.host,
    plane: offline ? "offline" : config.baseUrl || "unset",
    pane,
  };
  const text = frame(status, ent, packed.body);
  assertNoSecrets(text);
  if (config.apiKey && config.apiKey.length >= 8 && text.includes(config.apiKey)) {
    throw new Error("dashboard frame leaked api key");
  }
  return {
    frame: text,
    plan: ent.plan,
    pane,
    agents: packed.agents,
    approvals: packed.approvals,
    sessions: packed.sessions,
  };
}

interface PackedBody {
  readonly body: readonly string[];
  readonly agents: DashSnapshot["agents"];
  readonly approvals: DashSnapshot["approvals"];
  readonly sessions: DashSnapshot["sessions"];
}

function pack(
  body: readonly string[],
  extra?: Partial<PackedBody>,
): PackedBody {
  return {
    body,
    agents: extra?.agents ?? [],
    approvals: extra?.approvals ?? [],
    sessions: extra?.sessions ?? [],
  };
}

async function bodyFor(
  config: ResolvedConfig,
  options: DashOptions,
  ent: Entitlement,
  pane: DashPane,
  hasKey: boolean,
  env: NodeJS.ProcessEnv,
): Promise<PackedBody> {
  if (!paneAllowed(ent, pane)) return pack(lockedPane(pane));

  const live = !options.offline && hasKey && Boolean(options.client);
  const cursor = options.cursor ?? 0;

  switch (pane) {
    case "home":
      return pack(
        homeBody({
          version: DASH_VERSION,
          offline: options.offline,
          hasApiKey: hasKey,
          baseUrl: config.baseUrl,
          agentId: config.agentId,
        }),
      );
    case "policy":
      if (options.offline) return pack(policyOfflineBody());
      if (!live) return pack(needsPlaneBody("policy"));
      {
        const force = Boolean(options.forcePolicyEval);
        if (options.policyCache) {
          const { evals, fromCache } = await options.policyCache.get(
            options.client!,
            force,
          );
          return pack(policyLiveBody(evals, fromCache));
        }
        return pack(policyLiveBody(await sampleLiveEvals(options.client!), false));
      }
    case "agents": {
      if (!live) return pack(agentsOfflineBody(config.agentId));
      const agents = await loadAgents(options.client!);
      return pack(agentsLiveBody(agents, cursor), { agents });
    }
    case "approvals": {
      if (!live) return pack(needsPlaneBody("approvals"));
      const approvals = await loadApprovals(options.client!);
      return pack(approvalsLiveBody(approvals, cursor), { approvals });
    }
    case "sessions":
      if (!live) return pack(needsPlaneBody("sessions"));
      try {
        const sessions = await loadSessions(options.client!);
        return pack(sessionsLiveBody(sessions, cursor), { sessions });
      } catch {
        return pack(["Could not load sessions from the plane."]);
      }
    case "orr":
      return pack(orrBody(options.orrSummary));
    case "mcp":
      return pack(mcpBody({ host: config.host, hasApiKey: hasKey }));
    case "sandbox": {
      const backend = String(env.KYA_SANDBOX ?? "").trim();
      const rows = loadSandboxState(config.cwd).map((r) => ({
        sandboxId: r.sandboxId,
        status: r.status,
        backend: r.backend,
      }));
      return pack(sandboxBody({ backend, rows }));
    }
    case "dashboard":
      if (!live) return pack(needsPlaneBody("dashboard"));
      return pack(dashboardBody(await loadDashboard(options.client!)));
    case "cases":
      if (!live) return pack(needsPlaneBody("cases"));
      return pack(await loadCases(options.client!));
    case "metrics":
      if (!live) return pack(needsPlaneBody("metrics"));
      return pack(metricsBody(await loadMetrics(options.client!)));
    case "edge":
      if (!live) return pack(needsPlaneBody("edge"));
      return pack(edgeBody(await loadEdge(options.client!)));
    case "settings":
      if (!live) return pack(needsPlaneBody("settings"));
      return pack(
        settingsBody([
          "API keys / team / SSO / billing stay on the web console.",
          "OSS desk: kya agents | kill | wrap | invoke | shrink",
        ]),
      );
    default:
      return pack([`unknown pane: ${String(pane)}`]);
  }
}

async function sampleLiveEvals(client: KyaHttpClient): Promise<PolicyEvaluateResponse[]> {
  const deny = await client.evaluatePolicy({
    toolId: "org.sample.never.event",
    irreversible: true,
  });
  const ra = await client.evaluatePolicy({
    toolId: "org.sample.data.write",
    irreversible: true,
  });
  return [deny, ra];
}

async function loadAgents(
  client: KyaHttpClient,
): Promise<{ id: string; name: string; status?: string }[]> {
  try {
    const rows = await client.listAgents();
    return rows.map((a) => ({ id: a.id, name: a.name, status: a.status }));
  } catch {
    return [];
  }
}

async function loadApprovals(
  client: KyaHttpClient,
): Promise<{ id: string; status: string; action?: string }[]> {
  const rows = await client.request<Array<{ id: string; status: string; action?: string }>>(
    "/api/v1/kya/approvals",
  );
  return Array.isArray(rows) ? rows : [];
}

async function loadSessions(
  client: KyaHttpClient,
): Promise<{ id: string; risk?: string; host?: string }[]> {
  try {
    const rows = await client.listSessions();
    return rows.map((s) => ({
      id: s.id,
      risk: s.riskLevel,
      host: s.host,
      clearance: s.clearance,
    }));
  } catch {
    throw new Error("sessions_unavailable");
  }
}

async function loadDashboard(client: KyaHttpClient) {
  const [approvals, metrics] = await Promise.all([
    loadApprovals(client).catch(() => []),
    loadMetrics(client),
  ]);
  const pending = approvals.filter((a) => /pending/i.test(a.status)).length;
  return {
    pendingApprovals: pending,
    agentCount: Number(metrics["agentCount"] ?? Number.NaN),
    policyDeny: Number(metrics["policyDeny"] ?? 0),
    approveRequired: Number(metrics["approveRequired"] ?? 0),
    approveGranted: Number(metrics["approveGranted"] ?? 0),
  };
}

async function loadCases(client: KyaHttpClient): Promise<readonly string[]> {
  try {
    const rows = await client.request<Array<{ id: string; status?: string; amount?: string }>>(
      "/api/v1/kya/cases",
    );
    if (!Array.isArray(rows)) {
      return [
        "Cases list is not available on this plane.",
        "Use the web console /app/kya/cases (observational — not a PEP).",
      ];
    }
    return casesBody(rows);
  } catch {
    return [
      "GET /api/v1/kya/cases is not on this plane yet.",
      "Use the web console /app/kya/cases. Observational only — does not approve submit.",
    ];
  }
}

async function loadMetrics(client: KyaHttpClient): Promise<Record<string, string | number | boolean>> {
  try {
    const m = await client.request<Record<string, string | number | boolean>>(
      "/api/v1/kya/metrics",
    );
    return m && typeof m === "object" ? m : {};
  } catch {
    return { error: "metrics unavailable" };
  }
}

async function loadEdge(client: KyaHttpClient): Promise<Record<string, string | boolean | number>> {
  try {
    return await client.request<Record<string, string | boolean | number>>("/api/v1/kya/edge");
  } catch {
    return { error: "edge status unavailable" };
  }
}

/** Offline sample used by tests — production PEP is HTTP. */
export function offlinePolicyPair(): {
  deny: PolicyEvaluateResponse;
  requireApprove: PolicyEvaluateResponse;
} {
  return {
    deny: evaluateOffline({
      toolId: "org.sample.never.event",
      irreversible: true,
      env: { host: "ide" },
    }),
    requireApprove: evaluateOffline({
      toolId: "org.sample.data.write",
      irreversible: true,
      env: { host: "ide" },
    }),
  };
}
