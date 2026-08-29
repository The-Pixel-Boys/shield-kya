import type { ResolvedConfig } from "../config.js";
import {
  KyaHttpClient,
  type AgentResponse,
  type ApprovalResponse,
  type SessionClearance,
  type SessionListItem,
  type ShrinkResponse,
} from "../client.js";
import { UsageError } from "../errors.js";
import type { ParsedArgs } from "../parse-args.js";
import { flagString } from "../parse-args.js";

export function requireId(parsed: ParsedArgs, verb: string): string {
  const id = flagString(parsed.flags, "id") ?? parsed.positionals[0];
  if (!id?.trim()) {
    throw new UsageError(`${verb} requires --id <id>`);
  }
  return id.trim();
}

export function shrinkToFromArgs(parsed: ParsedArgs): SessionClearance {
  const raw = (flagString(parsed.flags, "to") ?? "BUILD").trim().toUpperCase();
  if (raw !== "READ" && raw !== "BUILD" && raw !== "DEPLOY") {
    throw new UsageError("shrink --to must be BUILD, READ, or DEPLOY");
  }
  return raw;
}

function clientOf(config: ResolvedConfig, existing?: KyaHttpClient): KyaHttpClient {
  return (
    existing ??
    new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      host: config.host,
      agentId: config.agentId,
    })
  );
}

export async function runListAgents(
  config: ResolvedConfig,
  existing?: KyaHttpClient,
): Promise<AgentResponse[]> {
  return clientOf(config, existing).listAgents();
}

export async function runGetAgent(
  config: ResolvedConfig,
  id: string,
  existing?: KyaHttpClient,
): Promise<AgentResponse> {
  return clientOf(config, existing).getAgent(id);
}

export async function runKillAgent(
  config: ResolvedConfig,
  id: string,
  existing?: KyaHttpClient,
): Promise<AgentResponse> {
  return clientOf(config, existing).killAgent(id);
}

export async function runGetPassport(
  config: ResolvedConfig,
  id: string,
  existing?: KyaHttpClient,
): Promise<Record<string, unknown>> {
  return clientOf(config, existing).getPassport(id);
}

export async function runListApprovals(
  config: ResolvedConfig,
  existing?: KyaHttpClient,
): Promise<ApprovalResponse[]> {
  return clientOf(config, existing).listApprovals();
}

export async function runListSessions(
  config: ResolvedConfig,
  existing?: KyaHttpClient,
): Promise<SessionListItem[]> {
  return clientOf(config, existing).listSessions();
}

export async function runShrinkSession(
  config: ResolvedConfig,
  id: string,
  to: SessionClearance,
  existing?: KyaHttpClient,
): Promise<ShrinkResponse> {
  return clientOf(config, existing).shrinkSession(id, to);
}

export function formatAgentTable(rows: readonly AgentResponse[]): string {
  if (rows.length === 0) return "no agents";
  return rows
    .map((a) => `${a.status ?? "?"}  ${a.id}  ${a.name}`)
    .join("\n");
}

export function formatApprovalTable(rows: readonly ApprovalResponse[]): string {
  if (rows.length === 0) return "no approvals";
  return rows
    .map((a) => `${a.status}  ${a.id}  ${String(a.action ?? a.toolId ?? "")}`)
    .join("\n");
}

export function formatSessionTable(rows: readonly SessionListItem[]): string {
  if (rows.length === 0) return "no sessions";
  return rows
    .map(
      (s) =>
        `${s.clearance ?? "DEPLOY"}  ${s.riskLevel ?? "?"}  ${s.id}  ${s.sessionId ?? ""}  ${s.host ?? ""}`,
    )
    .join("\n");
}
