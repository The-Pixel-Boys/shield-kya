/**
 * Per-receiver payload shapes for trail verdict notifications (slack / teams / linear / jira / generic).
 * Every builder works from the already-redacted trail fields only - raw tool args and diff content
 * never reach this module, and the allow-list below is the complete set of fields a payload may carry.
 */
import type { TrailEvent } from "../trail.js";

export type NotifyTemplate = "slack" | "teams" | "linear" | "jira" | "generic";

export const NOTIFY_TEMPLATES: readonly NotifyTemplate[] = ["slack", "teams", "linear", "jira", "generic"];

/** `kind` marker on the generic payload so receivers can route without inspecting fields. */
export const NOTIFY_KIND = "kya.trail.verdict";

/**
 * The ONLY trail fields a payload may carry: ts, sessionId, toolId, verdict, reasonCode, mode,
 * plus the optional redacted/host fields when present. argsHash, diffPreview and neverEvent are
 * excluded by omission; the trail never holds raw args at all.
 */
export function allowedEventFields(event: TrailEvent): Record<string, string> {
  const out: Record<string, string> = {
    ts: event.ts,
    sessionId: event.sessionId,
    toolId: event.toolId,
    verdict: event.verdict,
    reasonCode: event.reasonCode,
    mode: event.mode,
  };
  if (event.host !== undefined) out["host"] = event.host;
  if (event.product !== undefined) out["product"] = event.product;
  if (event.project !== undefined) out["project"] = event.project;
  if (event.packId !== undefined) out["packId"] = event.packId;
  if (event.summary !== undefined) out["summary"] = event.summary;
  if (event.targetPath !== undefined) out["targetPath"] = event.targetPath;
  return out;
}

/** One-line headline shared by every template, e.g. "KYA DENY: shell.exec (NEVER_COMMAND)". */
export function headline(event: TrailEvent): string {
  return `KYA ${event.verdict}: ${event.toolId} (${event.reasonCode})`;
}

function descriptionLines(event: TrailEvent): string[] {
  const f = allowedEventFields(event);
  const lines = [
    `verdict: ${f["verdict"]}`,
    `tool: ${f["toolId"]}`,
    `reason: ${f["reasonCode"]}`,
    `mode: ${f["mode"]}`,
    `session: ${f["sessionId"]}`,
    `ts: ${f["ts"]}`,
  ];
  if (f["product"] !== undefined) lines.push(`product: ${f["product"]}`);
  if (f["host"] !== undefined) lines.push(`host: ${f["host"]}`);
  if (f["targetPath"] !== undefined) lines.push(`target: ${f["targetPath"]}`);
  if (f["summary"] !== undefined) lines.push(`summary: ${f["summary"]}`);
  return lines;
}

/** Footer on every Slack message: chat is a notify channel, never an approval path. */
export const SLACK_NOT_AN_APPROVAL =
  "A Slack reaction or reply is not an approval. Decide in kya or in the hosted console.";

/** Slack incoming-webhook shape: top-level text fallback plus Block Kit blocks. */
export function buildSlackPayload(event: TrailEvent): Record<string, unknown> {
  const f = allowedEventFields(event);
  const fields = ["toolId", "reasonCode", "mode", "sessionId", "ts"]
    .map((k) => ({ type: "mrkdwn", text: `*${k}*\n${f[k]}` }));
  if (f["targetPath"] !== undefined) {
    fields.push({ type: "mrkdwn", text: `*target*\n${f["targetPath"]}` });
  }
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `KYA verdict: ${event.verdict}` } },
    { type: "section", fields },
  ];
  if (f["summary"] !== undefined) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: f["summary"] } });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: SLACK_NOT_AN_APPROVAL }] });
  return { text: headline(event), blocks };
}

/** Footer on every Teams card: chat is a notify channel, never an approval path. */
export const TEAMS_NOT_AN_APPROVAL =
  "A Teams reaction or reply is not an approval. Decide in kya or in the hosted console.";

/**
 * Event text for a Teams card. Teams renders a Markdown subset, so the characters that make links, mentions
 * (`<at>`), bold or headings become a space, a leading list marker becomes a space, and `://` becomes `: //`.
 * Every dot between two letters or digits gets spaces around it (`a.b` becomes `a . b`), so Teams cannot
 * auto-link any host name. Tool ids such as `fs . read` change on purpose.
 */
export function teamsText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/[\\[\]()*~#<>&|!`]/g, " ")
    .replace(/:\/\//g, ": //")
    .replace(/(?<=[\p{L}\p{N}-])\.(?=[\p{L}\p{N}])/gu, " . ")
    .replace(/^\s*([-+]|\d+\.)(?=\s|$)/, " ");
}

/**
 * Teams Workflows webhook shape: a message with one Adaptive Card. No actions: the card cannot approve,
 * reject or submit anything.
 */
export function buildTeamsPayload(event: TrailEvent): Record<string, unknown> {
  const f = allowedEventFields(event);
  const facts = ["toolId", "reasonCode", "mode", "sessionId", "ts"]
    .map((k) => ({ title: k, value: teamsText(f[k] ?? "-") }));
  if (f["targetPath"] !== undefined) facts.push({ title: "target", value: teamsText(f["targetPath"]) });
  const body: unknown[] = [
    { type: "TextBlock", text: teamsText(headline(event)), weight: "Bolder", size: "Medium", wrap: true },
    { type: "FactSet", facts },
  ];
  if (f["summary"] !== undefined) body.push({ type: "TextBlock", text: teamsText(f["summary"]), wrap: true });
  body.push({ type: "TextBlock", text: TEAMS_NOT_AN_APPROVAL, wrap: true, isSubtle: true });
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

/** Linear create-issue-shaped body (title / description / priority). DENY is urgent. */
export function buildLinearPayload(event: TrailEvent): Record<string, unknown> {
  return {
    title: headline(event),
    description: descriptionLines(event).join("\n"),
    priority: event.verdict === "DENY" ? 1 : 2,
  };
}

/** Jira create-issue-shaped body (fields.summary / fields.description / issuetype). */
export function buildJiraPayload(event: TrailEvent): Record<string, unknown> {
  return {
    fields: {
      summary: headline(event),
      description: descriptionLines(event).join("\n"),
      issuetype: { name: "Task" },
    },
  };
}

/** Generic: the allow-listed event fields plus a routing kind. */
export function buildGenericPayload(event: TrailEvent): Record<string, unknown> {
  return { kind: NOTIFY_KIND, event: allowedEventFields(event) };
}

export function buildPayload(template: NotifyTemplate, event: TrailEvent): Record<string, unknown> {
  switch (template) {
    case "slack":
      return buildSlackPayload(event);
    case "teams":
      return buildTeamsPayload(event);
    case "linear":
      return buildLinearPayload(event);
    case "jira":
      return buildJiraPayload(event);
    default:
      return buildGenericPayload(event);
  }
}

/**
 * Last-resort body when assertNoSecrets rejects the full payload: four fields only, no free text
 * (summary / targetPath are the fields that could carry a leaked secret).
 */
export function buildMinimizedPayload(event: TrailEvent): Record<string, unknown> {
  return {
    toolId: event.toolId,
    verdict: event.verdict,
    reasonCode: event.reasonCode,
    ts: event.ts,
  };
}
