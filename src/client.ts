import { setTimeout as sleep } from "node:timers/promises";
import { AuthRequiredError, HttpError, KyaError, UsageError } from "./errors.js";
import type { Host } from "./config.js";
import { computeArgsHash } from "./hash.js";
import { findSampleTool } from "./sample-tools.js";
import { CLI_VERSION } from "./version.js";
import { parseUsageRecords } from "./showback/cost-per-task.js";
import { ensureOtlpMetrics, otlpEnabled, recordClientEvaluate } from "./otel.js";

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
  /** Redacted one-line change summary (write/edit tools). */
  readonly summary?: string;
  /** Clipped, redacted change preview (≤8 lines / ≤480 chars). */
  readonly diffPreview?: string;
  /** Redacted target file path (≤80 chars). */
  readonly targetPath?: string;
  readonly env?: {
    readonly host: Host;
    readonly sessionId?: string;
    readonly agentId?: string;
    readonly correlationId?: string;
    readonly sandboxId?: string;
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
  /** Never-list input rule that denied the call (rule id only, never the command or path). */
  readonly ruleId?: string;
}

export interface RegisterAgentRequest {
  readonly name: string;
  readonly versionHash: string;
  readonly breakGlassReason?: string;
}

export interface AgentResponse {
  readonly id: string;
  readonly orgId?: string;
  readonly name: string;
  readonly status?: string;
  readonly versionHash?: string;
  readonly createdAt?: string;
}

export interface SessionUsageRow {
  readonly agentId: string;
  readonly parentRunId?: string;
  readonly runId?: string;
  readonly model?: string;
  readonly route?: string;
  readonly environment?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly reasoningTokens?: number;
  readonly retries?: number;
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
  /** Observe-only. Not a billing meter. Does not mint agents. */
  readonly usage?: readonly SessionUsageRow[];
}

export interface SessionIngestResponse {
  readonly id: string;
  readonly riskLevel: string;
  readonly host?: string;
}

export interface InvokeToolRequest {
  readonly toolId: string;
  readonly agentId?: string;
  readonly argsHash?: string;
  readonly args?: unknown;
  readonly host?: Host;
  readonly actionClass?: string;
  readonly irreversible?: boolean;
  readonly risk?: string;
}

export interface InvokeToolResponse {
  readonly ok: boolean;
  readonly verdict: string;
  readonly reasonCode: string;
  readonly toolId: string;
  readonly argsHash: string;
  readonly dispatched: string;
  readonly approvalRequestId?: string | null;
  readonly sideEffect: string;
}

export interface CreateApprovalRequest {
  readonly agentId: string;
  /** Plane field name is work-item id (legacy `disputeId` on the wire). */
  readonly disputeId: string;
  readonly packVersion?: string;
  readonly action?: string;
  readonly toolId?: string;
  readonly argsHash?: string;
  readonly host?: Host;
  readonly irreversible?: boolean;
  readonly reasonCode?: string;
}

export interface ApprovalResponse {
  readonly id: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

export type SessionClearance = "READ" | "BUILD" | "DEPLOY";

export interface SessionListItem {
  readonly id: string;
  readonly sessionId?: string;
  readonly riskLevel?: string;
  readonly host?: string;
  readonly source?: string;
  readonly model?: string;
  readonly clearance?: string;
}

export interface ShrinkResponse {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export function isMachineApiKey(apiKey: string): boolean {
  return apiKey.trim().startsWith("sk_");
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
      throw new KyaError("global fetch unavailable; Node.js 22+ required", "NO_FETCH");
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
      summary: req.summary,
      diffPreview: req.diffPreview,
      targetPath: req.targetPath,
      env: req.env ?? {
        host: this.host,
        agentId: this.agentId,
      },
    };
    if (otlpEnabled()) await ensureOtlpMetrics();
    const started = Date.now();
    const response = await this.request<PolicyEvaluateResponse>(
      "/api/v1/kya/policy/evaluate",
      {
        method: "POST",
        body,
      },
    );
    const verified = requireVerdict(response);
    recordClientEvaluate({
      verdict: verified.verdict,
      host: body.env?.host ?? this.host,
      latencyMs: Date.now() - started,
    });
    return verified;
  }

  async ingestSession(req: SessionIngestRequest): Promise<SessionIngestResponse> {
    const usage = req.usage ? parseUsageRecords(req.usage) : undefined;
    return this.request<SessionIngestResponse>("/api/v1/kya/sessions/ingest", {
      method: "POST",
      body: {
        ...req,
        host: req.host ?? this.host,
        ...(usage && usage.length > 0 ? { usage } : { usage: undefined }),
      },
    });
  }

