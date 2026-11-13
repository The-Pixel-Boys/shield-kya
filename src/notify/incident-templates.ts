/**
 * Per-receiver payload shapes for the `incident.opened` event (slack / teams / linear / jira / generic).
 * Input is an IncidentAlert (see alerts/incident-alert.ts): already redacted, clipped and free of
 * raw args, hashes, paths, session ids and home folders. Cards carry no buttons: chat is a
 * notify channel, never an approval path.
 */
import { ADVISORY_LINE, INCIDENT_EVENT, INCIDENT_KIND } from "../alerts/constants.js";
import type { IncidentAlert } from "../alerts/incident-alert.js";
import { breakAutolinks, teamsText, type NotifyTemplate } from "./templates.js";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function slackEntities(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Slack mrkdwn escaping (Slack's rule): & < > become entities, so an agent-written string cannot form
 * <!channel>, <!here>, <@user> or <url|text>. Then bare URLs and domains are broken (see breakAutolinks),
 * because Slack auto-links them. Used on every string that an agent can influence.
 */
export function slackEscape(value: string): string {
  return slackEntities(breakAutolinks(value.replace(CONTROL_CHARS, " ")));
}

/**
 * Markdown / wiki escaping for Linear and Jira descriptions: control characters become a space, the
 * characters that make links, mentions, images, macros, bold or headings get a backslash, and bare
 * URLs and domains are broken (see breakAutolinks) so they do not auto-link.
 */
export function mdEscape(value: string): string {
  return breakAutolinks(value.replace(CONTROL_CHARS, " "))
    .replace(/[\\`*_{}[\]()<>#+!|~&@]/g, "\\$&");
}

/** [label, value, generated]. A generated value (ISO time) is written by kya itself, so it stays unbroken. */
type Fact = [string, string, boolean?];

function facts(a: IncidentAlert): Fact[] {
  const out: Fact[] = [
    ["severity", a.severity],
    ["detectors", a.detectorIds.join(", ") || "-"],
    ["findings", String(a.findingCount)],
  ];
  if (a.counts) out.push(["verdicts", `allow ${a.counts.allow}, hold ${a.counts.hold}, deny ${a.counts.deny}`]);
  if (a.triage) {
    const t = a.triage;
    const pct = (p: number): string => `${Math.round(p * 100)}%`;
    out.push(["triage", `${t.category.id} ${pct(t.category.p)}, urgency ${t.urgency.id}, action ${t.action.id}, harmless ${pct(t.benign)} (local model ${t.model}, advisory)`]);
  }
  if (a.tools.length > 0) out.push(["tools", a.tools.join(", ")]);
  if (a.firstTs) out.push(["first", a.firstTs, true]);
  if (a.lastTs) out.push(["last", a.lastTs, true]);
  return out;
}

function descriptionLines(a: IncidentAlert): string[] {
  const lines = facts(a).map(([k, v, gen]) => `${k}: ${gen ? v : mdEscape(v)}`);
  for (const s of a.summaries) lines.push(`summary: ${mdEscape(s)}`);
  if (a.fix) lines.push(`fix: ${mdEscape(a.fix)}`);
  lines.push(ADVISORY_LINE);
  return lines;
}

export function buildIncidentSlackPayload(a: IncidentAlert): Record<string, unknown> {
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: a.title.slice(0, 150) } },
    { type: "section", fields: facts(a).map(([k, v, gen]) => ({ type: "mrkdwn", text: `*${k}*\n${gen ? slackEntities(v) : slackEscape(v)}` })) },
  ];
  if (a.summaries.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: a.summaries.map((s) => `- ${slackEscape(s)}`).join("\n") } });
  }
  if (a.fix) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*fix*\n${slackEscape(a.fix)}` } });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: ADVISORY_LINE }] });
  return { text: slackEscape(`${a.title} (${a.severity})`), blocks };
}

export function buildIncidentTeamsPayload(a: IncidentAlert): Record<string, unknown> {
  const body: unknown[] = [
    { type: "TextBlock", text: teamsText(a.title), weight: "Bolder", size: "Medium", wrap: true },
    { type: "FactSet", facts: facts(a).map(([title, value]) => ({ title, value: teamsText(value) })) },
  ];
  for (const s of a.summaries) body.push({ type: "TextBlock", text: teamsText(s), wrap: true });
  if (a.fix) body.push({ type: "TextBlock", text: teamsText(`fix: ${a.fix}`), wrap: true });
  body.push({ type: "TextBlock", text: ADVISORY_LINE, wrap: true, isSubtle: true });
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body,
          actions: [],
        },
      },
    ],
  };
}

const LINEAR_PRIORITY = { critical: 1, high: 2, medium: 3, low: 4 } as const;

export function buildIncidentLinearPayload(a: IncidentAlert): Record<string, unknown> {
  return { title: a.title, description: descriptionLines(a).join("\n"), priority: LINEAR_PRIORITY[a.severity] };
}

export function buildIncidentJiraPayload(a: IncidentAlert): Record<string, unknown> {
  return { fields: { summary: a.title, description: descriptionLines(a).join("\n"), issuetype: { name: "Task" } } };
}

export function buildIncidentGenericPayload(a: IncidentAlert): Record<string, unknown> {
  return { kind: INCIDENT_KIND, event: INCIDENT_EVENT, incident: { ...a } };
}

export function buildIncidentPayload(template: NotifyTemplate, a: IncidentAlert): Record<string, unknown> {
  switch (template) {
    case "slack":
      return buildIncidentSlackPayload(a);
    case "teams":
      return buildIncidentTeamsPayload(a);
    case "linear":
      return buildIncidentLinearPayload(a);
    case "jira":
      return buildIncidentJiraPayload(a);
    default:
      return buildIncidentGenericPayload(a);
  }
}

/** Last resort when the secret scan rejects the full body: title, severity and the test mark only. */
export function buildIncidentMinimizedPayload(a: IncidentAlert): Record<string, unknown> {
  return { kind: INCIDENT_KIND, event: INCIDENT_EVENT, title: a.title, severity: a.severity, test: a.test };
}
