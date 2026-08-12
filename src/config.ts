import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AuthRequiredError, UsageError } from "./errors.js";

export type Host = "ide" | "runtime";

export interface KyaFileConfig {
  readonly baseUrl?: string;
  readonly host?: Host;
  readonly agentId?: string;
  readonly agentName?: string;
}

export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly host: Host;
  readonly agentId: string | undefined;
  readonly mcpPort: number;
  readonly tenantHint: string | undefined;
  readonly cwd: string;
  readonly configPath: string;
  readonly json: boolean;
  /** When true, empty api key is allowed only for pure local file ops (init). */
  readonly allowMissingApiKey: boolean;
  /** Offline sample evaluate (demo / CT) — no network, no paid cloud. */
  readonly offline: boolean;
}

export interface ResolveOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly flags?: Readonly<Record<string, string | boolean>>;
  /** Skip auth requirement (init, --help). Default false. */
  readonly allowMissingApiKey?: boolean;
  /** When true, require non-empty API key (authenticated plane). Default true for network cmds. */
  readonly requireApiKey?: boolean;
  /** Force offline evaluate path (no API key required). */
  readonly offline?: boolean;
}

const DEFAULT_HOST: Host = "ide";
const DEFAULT_MCP_PORT = 3920;

export function configDir(cwd: string): string {
  return join(cwd, ".kya");
}

export function configFilePath(cwd: string): string {
  return join(configDir(cwd), "config.json");
}

export function readFileConfig(cwd: string): KyaFileConfig {
  const path = configFilePath(cwd);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as KyaFileConfig;
    return raw ?? {};
  } catch {
    return {};
  }
}

export function writeFileConfig(cwd: string, patch: KyaFileConfig): KyaFileConfig {
  const dir = configDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = configFilePath(cwd);
  const prev = readFileConfig(cwd);
  const next: KyaFileConfig = {
    ...prev,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ),
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function parseHost(raw: string | undefined): Host {
  if (raw === undefined || raw === "") return DEFAULT_HOST;
  const h = raw.trim().toLowerCase();
  if (h === "ide" || h === "runtime") return h;
  throw new UsageError(`invalid host "${raw}" (expected ide|runtime)`);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Resolve runtime config from flags > env > .kya/config.json.
 * Fail-closed: empty API key against network commands exits non-zero.
 */
export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const flags = options.flags ?? {};
  const file = readFileConfig(cwd);

  const baseUrlRaw =
    str(flags["base-url"]) ??
    env.KYA_BASE_URL ??
    file.baseUrl ??
    "http://127.0.0.1:8090";
  const baseUrl = stripTrailingSlash(baseUrlRaw.trim());

  const apiKey =
    str(flags["api-key"]) ?? env.KYA_API_KEY ?? env.SHIELD_API_KEY ?? "";

  const host = parseHost(
    str(flags["host"]) ?? env.KYA_HOST ?? file.host ?? DEFAULT_HOST,
  );

  const agentId =
    str(flags["agent-id"]) ?? env.KYA_AGENT_ID ?? file.agentId ?? undefined;

  const mcpPort = Number.parseInt(
    str(flags["port"]) ?? env.KYA_MCP_PORT ?? String(DEFAULT_MCP_PORT),
    10,
  );

  const tenantHint = env.KYA_TENANT_HINT;
  const json = flags["json"] === true || flags["json"] === "true";
  const offline =
    options.offline === true ||
    flags["offline"] === true ||
    flags["offline"] === "true" ||
    env.KYA_OFFLINE === "1" ||
    env.KYA_OFFLINE === "true";

  // Offline sample evaluate never hits the control plane — no API key required.
  const requireApiKey =
    offline
      ? false
      : (options.requireApiKey ?? !options.allowMissingApiKey);
  if (requireApiKey && (!apiKey || apiKey.trim() === "")) {
    throw new AuthRequiredError(
      "KYA_API_KEY is empty or missing — refuse silent allow-all against control plane (use --offline for local sample evaluate)",
    );
  }

  if (!baseUrl && !offline) {
    throw new UsageError("KYA_BASE_URL is required");
  }

  return {
    baseUrl: baseUrl || "http://127.0.0.1:8090",
    apiKey: apiKey.trim(),
    host,
    agentId: agentId?.trim() || undefined,
    mcpPort: Number.isFinite(mcpPort) ? mcpPort : DEFAULT_MCP_PORT,
    tenantHint,
    cwd,
    configPath: configFilePath(cwd),
    json,
    allowMissingApiKey: !requireApiKey,
    offline,
  };
}

function str(v: string | boolean | undefined): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

/** Ensure parent dir exists for a path. */
export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
