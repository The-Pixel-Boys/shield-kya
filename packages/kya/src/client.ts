import { AuthRequiredError, HttpError, KyaError } from "./errors.js";
import type { Host } from "./config.js";
import { computeArgsHash } from "./hash.js";
import { findSampleTool } from "./sample-tools.js";

export type FetchLike = typeof fetch;

export interface KyaClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly host?: Host;
  readonly agentId?: string;
  /** When false, skip auth check (tests only). Default true. */
  readonly requireApiKey?: boolean;
}

export interface PolicyEvaluateRequest {
  readonly toolId: string;
  readonly action?: string;
  readonly argsHash?: string;
  readonly irreversible?: boolean;
  readonly actionClass?: string;
  readonly dataClass?: string;
  readonly sessionRisk?: string;
  readonly approvalStatus?: string;
  readonly packId?: string | null;
  readonly env?: {
    readonly host: Host;
    readonly sessionId?: string;
    readonly agentId?: string;
    readonly correlationId?: string;
  };
}

export interface PolicyEvaluateResponse {
  readonly verdict: string;
  readonly reasonCode: string;
  readonly toolId?: string;
  readonly argsHash?: string;
  readonly localVerdict?: string;
  readonly sessionRisk?: string;
  readonly host?: string;
  readonly opaAllow?: boolean;
  readonly opaReason?: string;
}

export interface RegisterAgentRequest {
  readonly name: string;
  readonly versionHash: string;
}

export interface AgentResponse {
  readonly id: string;
  readonly orgId?: string;
  readonly name: string;
  readonly status?: string;
  readonly versionHash?: string;
  readonly createdAt?: string;
}

export interface SessionIngestRequest {
  readonly sessionId: string;
  readonly source?: string;
  readonly model?: string;
  readonly hostname?: string;
  readonly projectPath?: string;
  readonly riskLevel?: string;
  readonly hitCodes?: readonly string[];
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly host?: Host;
}

export interface SessionIngestResponse {
  readonly id: string;
  readonly riskLevel: string;
  readonly host?: string;
}

export interface CreateApprovalRequest {
  readonly agentId: string;
  readonly disputeId: string;
  readonly packVersion?: string;
  readonly action?: string;
  readonly toolId?: string;
}

export interface ApprovalResponse {
  readonly id: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

/**
 * Minimal HTTP client for light CLI / MCP gate.
 * Base URL is control-plane origin (e.g. http://127.0.0.1:8090).
 * Paths are absolute under /api/v1/kya/*.
 */
export class KyaHttpClient {
  readonly baseUrl: string;
  readonly host: Host;
  readonly agentId: string | undefined;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: KyaClientOptions) {
    const requireKey = options.requireApiKey !== false;
    if (requireKey && (!options.apiKey || options.apiKey.trim() === "")) {
      throw new AuthRequiredError();
    }
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey.trim();
    this.host = options.host ?? "ide";
    this.agentId = options.agentId;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new KyaError("global fetch unavailable; Node 20+ required", "NO_FETCH");
    }
    this.fetchImpl = fetchImpl;
  }

  async registerAgent(body: RegisterAgentRequest): Promise<AgentResponse> {
    return this.request<AgentResponse>("/api/v1/kya/agents", {
      method: "POST",
      body,
    });
  }

  async evaluatePolicy(req: PolicyEvaluateRequest): Promise<PolicyEvaluateResponse> {
    const toolId = req.toolId;
    const sample = findSampleTool(toolId);
    const body = {
      toolId,
      action: req.action ?? toolId,
      argsHash: req.argsHash,
      irreversible: req.irreversible ?? sample?.irreversible ?? false,
      actionClass: req.actionClass ?? sample?.actionClass,
      dataClass: req.dataClass ?? sample?.dataClass,
      sessionRisk: req.sessionRisk ?? "LOW",
      approvalStatus: req.approvalStatus ?? "NONE",
      packId: req.packId === undefined ? "generic" : req.packId,
      env: req.env ?? {
        host: this.host,
        agentId: this.agentId,
      },
    };
    return this.request<PolicyEvaluateResponse>("/api/v1/kya/policy/evaluate", {
      method: "POST",
      body,
    });
  }

  async ingestSession(req: SessionIngestRequest): Promise<SessionIngestResponse> {
    return this.request<SessionIngestResponse>("/api/v1/kya/sessions/ingest", {
      method: "POST",
      body: {
        ...req,
        host: req.host ?? this.host,
      },
    });
  }

  async requestApproval(req: CreateApprovalRequest): Promise<ApprovalResponse> {
    return this.request<ApprovalResponse>("/api/v1/kya/approvals", {
      method: "POST",
      body: {
        agentId: req.agentId,
        disputeId: req.disputeId,
        packVersion: req.packVersion ?? "generic",
        action: req.action ?? req.toolId,
        toolId: req.toolId ?? req.action,
      },
    });
  }

  async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "shield-agent-kya-cli/0.1.0",
      ...(options.headers ?? {}),
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(url, { method, headers, body });
    const text = await response.text();
    const parsed = parseJsonSafe(text);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AuthRequiredError(
          `control plane rejected credentials (HTTP ${response.status})`,
        );
      }
      let msg = `HTTP ${response.status} ${method} ${path}`;
      if (
        parsed &&
        typeof parsed === "object" &&
        "message" in parsed &&
        typeof (parsed as { message: unknown }).message === "string"
      ) {
        msg = (parsed as { message: string }).message;
      }
      throw new HttpError(response.status, msg, parsed);
    }

    return parsed as T;
  }
}

export function buildEvaluateFromToolArgs(input: {
  toolId: string;
  args?: unknown;
  irreversible?: boolean;
  host: Host;
  agentId?: string;
  sessionRisk?: string;
  approvalStatus?: string;
}): PolicyEvaluateRequest {
  const args = input.args ?? {};
  return {
    toolId: input.toolId,
    action: input.toolId,
    argsHash: computeArgsHash(args),
    irreversible: input.irreversible,
    sessionRisk: input.sessionRisk ?? "LOW",
    approvalStatus: input.approvalStatus ?? "NONE",
    env: {
      host: input.host,
      agentId: input.agentId,
    },
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function parseJsonSafe(text: string): unknown {
  if (!text || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