  async invokeTool(req: InvokeToolRequest): Promise<InvokeToolResponse> {
    const toolId = req.toolId.trim();
    if (!toolId) {
      throw new UsageError("invoke requires --tool-id");
    }
    const agentId = (req.agentId ?? this.agentId ?? "").trim();
    if (!agentId) {
      throw new UsageError("invoke requires --agent-id or KYA_AGENT_ID");
    }
    const argsHash = (req.argsHash ?? computeArgsHash(req.args ?? {})).trim();
    return this.request<InvokeToolResponse>("/api/v1/kya/tools/invoke", {
      method: "POST",
      body: {
        agentId,
        toolId,
        argsHash,
        host: req.host ?? this.host,
        actionClass: req.actionClass,
        irreversible: req.irreversible ?? true,
        risk: req.risk ?? "LOW",
      },
    });
  }

  /**
   * Retries a busy plane (503 kya.approval_busy). Safe: the plane gives busy before
   * any write, and a create with the same work item returns the existing row (dedup).
   */
  async requestApproval(
    req: CreateApprovalRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApprovalResponse> {
    return this.request<ApprovalResponse>("/api/v1/kya/approvals", {
      method: "POST",
      signal: opts.signal,
      retryBusy: true,
      body: {
        agentId: req.agentId,
        disputeId: req.disputeId,
        packVersion: req.packVersion ?? "generic",
        action: req.action ?? req.toolId,
        toolId: req.toolId ?? req.action,
        argsHash: req.argsHash,
        host: req.host ?? this.host,
        irreversible: req.irreversible,
        reasonCode: req.reasonCode,
      },
    });
  }

  async listAgents(): Promise<AgentResponse[]> {
    const rows = await this.request<AgentResponse[] | { agents?: AgentResponse[] }>(
      "/api/v1/kya/agents",
    );
    if (Array.isArray(rows)) return rows;
    return Array.isArray(rows?.agents) ? rows.agents : [];
  }

  async getAgent(id: string): Promise<AgentResponse> {
    const trimmed = id.trim();
    if (!trimmed) throw new UsageError("agent id required");
    return this.request<AgentResponse>(`/api/v1/kya/agents/${encodeURIComponent(trimmed)}`);
  }

  async killAgent(id: string): Promise<AgentResponse> {
    const trimmed = id.trim();
    if (!trimmed) throw new UsageError("agent id required");
    return this.request<AgentResponse>(
      `/api/v1/kya/agents/${encodeURIComponent(trimmed)}/kill`,
      { method: "POST" },
    );
  }

  async getPassport(id: string): Promise<Record<string, unknown>> {
    const trimmed = id.trim();
    if (!trimmed) throw new UsageError("agent id required");
    return this.request<Record<string, unknown>>(
      `/api/v1/kya/agents/${encodeURIComponent(trimmed)}/passport`,
    );
  }

  async listApprovals(): Promise<ApprovalResponse[]> {
    const rows = await this.request<ApprovalResponse[]>("/api/v1/kya/approvals");
    return Array.isArray(rows) ? rows : [];
  }

  async listSessions(): Promise<SessionListItem[]> {
    const rows = await this.request<SessionListItem[]>("/api/v1/kya/sessions");
    return Array.isArray(rows) ? rows : [];
  }

  async shrinkSession(id: string, to: SessionClearance): Promise<ShrinkResponse> {
    const trimmed = id.trim();
    if (!trimmed) throw new UsageError("session id required");
    return this.request<ShrinkResponse>(
      `/api/v1/kya/sessions/${encodeURIComponent(trimmed)}/shrink`,
      { method: "POST", body: { to } },
    );
  }

  /**
   * Human decide. Requires kya.approve. Never called by wrap or offline eval.
   * Retries a busy plane (503 kya.approval_busy): the plane gives busy when the
   * row lock wait times out, before any write, so nothing changed. A decide that another call already
   * made gives 409 kya.approval_already_decided, never a second decision.
   */
  async decideApproval(
    id: string,
    decision: "approve" | "reject",
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApprovalResponse> {
    const trimmed = id.trim();
    if (!trimmed) {
      throw new UsageError("approval id required");
    }
    const res = await this.request<ApprovalResponse>(
      `/api/v1/kya/approvals/${encodeURIComponent(trimmed)}/${decision}`,
      { method: "POST", signal: opts.signal, retryBusy: true },
    );
    if (!res || typeof res.id !== "string" || typeof res.status !== "string") {
      throw new HttpError(200, "approval decide returned no id/status", res);
    }
    return res;
  }

  async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      /**
       * Retry 503 kya.approval_busy. Only for calls that are safe to send again
       * (approval create and decide). Other calls never retry.
       */
      retryBusy?: boolean;
    } = {},
  ): Promise<T> {
    if (!options.retryBusy) return this.attempt<T>(path, options);
    // Monotonic clock: a wall clock change cannot move the deadline.
    const started = performance.now();
    for (let retries = 0; ; retries++) {
      try {
        return await this.attempt<T>(path, options);
      } catch (err) {
        if (!isApprovalBusy(err)) throw err;
        const waitMs = busyWaitMs(err.retryAfter);
        // ponytail: the deadline stops new waits and attempts. An attempt that has
        // started keeps its own 15 s timeout (no caller signal), so the worst case
        // is about 20 s + 15 s.
        if (retries >= BUSY_MAX_RETRIES || performance.now() - started + waitMs > BUSY_DEADLINE_MS) {
          const busy = new KyaError("approval service busy; retry later", "PLANE_BUSY", 1);
          busy.cause = err;
          throw busy;
        }
        try {
          await sleep(waitMs, undefined, { signal: options.signal });
        } catch (abortErr) {
          // Same rule as a fetch abort: the caller gets its own abort reason.
          throw options.signal?.reason ?? abortErr;
        }
      }
    }
  }

