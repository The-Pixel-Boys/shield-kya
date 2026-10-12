/**
 * Hosted sync for discovery snapshots.
 *
 * Pushes the local endpoint inventory to `POST /api/v1/kya/endpoints` on the
 * hosted console. This is fire-and-forget from the scanner's perspective: it
 * returns an outcome object so the CLI can print status, but it never throws.
 */

import { CLI_VERSION } from "../version.js";
import type { DiscoverySnapshot } from "./scan.js";

export interface PushOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface PushResult {
  readonly ok: boolean;
  readonly status: number;
  readonly error?: string;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export async function pushDiscoverySnapshot(
  snapshot: DiscoverySnapshot,
  opts: PushOptions,
): Promise<PushResult> {
  const baseUrl = stripTrailingSlash(opts.baseUrl.trim());
  const url = `${baseUrl}/api/v1/kya/endpoints`;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey.trim()}`,
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": `shield-agent-kya-cli/${CLI_VERSION}`,
      },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `HTTP ${res.status}${text ? ` ${text}` : ""}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message };
  }
}
