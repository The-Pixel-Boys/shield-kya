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
  sessionsLiveBody,
} from "./screens/free.js";
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
}

export interface DashSnapshot {
  readonly frame: string;
  readonly plan: Entitlement["plan"];
  readonly pane: DashPane;
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
  const body = await bodyFor(config, { ...options, offline }, ent, pane, hasKey);

  const status: StatusStrip = {
    plan: ent.plan === "enterprise" ? "ENTERPRISE" : "FREE",
    host: config.host,
    plane: offline ? "offline" : config.baseUrl || "unset",
    pane,
  };
  const text = frame(status, ent, body);
  assertNoSecrets(text);
  if (config.apiKey && config.apiKey.length >= 8 && text.includes(config.apiKey)) {
    throw new Error("dashboard frame leaked api key");
  }
  return { frame: text, plan: ent.plan, pane };
}

async function bodyFor(
  config: ResolvedConfig,
  options: DashOptions,
  ent: Entitlement,
  pane: DashPane,
  hasKey: boolean,
): Promise<readonly string[]> {
  if (!paneAllowed(ent, pane)) return lockedPane(pane);

  const live = !options.offline && hasKey && Boolean(options.client);

  switch (pane) {
    case "home":
      return homeBody({
        version: DASH_VERSION,
        offline: options.offline,
        hasApiKey: hasKey,
        baseUrl: config.baseUrl,
        agentId: config.agentId,
      });
    case "policy":
      if (options.offline) return policyOfflineBody();
      if (!live) return needsPlaneBody("policy");
      return policyLiveBody(await sampleLiveEvals(options.client!));
    case "agents":
      if (!live) return agentsOfflineBody(config.agentId);
      return agentsLiveBody(await loadAgents(options.client!, config.agentId));
    case "approvals":
      if (!live) return needsPlaneBody("approvals");
      return approvalsLiveBody(await loadApprovals(options.client!));
    case "sessions":
      if (!live) return needsPlaneBody("sessions");
      try {
        return sessionsLiveBody(await loadSessions(options.client!));
      } catch {
        return ["Could not load sessions from the plane."];
      }
    case "orr":
      return orrBody();
    case "mcp":
      return mcpBody({ host: config.host, hasApiKey: hasKey });
    case "dashboard":
      if (!live) return needsPlaneBody("dashboard");
      return dashboardBody(await loadDashboard(options.client!));
    case "cases":
      if (!live) return needsPlaneBody("cases");
      return loadCases(options.client!);
    case "metrics":
      if (!live) return needsPlaneBody("metrics");
      return metricsBody(await loadMetrics(options.client!));
    case "edge":
      if (!live) return needsPlaneBody("edge");
      return edgeBody(await loadEdge(options.client!));
    case "settings":
      if (!live) return needsPlaneBody("settings");
      return settingsBody([
        "API keys / team / SSO / billing: use the web console for mutations; TUI is read-first.",
      ]);
    default:
      return [`unknown pane: ${String(pane)}`];
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
  agentId?: string,
): Promise<{ id: string; name: string; status?: string }[]> {
  if (!agentId) return [];
  try {
    const a = await client.request<{ id: string; name: string; status?: string }>(
      `/api/v1/kya/agents/${agentId}`,
    );
    return [{ id: a.id, name: a.name, status: a.status }];
  } catch {
    return [{ id: agentId, name: "(unreachable)", status: "?" }];
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
    const rows = await client.request<Array<{ id: string; riskLevel?: string; host?: string }>>(
      "/api/v1/kya/sessions",
    );
    return (Array.isArray(rows) ? rows : []).map((s) => ({
      id: s.id,
      risk: s.riskLevel,
      host: s.host,
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