  /** One HTTP call with the default 15 s timeout (or the caller signal). */
  private async attempt<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const method = options.method ?? "GET";
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `shield-agent-kya-cli/${CLI_VERSION}`,
      ...(options.headers ?? {}),
    };
    if (this.apiKey) {
      applyPlaneAuth(headers, this.apiKey);
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(options.body);
    }

    // Kept in a local so the catch can tell our timeout from any other abort.
    const defaultSignal = options.signal ? undefined : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: "error",
        signal: options.signal ?? defaultSignal,
      });
      // The same signal also covers the body read.
      text = await response.text();
    } catch (err) {
      // Only the default timeout gets the new message. A caller signal or any
      // other abort keeps its own error.
      const name = (err as Error | undefined)?.name;
      if (defaultSignal?.aborted && (name === "TimeoutError" || name === "AbortError")) {
        const timeout = new KyaError(
          timeoutMessage(this.baseUrl, method, path),
          "PLANE_HTTP_TIMEOUT",
          1,
        );
        // SDK users can still read the original error name.
        timeout.cause = err;
        throw timeout;
      }
      throw err;
    }
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
      throw new HttpError(
        response.status,
        msg,
        parsed,
        // Optional chain: injected fetch stubs may return a Response-like object with no headers.
        response.headers?.get("retry-after") ?? undefined,
      );
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
  sandboxId?: string;
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
      sandboxId: input.sandboxId,
    },
  };
}

/** Default wait for one control plane request (headers and body). */
const REQUEST_TIMEOUT_MS = 15_000;

/** Busy approval retry: 1 call plus at most 3 retries, all inside 20 s. */
const BUSY_MAX_RETRIES = 3;
const BUSY_DEADLINE_MS = 20_000;
const BUSY_DEFAULT_WAIT_S = 2;
const BUSY_MAX_WAIT_MS = 10_000;

function isApprovalBusy(err: unknown): err is HttpError {
  if (!(err instanceof HttpError) || err.status !== 503) return false;
  const body = err.body as { error?: { code?: unknown } } | undefined;
  return body?.error?.code === "kya.approval_busy";
}

/**
 * Wait before a busy retry. Retry-After counts only as delta-seconds (digits).
 * An HTTP-date, a negative, an empty or any other value gives the 2 s default.
 * Adds up to 20 percent jitter. The result is never more than 10 s.
 */
export function busyWaitMs(
  retryAfter: string | null | undefined,
  random: () => number = Math.random,
): number {
  const v = (retryAfter ?? "").trim();
  const seconds = /^\d+$/.test(v) ? Number(v) : BUSY_DEFAULT_WAIT_S;
  return Math.min(seconds * 1000 * (1 + 0.2 * random()), BUSY_MAX_WAIT_MS);
}

/**
 * Method and the full request URL: origin, base path and request path. No
 * userinfo, no query, no fragment. Never the API key.
 */
function timeoutMessage(baseUrl: string, method: string, path: string): string {
  // Same normalization as the request URL: "agents" and "/agents" give one target.
  const p = path.startsWith("/") ? path : `/${path}`;
  const cleanPath = p.split(/[?#]/, 1)[0];
  let target = cleanPath;
  try {
    const base = new URL(baseUrl);
    target = `${base.origin}${base.pathname.replace(/\/+$/, "")}${cleanPath}`;
  } catch {
    /* keep the path only */
  }
  return (
    `control plane did not answer ${method} ${target} within ${REQUEST_TIMEOUT_MS / 1000} seconds. ` +
    "Check the base URL (KYA_BASE_URL or --base-url), check your network, then try again. " +
    "Hosted hooks are not affected: they use their own time budget."
  );
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Machine keys use X-API-Key. JWTs stay Bearer. */
export function applyPlaneAuth(headers: Record<string, string>, apiKey: string): void {
  if (apiKey.startsWith("sk_")) {
    headers["X-API-Key"] = apiKey;
    return;
  }
  headers.Authorization = `Bearer ${apiKey}`;
}

function parseJsonSafe(text: string): unknown {
  if (!text || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const VERDICTS = new Set(["ALLOW", "DENY", "REQUIRE_APPROVE"]);

function requireVerdict(response: PolicyEvaluateResponse): PolicyEvaluateResponse {
  const verdict = (response?.verdict ?? "").toUpperCase();
  if (!VERDICTS.has(verdict)) {
    throw new HttpError(502, "control plane returned no verdict", response);
  }
  return { ...response, verdict };
}
