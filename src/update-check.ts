/**
 * Lightweight "new KYA version available" check.
 *
 * - Queries npm registry at most once per 24 h and caches the result in
 *   ~/.kya/update-check.json.
 * - Never fails a command: network/cache problems return undefined.
 * - Honors KYA_UPDATE_CHECK=0 and --no-update-check.
 * - Skips machine-readable/integrated subcommands so hosts aren't confused.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { globalConfigDir } from "./config.js";
import { CLI_VERSION } from "./version.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@shield-agent%2Fkya";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export interface UpdateCheckResult {
  readonly current: string;
  readonly latest: string;
}

interface UpdateCheckCache {
  readonly latest: string;
  readonly checkedAt: string;
}

/** Commands whose output is consumed by hosts, scripts, or pipes. */
const SKIP_COMMANDS = new Set([
  "serve-mcp",
  "receipt-serve",
  "hook",
  "wrap",
  "eval-tool",
  "invoke",
  "approve",
  "reject",
]);

export function shouldSkipUpdateCheck(
  command: string | undefined,
  flags: Readonly<Record<string, string | boolean>>,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!command) return true;
  if (SKIP_COMMANDS.has(command)) return true;
  if (flags["no-update-check"] === true || flags["no-update-check"] === "true") return true;
  if (env.KYA_UPDATE_CHECK === "0" || env.KYA_UPDATE_CHECK === "false") return true;
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") return true;
  if (flags["json"] === true || flags["json"] === "true") return true;
  return false;
}

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10));
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const an = Number.isFinite(av[i]) ? av[i] : 0;
    const bn = Number.isFinite(bv[i]) ? bv[i] : 0;
    if (an !== bn) return an - bn;
  }
  return 0;
}

function cachePath(env: NodeJS.ProcessEnv): string {
  return `${globalConfigDir(env)}/update-check.json`;
}

function readCache(env: NodeJS.ProcessEnv): UpdateCheckCache | undefined {
  try {
    const raw = readFileSync(cachePath(env), "utf8");
    const parsed = JSON.parse(raw) as UpdateCheckCache;
    if (parsed && typeof parsed.latest === "string" && typeof parsed.checkedAt === "string") {
      return parsed;
    }
  } catch {
    /* ignore corrupt/missing cache */
  }
  return undefined;
}

function writeCache(latest: string, env: NodeJS.ProcessEnv): void {
  try {
    const dir = globalConfigDir(env);
    mkdirSync(dir, { recursive: true });
    const cache: UpdateCheckCache = { latest, checkedAt: new Date().toISOString() };
    writeFileSync(cachePath(env), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch {
    /* ignore write failures */
  }
}

function cacheFresh(cache: UpdateCheckCache): boolean {
  try {
    const checked = new Date(cache.checkedAt).getTime();
    return Number.isFinite(checked) && Date.now() - checked < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

async function fetchLatestVersion(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (env.KYA_OFFLINE === "1" || env.KYA_OFFLINE === "true") return undefined;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetchImpl(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { "dist-tags"?: { latest?: string } };
    const latest = data?.["dist-tags"]?.latest;
    return typeof latest === "string" && latest ? latest : undefined;
  } catch {
    return undefined;
  }
}

export interface UpdateCheckDeps {
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Returns { current, latest } when a newer version is available on npm,
 * undefined when already up-to-date, offline, or the check failed.
 */
export async function checkForUpdate(deps: UpdateCheckDeps = {}): Promise<UpdateCheckResult | undefined> {
  const env = deps.env ?? process.env;
  const cache = readCache(env);
  let latest = cache && cacheFresh(cache) ? cache.latest : undefined;

  if (!latest) {
    latest = await fetchLatestVersion(env, deps.fetch);
    if (latest) writeCache(latest, env);
  }

  if (!latest) return undefined;
  const current = CLI_VERSION;
  if (compareVersions(latest, current) <= 0) return undefined;
  return { current, latest };
}

export function formatUpdateBanner(result: UpdateCheckResult): string {
  return `A new version of KYA is available: ${result.latest} (you have ${result.current}).\nRun: kya update\nOr:  npm i -g @shield-agent/kya@latest`;
}
