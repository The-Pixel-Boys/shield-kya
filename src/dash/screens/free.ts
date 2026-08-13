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
    "Individual free plan — local PEP playground, observe, ORR, MCP gate.",
    "Enterprise web-parity panes stay locked until licensed.",
    "",
    `cli          ${input.version}`,
    `offline      ${input.offline ? "yes (sample tools, not production PEP)" : "no"}`,
    `api key      ${input.hasApiKey ? "set" : "empty (fail-closed on live panes)"}`,
    `plane        ${input.offline ? "offline" : input.baseUrl}`,
    `agentId      ${input.agentId ?? "(none — kya register-agent)"}`,
    "",
    "Next: 2 policy  ·  6 orr  ·  7 mcp  ·  eval-tool --offline",
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

export function agentsLiveBody(rows: readonly { id: string; name: string; status?: string }[]): string[] {
  return [
    "Agents (free — register / inspect / kill).",
    "",
    ...table(
      ["id", "name", "status"],
      rows.map((a) => [a.id, a.name, a.status ?? ""]),
    ),
  ];
}

export function needsPlaneBody(pane: string): string[] {
  return [
    `${pane} needs a control plane.`,
    "Set KYA_BASE_URL + KYA_API_KEY (local-free :8090 or hosted).",
    "Empty key is fail-closed — this pane will not fake data.",
  ];
}

export function approvalsLiveBody(
  rows: readonly { id: string; status: string; action?: string }[],
): string[] {
  return [
    "Approvals (free — human queue). Approve/reject is the same PEP path as the web.",
    "TUI never auto-approves.",
    "",
    ...table(
      ["id", "status", "action"],
      rows.map((a) => [a.id, a.status, String(a.action ?? "")]),
    ),
  ];
}

export function sessionsLiveBody(
  rows: readonly { id: string; risk?: string; host?: string }[],
): string[] {
  return [
    "Sessions (observe). Risk only raises policy; it cannot auto-allow.",
    "",
    ...table(
      ["id", "risk", "host"],
      rows.map((s) => [s.id, s.risk ?? "", s.host ?? ""]),
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
      : "Run: kya orr run --path . --out ./orr-report --skip-optional-producers",
  ];
}

export function mcpBody(input: { host: string; hasApiKey: boolean }): string[] {
  return [
    "Local MCP gate (free).",
    "  kya serve-mcp --stdio",
    "  tools: kya.policy_evaluate | kya.session_ingest | kya.request_approval",
    `host         ${input.host}`,
    `api key      ${input.hasApiKey ? "set" : "empty — serve-mcp will fail-closed"}`,
    "No irreversible side effect without APPROVED.",
  ];
}
