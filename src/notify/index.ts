/**
 * Alert routing for trail verdicts: fire webhooks when a trail event is DENY or REQUIRE_APPROVE.
 * Wired into the trail writers by the caller; this module is passive (nothing polls the trail).
 *
 * Config comes from the `notify` key of the parsed `.kya/config.json` object (the module receives
 * the parsed object, it does not read files):
 *
 *   notify: { webhooks: [ { url, events?: ["DENY","REQUIRE_APPROVE"],
 *                           template?: "slack"|"linear"|"jira"|"generic",
 *                           headers?: Record<string,string>, timeoutMs? } ] }
 *
 * `KYA_NOTIFY_WEBHOOK` adds one quick generic webhook on top of the config list.
 *
 * Secrets hygiene: payloads are built from the allow-listed, already-redacted trail fields only
 * (see templates.ts) and the serialized body is checked with assertNoSecrets before sending; a
 * rejected body degrades to a four-field minimized payload instead of being dropped silently.
 */
import { assertNoSecrets } from "../dash/render.js";
import type { TrailEvent } from "../trail.js";
import {
  NOTIFY_TEMPLATES,
  buildMinimizedPayload,
  buildPayload,
  type NotifyTemplate,
} from "./templates.js";
import { sendWithRetry, type NotifyDeps } from "./sender.js";

export {
  CIRCUIT_FAILURES_TO_OPEN,
  CIRCUIT_OPEN_MS,
  DEFAULT_TIMEOUT_MS,
  RATE_LIMIT_MAX_SENDS,
  RATE_LIMIT_WINDOW_MS,
  RETRY_DELAYS_MS,
  notifyStats,
  postWebhook,
  resetNotifyState,
  sendWithRetry,
  type NotifyDeps,
} from "./sender.js";
export {
  NOTIFY_KIND,
  NOTIFY_TEMPLATES,
  allowedEventFields,
  buildGenericPayload,
  buildJiraPayload,
  buildLinearPayload,
  buildMinimizedPayload,
  buildPayload,
  buildSlackPayload,
  headline,
  type NotifyTemplate,
} from "./templates.js";

export interface NotifyWebhookConfig {
  readonly url: string;
  readonly events?: readonly string[];
  readonly template?: NotifyTemplate;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

/** The slice of the parsed `.kya/config.json` this module reads. */
export interface NotifyFileConfig {
  readonly notify?: {
    readonly webhooks?: readonly unknown[];
  };
}

/** A hand-editable config entry, defensively parsed. Invalid entries drop, never throw. */
export interface ResolvedWebhook {
  readonly url: string;
  readonly events: readonly string[];
  readonly template: NotifyTemplate;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

export const NOTIFYABLE_VERDICTS: readonly string[] = ["DENY", "REQUIRE_APPROVE"];
export const ENV_WEBHOOK_VAR = "KYA_NOTIFY_WEBHOOK";

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function parseWebhook(raw: unknown): ResolvedWebhook | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const w = raw as Record<string, unknown>;
  if (typeof w["url"] !== "string" || !isHttpUrl(w["url"].trim())) return undefined;

  let events: readonly string[] = NOTIFYABLE_VERDICTS;
  if (Array.isArray(w["events"])) {
    const filtered = w["events"].filter(
      (e): e is string => typeof e === "string" && NOTIFYABLE_VERDICTS.includes(e),
    );
    if (filtered.length > 0) events = filtered;
  }

  const template: NotifyTemplate =
    typeof w["template"] === "string" &&
    (NOTIFY_TEMPLATES as readonly string[]).includes(w["template"])
      ? (w["template"] as NotifyTemplate)
      : "generic";

  let headers: Record<string, string> | undefined;
  if (w["headers"] && typeof w["headers"] === "object" && !Array.isArray(w["headers"])) {
    const parsed = Object.fromEntries(
      Object.entries(w["headers"] as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
    if (Object.keys(parsed).length > 0) headers = parsed;
  }

  const timeoutMs =
    typeof w["timeoutMs"] === "number" && Number.isFinite(w["timeoutMs"]) && w["timeoutMs"] > 0
      ? w["timeoutMs"]
      : undefined;

  return { url: w["url"].trim(), events, template, ...(headers ? { headers } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
}

/** Config webhooks plus the KYA_NOTIFY_WEBHOOK env override (generic template), both validated. */
export function resolveWebhooks(
  config: NotifyFileConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWebhook[] {
  const out: ResolvedWebhook[] = [];
  try {
    for (const raw of config?.notify?.webhooks ?? []) {
      const parsed = parseWebhook(raw);
      if (parsed !== undefined) out.push(parsed);
    }
    const envUrl = env[ENV_WEBHOOK_VAR]?.trim();
    if (envUrl !== undefined && envUrl !== "" && isHttpUrl(envUrl)) {
      out.push({ url: envUrl, events: NOTIFYABLE_VERDICTS, template: "generic" });
    }
  } catch {
    /* a malformed config must never break the gate path */
  }
  return out;
}

/** Serialized body for one receiver, downgraded to the minimized shape if the secret scan trips. */
export function serializePayload(template: NotifyTemplate, event: TrailEvent): string {
  const body = JSON.stringify(buildPayload(template, event));
  try {
    assertNoSecrets(body);
    return body;
  } catch {
    return JSON.stringify(buildMinimizedPayload(event));
  }
}

/**
 * Fire every matching webhook for one trail event. Filters to DENY / REQUIRE_APPROVE first
 * (per-webhook `events` can narrow further). Delivers to all receivers concurrently; delivery
 * reliability (retry, timeout, rate limit, circuit breaker) lives in sender.ts. Never throws.
 */
export async function notifyOnTrailEvent(
  event: TrailEvent,
  config: NotifyFileConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: NotifyDeps = {},
): Promise<void> {
  try {
    if (!NOTIFYABLE_VERDICTS.includes(event.verdict)) return;
    const targets = resolveWebhooks(config, env).filter((w) => w.events.includes(event.verdict));
    await Promise.all(
      targets.map(async (w) => {
        try {
          await sendWithRetry(
            {
              url: w.url,
              body: serializePayload(w.template, event),
              ...(w.headers ? { headers: w.headers } : {}),
              ...(w.timeoutMs !== undefined ? { timeoutMs: w.timeoutMs } : {}),
            },
            deps,
          );
        } catch {
          /* one receiver must not affect the others */
        }
      }),
    );
  } catch {
    /* notify must never change the gate path */
  }
}
