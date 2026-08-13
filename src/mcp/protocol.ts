/**
 * MCP tool surface for local gate — proxies to Shield KYA (sole PEP).
 * Does not execute irreversible side effects; only evaluate / ingest / request approval.
 * Host-agnostic: stdio or HTTP transport.
 */

import { randomUUID } from "node:crypto";
import type { KyaHttpClient } from "../client.js";
import type { Host } from "../config.js";
import { computeArgsHash } from "../hash.js";
import { findSampleTool } from "../sample-tools.js";
import { CLI_VERSION } from "../version.js";

export const MCP_SERVER_INFO = {
  name: "shield-kya",
  version: CLI_VERSION,
  title: "Shield Agent AI (KYA)",
  description:
    "Know Your Agent control plane: policy evaluate, session observe, and high-stakes gates. Standard MCP tools; no proprietary client protocol.",
} as const;

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: "kya.policy_evaluate",
    description:
      "Evaluate ALLOW | DENY | REQUIRE_APPROVE for an agent action at the tool boundary. Sole PEP is Shield KYA; missing APPROVED means no irreversible side effect.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action or toolId" },
        toolId: { type: "string", description: "Stable tool id (preferred)" },
        agentId: { type: "string" },
        irreversible: { type: "boolean" },
        sessionRisk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        approvalStatus: {
          type: "string",
          enum: ["NONE", "PENDING", "APPROVED", "REJECTED"],
        },
        args: { type: "object", description: "Tool args (hashed, not logged raw)" },
        argsHash: { type: "string" },
        host: { type: "string", enum: ["ide", "runtime"] },
        context: { type: "object" },
      },
      required: [],
    },
  },
  {
    name: "kya.session_ingest",
    description:
      "Ingest an AgentEvent-compatible session observation for raise-only risk. Risk may only raise severity, never auto-ALLOW.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "object" },
        sessionId: { type: "string" },
        host: { type: "string", enum: ["ide", "runtime"] },
        riskLevel: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        hitCodes: { type: "array", items: { type: "string" } },
        source: { type: "string" },
        model: { type: "string" },
        payload: { type: "object" },
      },
      required: [],
    },
  },
  {
    name: "kya.request_approval",
    description:
      "Open a human approval request for a high-stakes side effect. Does not execute the side effect.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        toolId: { type: "string" },
        agentId: { type: "string" },
        resourceId: {
          type: "string",
          description: "Work-item / correlation UUID (mapped to disputeId binding)",
        },
        summary: { type: "string" },
        packVersion: { type: "string" },
      },
      required: ["action"],
    },
  },
] as const;

