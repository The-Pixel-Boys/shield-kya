/**
 * `kya receipt --share` — publish a redacted summary of the current report
 * window to the hosted platform and get back a public URL.
 *
 * The payload is built FROM THE RECEIPT MODEL, never from the raw trail:
 * aggregate counts and public labels only. No absolute paths, no session ids,
 * no tool arguments, no identity (baseUrl/IP) — anything that could identify
 * a machine, project, or person stays local. Dependency-free: global fetch.
 */
import { CLI_VERSION } from "../version.js";
import { aggregateEvents, type ReceiptModel } from "./render-receipt.js";

export const SHARE_DEFAULT_BASE_URL = "https://shield-agent.com";
export const SHARE_PATH = "/api/v1/share/reports";
export const SHARE_TIMEOUT_MS = 15_000;

export interface ShareStats {
  readonly total: number;
  readonly allow: number;
  readonly review: number;
  readonly deny: number;
  readonly never: number;
  /** Distinct sessions in the window — a count, never ids. */
  readonly sessions: number;
}

export interface ShareCertify {
  readonly status: "pass" | "gap";
  readonly pass: number;
  readonly gap: number;
  readonly insufficient: number;
  readonly attested: number;
  readonly topGaps: readonly { readonly id: string; readonly severity: string; readonly title: string }[];
}

export interface SharePayload {
  readonly version: 1;
  readonly title: string;
  readonly rangeLabel: string;
  readonly generatedAt: string;
  readonly cliVersion: string;
  readonly stats: ShareStats;
  readonly products: readonly { readonly label: string; readonly count: number }[];
  readonly reasonCodes: readonly { readonly code: string; readonly count: number }[];
  readonly certify: ShareCertify | null;
}

/**
 * Roll the model into the share payload. Only fields that are already public
 * labels or aggregates leave the machine: verdict counts, product/reason
 * labels, and certify requirement ids (catalog identifiers). Events, session
 * ids, tool args, paths, and identity never enter the payload.
 */
export function buildSharePayload(model: ReceiptModel): SharePayload {
  const events = model.events;
  let allow = 0;
  let review = 0;
  let deny = 0;
  let never = 0;
  const sessions = new Set<string>();
  for (const e of events) {
    const v = e.verdict.toUpperCase();
    if (e.neverEvent || e.reasonCode === "NEVER_EVENT") never++;
    if (v === "ALLOW") allow++;
    else if (v === "DENY") deny++;
    else if (v === "REQUIRE_APPROVE") review++;
    sessions.add(e.sessionId?.trim() || "unknown");
  }
  const agg = aggregateEvents(events);
  return {
    version: 1,
    title: model.title,
    rangeLabel: model.rangeLabel,
    generatedAt: model.generatedAt,
    cliVersion: CLI_VERSION,
    stats: {
      total: events.length,
      allow,
      review,
      deny,
      never,
      sessions: sessions.size,
    },
    products: agg.products.slice(0, 6).map(({ label, count }) => ({ label, count })),
    reasonCodes: agg.reasons.slice(0, 8).map(({ label, count }) => ({ code: label, count })),
    certify: model.certify
      ? {
          status: model.certify.result,
          pass: model.certify.pass,
          gap: model.certify.gap,
          insufficient: model.certify.insufficientEvidence,
          attested: model.certify.attested,
          topGaps: model.certify.topGaps.slice(0, 5).map(({ id, severity, title }) => ({ id, severity, title })),
        }
      : null,
  };
}

/** Resolve the endpoint base: --share-url flag > KYA_SHARE_URL > default. */
export function shareBaseUrl(override: string | undefined, env: NodeJS.ProcessEnv): string {
  const raw = override?.trim() || env.KYA_SHARE_URL?.trim() || SHARE_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export type ShareResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly error: string };

/** POST the payload; 15s timeout. Never throws — failures come back as {ok:false}. */
export async function shareReceiptPayload(
  payload: SharePayload,
  opts: { readonly baseUrl: string; readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number },
): Promise<ShareResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SHARE_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}${SHARE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        error: timedOut ? "share failed: request timed out" : `share failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (res.status !== 200 && res.status !== 201) {
      return { ok: false, error: `share failed: HTTP ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as { url?: unknown } | null;
    if (!data || typeof data.url !== "string" || !data.url) {
      return { ok: false, error: "share failed: response did not include a url" };
    }
    return { ok: true, url: data.url };
  } finally {
    clearTimeout(timer);
  }
}
