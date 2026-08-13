import { table } from "../render.js";

export function dashboardBody(k: {
  pendingApprovals: number;
  agentCount: number;
  sessionCount?: number;
  highRiskSessions?: number;
  policyDeny?: number;
  approveRequired?: number;
  approveGranted?: number;
}): string[] {
  return [
    "Enterprise dashboard (web parity KPIs).",
    "",
    ...table(
      ["kpi", "value"],
      [
        ["pending approvals", String(k.pendingApprovals)],
        ["agents registered", Number.isFinite(k.agentCount) ? String(k.agentCount) : "—"],
        ["observed sessions", String(k.sessionCount ?? "—")],
        ["high-risk sessions", String(k.highRiskSessions ?? "—")],
        ["policy denies", String(k.policyDeny ?? "—")],
        ["approve required", String(k.approveRequired ?? "—")],
        ["approve granted", String(k.approveGranted ?? "—")],
      ],
    ),
    "",
    "Actions that change production still wait for a person.",
  ];
}

export function casesBody(
  rows: readonly { id: string; status?: string; amount?: string }[],
): string[] {
  return [
    "Evidence & cases (optional disputes pack). Observational — does not approve submit.",
    "",
    ...table(
      ["id", "status", "amount"],
      rows.map((c) => [c.id, c.status ?? "", c.amount ?? ""]),
    ),
  ];
}

export function metricsBody(m: Record<string, string | number | boolean>): string[] {
  return [
    "Metrics (process counters). Kill SLO target < 60s.",
    "",
    ...table(
      ["metric", "value"],
      Object.entries(m).map(([k, v]) => [k, String(v)]),
    ),
  ];
}

export function edgeBody(flags: Record<string, string | boolean | number>): string[] {
  return [
    "Edge / Gatekeeper (read-only). Complement — not a second PEP.",
    "",
    ...table(
      ["flag", "value"],
      Object.entries(flags).map(([k, v]) => [k, String(v)]),
    ),
  ];
}

export function settingsBody(lines: readonly string[]): string[] {
  return [
    "Settings (licensed). Team / SSO / keys / billing — same surfaces as the web console.",
    "",
    ...(lines.length ? lines : ["Connect a plane to load tenant settings."]),
  ];
}
