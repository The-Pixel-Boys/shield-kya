#!/usr/bin/env node
// Link check for the replay pages (acquisition build B1b): every https link on a generated page must resolve.
// That is every source link of an incident, the guard-pack doc and the host recipes. It needs the network, so CI does
// not run it as a gate; run it before a release:  pnpm check:replay-links   (exit 1 when a link is dead).
//   401, 403 and 429 are reported as "unverified" (the site refuses bots), not as dead.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// One pass, so "&amp;lt;" decodes to "&lt;", not "<" (CodeQL js/double-escaping).
const ENT = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
export const unesc = (s) => s.replace(/&(?:amp|quot|#39|lt|gt);/g, (e) => ENT[e]);

/** Every distinct https link on the generated pages, sorted. */
export function pageLinks(root = ROOT) {
  const dir = join(root, "replays", "pages");
  const links = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/href="(https:\/\/[^"]+)"/g)) links.add(unesc(m[1]));
  }
  return [...links].sort();
}

/** Checks each link with GET. Returns { url, status, verdict } rows: ok, unverified or dead. `fetchFn` is injectable for tests. */
export async function checkLinks(urls, fetchFn = fetch, timeoutMs = 20000) {
  const rows = [];
  for (const url of urls) {
    let status = 0;
    try {
      const res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "replay-link-check" } });
      status = res.status;
      await res.body?.cancel?.();
    } catch (err) {
      rows.push({ url, status: 0, verdict: "dead", note: String(err?.cause?.code ?? err?.message ?? err) });
      continue;
    }
    rows.push({ url, status, verdict: status < 400 ? "ok" : [401, 403, 429].includes(status) ? "unverified" : "dead" });
  }
  return rows;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = await checkLinks(pageLinks());
  for (const r of rows) console.log(`${r.verdict.padEnd(10)} ${String(r.status).padEnd(4)} ${r.url}${r.note ? ` (${r.note})` : ""}`);
  const dead = rows.filter((r) => r.verdict === "dead");
  console.log(`replay links: ${rows.length} checked, ${dead.length} dead, ${rows.filter((r) => r.verdict === "unverified").length} unverified`);
  process.exit(dead.length ? 1 : 0);
}