export interface McpCallResult {
  readonly content: readonly { type: "text"; text: string }[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

export interface McpHandlerContext {
  readonly client: KyaHttpClient;
  readonly host: Host;
  readonly agentId?: string;
}

export async function handleMcpToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: McpHandlerContext,
): Promise<McpCallResult> {
  const a = args ?? {};
  try {
    switch (name) {
      case "kya.policy_evaluate":
        return await callPolicyEvaluate(a, ctx);
      case "kya.session_ingest":
        return await callSessionIngest(a, ctx);
      case "kya.request_approval":
        return await callRequestApproval(a, ctx);
      default:
        return textResult({ error: `unknown tool: ${name}` }, true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult({ error: message }, true);
  }
}

async function callPolicyEvaluate(
  a: Record<string, unknown>,
  ctx: McpHandlerContext,
): Promise<McpCallResult> {
  const toolId = str(a.toolId) ?? str(a.action);
  if (!toolId) {
    return textResult({ error: "action or toolId required" }, true);
  }
  const sample = findSampleTool(toolId);
  const host = parseHost(str(a.host), ctx.host);
  const argsObj =
    a.args && typeof a.args === "object" && !Array.isArray(a.args)
      ? (a.args as Record<string, unknown>)
      : {};
  const argsHash = str(a.argsHash) ?? computeArgsHash(argsObj);
  const irreversible =
    typeof a.irreversible === "boolean"
      ? a.irreversible
      : (sample?.irreversible ?? false);

  const response = await ctx.client.evaluatePolicy({
    toolId,
    action: toolId,
    argsHash,
    irreversible,
    actionClass: sample?.actionClass,
    dataClass: sample?.dataClass,
    sessionRisk: str(a.sessionRisk) ?? "LOW",
    approvalStatus: str(a.approvalStatus) ?? "NONE",
    env: {
      host,
      agentId: str(a.agentId) ?? ctx.agentId,
    },
  });
  return textResult(response);
}

async function callSessionIngest(
  a: Record<string, unknown>,
  ctx: McpHandlerContext,
): Promise<McpCallResult> {
  const session =
    a.session && typeof a.session === "object" && !Array.isArray(a.session)
      ? (a.session as Record<string, unknown>)
      : {};
  const sessionId =
    str(a.sessionId) ??
    str(session.sessionId) ??
    str(session.id) ??
    randomUUID();
  const host = parseHost(
    str(a.host) ?? str(session.host),
    ctx.host,
  );
  const riskLevel =
    str(a.riskLevel) ??
    str(session.riskLevel) ??
    str(session.riskHint) ??
    "LOW";
  const hitCodes = Array.isArray(a.hitCodes)
    ? (a.hitCodes as string[])
    : Array.isArray(session.hitCodes)
      ? (session.hitCodes as string[])
      : undefined;
  const payload =
    (a.payload as Record<string, unknown> | undefined) ??
    (session.payload as Record<string, unknown> | undefined) ??
    (session.tools
      ? { tools: session.tools }
      : undefined);

  const response = await ctx.client.ingestSession({
    sessionId,
    source: str(a.source) ?? str(session.source) ?? "mcp-gate",
    model: str(a.model) ?? str(session.model),
    riskLevel,
    hitCodes,
    payload,
    host,
  });
  return textResult(response);
}

async function callRequestApproval(
  a: Record<string, unknown>,
  ctx: McpHandlerContext,
): Promise<McpCallResult> {
  const action = str(a.action) ?? str(a.toolId);
  if (!action) {
    return textResult({ error: "action required" }, true);
  }
  const agentId = str(a.agentId) ?? ctx.agentId;
  if (!agentId) {
    return textResult(
      {
        error:
          "agentId required (set KYA_AGENT_ID or pass agentId; run register-agent first)",
      },
      true,
    );
  }
  const resourceId = str(a.resourceId) ?? randomUUID();
  // Server expects UUID for disputeId work-item binding
  const disputeId = isUuid(resourceId) ? resourceId : randomUUID();

  const response = await ctx.client.requestApproval({
    agentId,
    disputeId,
    toolId: str(a.toolId) ?? action,
    action,
    packVersion: str(a.packVersion) ?? "generic",
  });

  return textResult({
    ...response,
    note: "Approval opened only — no side effect executed (fail closed until APPROVED)",
    summary: str(a.summary),
  });
}

function textResult(data: unknown, isError = false): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError,
    structuredContent: data,
  };
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

function parseHost(raw: string | undefined, fallback: Host): Host {
  if (raw === "ide" || raw === "runtime") return raw;
  return fallback;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
}

/** JSON-RPC 2.0 helpers for MCP stdio. */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export async function handleJsonRpc(
  msg: JsonRpcRequest,
  ctx: McpHandlerContext,
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  // notifications (no id) — process but no response for some
  try {
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: MCP_SERVER_INFO.name,
              version: MCP_SERVER_INFO.version,
            },
          },
        };
      case "notifications/initialized":
      case "initialized":
        return null;
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      case "tools/call": {
        const params = (msg.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (!params.name) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "tools/call requires name" },
          };
        }
        const result = await handleMcpToolCall(params.name, params.arguments, ctx);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: result.content,
            isError: result.isError ?? false,
          },
        };
      }
      default:
        if (msg.id === undefined) return null;
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (msg.id === undefined) return null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message },
    };
  }
}
