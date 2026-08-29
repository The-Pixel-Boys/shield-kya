import { evaluateOffline } from "../../offline-evaluate.js";
import { SAMPLE_TOOLS } from "../../sample-tools.js";
import type { PolicyEvaluateResponse } from "../../client.js";
import { table } from "../render.js";

export function homeBody(input: {
  readonly version: string;
  readonly offline: boolean;
  readonly hasApiKey: boolean;
  readonly baseUrl: string;
  readonly agentId?: string;
  readonly lastEval?: { toolId: string; verdict: string; reasonCode: string };
}): string[] {
  const lines = [
    "OSS desk. Same verbs as the CLI. Shield is the only PEP.",
    "Enterprise panes stay locked on this plan.",
    "",
    `cli          ${input.version}`,
    `offline      ${input.offline ? "yes (sample tools, not production PEP)" : "no"}`,
    `api key      ${input.hasApiKey ? "set" : "empty (fail-closed on live panes)"}`,
    `plane        ${input.offline ? "offline" : input.baseUrl}`,
    `agentId      ${input.agentId ?? "(none — kya register-agent)"}`,
    "",
    "2 policy (eval / wrap)   3 agents (list / kill)",
    "4 approvals (invoke)     5 sessions (shrink)",
    "6 orr  ·  7 mcp  ·  kya approve --id <id> (JWT)",
  ];
  if (input.lastEval) {
    lines.push(
      "",
      `last eval    ${input.lastEval.toolId} → ${input.lastEval.verdict} (${input.lastEval.reasonCode})`,
    );
  }
  return lines;
}

export function policyOfflineBody(): string[] {
  const deny = evaluateOffline({
    toolId: "org.sample.never.event",
    irreversible: true,
    env: { host: "ide" },
  });
  const ra = evaluateOffline({
    toolId: "org.sample.data.write",
    irreversible: true,
    env: { host: "ide" },
  });
  return [
    "Policy playground (offline sample — not the production PEP).",
    "Sole PEP in production is Shield HTTP evaluate.",
    "",
    ...table(
      ["tool", "verdict", "reason"],
      [
        ["org.sample.never.event", deny.verdict, deny.reasonCode],
        ["org.sample.data.write", ra.verdict, ra.reasonCode],
      ],
    ),
    "",
    `catalog      ${SAMPLE_TOOLS.length} sample tools (packs optional)`,
    "live         set KYA_BASE_URL + KYA_API_KEY and drop --offline",
    "wrap         w on a live policy pane, or: kya wrap --tool-id …",
  ];
}

export function policyLiveBody(evals: readonly PolicyEvaluateResponse[]): string[] {
  if (evals.length === 0) {
    return [
      "Policy playground (live plane).",
      "No evaluations this session. Press r after wiring KYA_API_KEY.",
    ];
  }
  return [
    "Policy playground (live plane — Shield is sole PEP).",
    "w wraps the write sample (ticket only). Never executes.",
    "",
    ...table(
      ["tool", "verdict", "reason"],
      evals.map((e) => [e.toolId ?? "?", e.verdict, e.reasonCode]),
    ),
  ];
}

export function agentsOfflineBody(agentId?: string): string[] {
  return [
    "Agents (free).",
    "Offline mode cannot list the plane registry.",
    agentId
      ? `local agentId  ${agentId}`
      : "No local agentId. Run: kya register-agent --name solo --version-hash dev",
    "Needs plane: list / kill / passport.",
  ];
}

export function agentsLiveBody(
  rows: readonly { id: string; name: string; status?: string }[],
  cursor = 0,
): string[] {
  return [
    "Agents. k kill highlighted. n → kya register-agent --name …",
    "",
    ...table(
      ["", "id", "name", "status"],
      rows.map((a, i) => [i === cursor ? ">" : " ", a.id, a.name, a.status ?? ""]),
    ),
  ];
}

export function needsPlaneBody(pane: string): string[] {
  const hint = {
    policy: "Then: kya eval-tool  ·  kya wrap",
    agents: "Then: kya agents  ·  kya register-agent  ·  kya kill --id",
    approvals: "Then: kya approvals  ·  kya approve --id (JWT)",
    sessions: "Then: kya sessions  ·  kya shrink --id --to BUILD",
  }[pane] ?? "Then: kya dash --once";
  return [
    `${pane} needs a control plane.`,
    "Set KYA_BASE_URL + KYA_API_KEY (local-free :8093 or hosted).",
    "Empty key is fail-closed. This pane will not fake data.",
    hint,
  ];
}

export function approvalsLiveBody(
  rows: readonly { id: string; status: string; action?: string }[],
  cursor = 0,
): string[] {
  return [
    "Approvals. i invoke if APPROVED. a/x decide only with a JWT.",
    "Machine keys: kya approve --id <id>",
    "",
    ...table(
      ["", "id", "status", "action"],
      rows.map((a, i) => [
        i === cursor ? ">" : " ",
        a.id,
        a.status,
        String(a.action ?? ""),
      ]),
    ),
  ];
}

export function sessionsLiveBody(
  rows: readonly { id: string; risk?: string; host?: string; clearance?: string }[],
  cursor = 0,
): string[] {
  return [
    "Sessions. Risk only raises policy. b shrink BUILD  R shrink READ.",
    "",
    ...table(
      ["", "id", "risk", "clearance", "host"],
      rows.map((s, i) => [
        i === cursor ? ">" : " ",
        s.id,
        s.risk ?? "",
        s.clearance ?? "",
        s.host ?? "",
      ]),
    ),
  ];
}

export function orrBody(summary?: {
  overall?: string;
  disposition?: string;
  path?: string;
}): string[] {
  return [
    "ORR board (reporting only — not a second PEP).",
    "Scanners are evidence. Sole PEP remains Shield KYA.",
    "",
    summary
      ? `last run     ${summary.overall ?? "?"} / ${summary.disposition ?? "?"}  ${summary.path ?? ""}`
      : "o runs orr in ./orr-report. Or: kya orr run --path . --out ./orr-report",
  ];
}

export function mcpBody(input: { host: string; hasApiKey: boolean }): string[] {
  return [
    "Local MCP gate.",
    "  kya serve-mcp --stdio",
    "  kya serve-mcp --port 13920",
    "  tools: kya.policy_evaluate | kya.session_ingest | kya.request_approval",
    `host         ${input.host}`,
    `api key      ${input.hasApiKey ? "set" : "empty — serve-mcp will fail-closed"}`,
    "Dash will not start the server (it would steal this TTY).",
  ];
}
