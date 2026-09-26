/**
 * `.kya/gateways.json` — the upstream MCP servers the local kya gateway
 * federates. Strict JSON (hand-editable, merge-safe); `kya gate init` seeds
 * it with a `recipes` catalog of ready-to-move entries for the well-known
 * servers from the MCP server registry.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { UsageError } from "../errors.js";
import { atomicWriteSync } from "../fs-atomic.js";

export interface GatewayServer {
  readonly id: string;
  readonly transport: "stdio" | "http";
  readonly cmd?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** http only: request headers for the remote server (auth tokens go here). */
  readonly headers?: Readonly<Record<string, string>>;
}

export type GateFailureMode = "failOpen" | "failClosed";

export interface GatewaysConfig {
  /** Listener port on 127.0.0.1 (default 3930). */
  readonly port: number;
  /** Local OTLP/HTTP receiver port (default 3931). */
  readonly otlpPort: number;
  /**
   * Gateway behavior when a target fails to initialize: failOpen serves the
   * healthy targets (default, better local UX); failClosed takes the whole
   * gateway down (strict — a silently missing server is impossible).
   */
  readonly failureMode: GateFailureMode;
  readonly servers: readonly GatewayServer[];
}

export const GATE_DEFAULT_PORT = 3930;
export const GATE_DEFAULT_OTLP_PORT = 3931;

export function gatewaysPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "gateways.json");
}

const TARGET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePort(raw: unknown, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new UsageError(`gateways.json: "${key}" must be an integer port 1-65535`);
  }
  return raw;
}

function parseServer(raw: unknown, index: number): GatewayServer {
  const where = `gateways.json: servers[${index}]`;
  if (!isPlainObject(raw)) throw new UsageError(`${where} must be an object`);
  const id = raw.id;
  if (typeof id !== "string" || !TARGET_ID_RE.test(id)) {
    throw new UsageError(
      `${where}.id must match ${TARGET_ID_RE} (the gateway rejects underscores in target names)`,
    );
  }
  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new UsageError(`${where}.transport must be "stdio" or "http"`);
  }
  let cmd: readonly string[] | undefined;
  if (raw.cmd !== undefined) {
    if (
      !Array.isArray(raw.cmd) ||
      raw.cmd.length === 0 ||
      raw.cmd.some((c) => typeof c !== "string" || c.length === 0)
    ) {
      throw new UsageError(`${where}.cmd must be a non-empty array of strings`);
    }
    cmd = raw.cmd as readonly string[];
  }
  let url: string | undefined;
  if (raw.url !== undefined) {
    if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) {
      throw new UsageError(`${where}.url must be an http(s) URL`);
    }
    url = raw.url;
  }
  let env: Readonly<Record<string, string>> | undefined;
  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env) || Object.values(raw.env).some((v) => typeof v !== "string")) {
      throw new UsageError(`${where}.env must be an object of string values`);
    }
    env = raw.env as Readonly<Record<string, string>>;
  }
  let headers: Readonly<Record<string, string>> | undefined;
  if (raw.headers !== undefined) {
    if (!isPlainObject(raw.headers) || Object.values(raw.headers).some((v) => typeof v !== "string")) {
      throw new UsageError(`${where}.headers must be an object of string values`);
    }
    headers = raw.headers as Readonly<Record<string, string>>;
  }
  if (transport === "stdio" && !cmd) {
    throw new UsageError(`${where}: transport "stdio" requires "cmd"`);
  }
  if (transport === "http" && !url) {
    throw new UsageError(`${where}: transport "http" requires "url"`);
  }
  if (transport === "http" && env) {
    // The gateway's http targets have no env concept; auth travels as headers.
    throw new UsageError(
      `${where}: transport "http" does not support "env" — use "headers" (e.g. {"authorization": "Bearer …"})`,
    );
  }
  if (transport === "stdio" && headers) {
    throw new UsageError(`${where}: "headers" only applies to transport "http"`);
  }
  return {
    id,
    transport,
    ...(cmd ? { cmd } : {}),
    ...(url ? { url } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
  };
}

/** Validate raw parsed JSON into a GatewaysConfig. Unknown top-level keys (recipes) are ignored. */
export function validateGateways(raw: unknown): GatewaysConfig {
  if (!isPlainObject(raw)) throw new UsageError("gateways.json must be a JSON object");
  const port = parsePort(raw.port, "port", GATE_DEFAULT_PORT);
  const otlpPort = parsePort(raw.otlpPort, "otlpPort", GATE_DEFAULT_OTLP_PORT);
  let failureMode: GateFailureMode = "failOpen";
  if (raw.failureMode !== undefined) {
    if (raw.failureMode !== "failOpen" && raw.failureMode !== "failClosed") {
      throw new UsageError('gateways.json: "failureMode" must be "failOpen" or "failClosed"');
    }
    failureMode = raw.failureMode;
  }
  if (raw.servers !== undefined && !Array.isArray(raw.servers)) {
    throw new UsageError('gateways.json: "servers" must be an array');
  }
  const servers = (raw.servers ?? []).map(parseServer);
  const seen = new Set<string>();
  for (const s of servers) {
    if (seen.has(s.id)) {
      throw new UsageError(`gateways.json: duplicate server id "${s.id}"`);
    }
    seen.add(s.id);
  }
  return { port, otlpPort, failureMode, servers };
}

export function readGateways(
  env: NodeJS.ProcessEnv = process.env,
): GatewaysConfig {
  const path = gatewaysPath(env);
  if (!existsSync(path)) {
    return { port: GATE_DEFAULT_PORT, otlpPort: GATE_DEFAULT_OTLP_PORT, failureMode: "failOpen", servers: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError(`${path} is not valid JSON — fix it by hand, then re-run kya gate run`);
  }
  return validateGateways(raw);
}

interface Recipe extends GatewayServer {
  readonly note: string;
}

const RECIPES: readonly Recipe[] = [
  { id: "playwright", transport: "stdio", cmd: ["npx", "-y", "@playwright/mcp@latest"], note: "Browser automation" },
  { id: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { authorization: "Bearer <github-pat>" }, note: "GitHub (remote; auth travels as a header — the gateway's http targets have no env)" },
  { id: "slack", transport: "stdio", cmd: ["npx", "-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "<xoxb-…>", SLACK_TEAM_ID: "<T…>" }, note: "Slack workspace" },
  { id: "postgresql", transport: "stdio", cmd: ["npx", "-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"], note: "PostgreSQL (pass the connection string as the last arg)" },
  { id: "filesystem", transport: "stdio", cmd: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."], note: "Local filesystem (scope = last args)" },
  { id: "context7", transport: "http", url: "https://mcp.context7.com/mcp", note: "Library docs" },
  { id: "figma", transport: "http", url: "https://mcp.figma.com/mcp", note: "Figma Dev Mode (remote)" },
  { id: "browser-use", transport: "stdio", cmd: ["uvx", "browser-use", "--mcp"], note: "Browser Use agent" },
  { id: "chrome-devtools", transport: "stdio", cmd: ["npx", "-y", "chrome-devtools-mcp@latest"], note: "Chrome DevTools" },
  { id: "atlassian", transport: "http", url: "https://mcp.atlassian.com/v1/sse", note: "Jira/Confluence (remote, OAuth)" },
  { id: "notion", transport: "http", url: "https://mcp.notion.com/mcp", note: "Notion (remote)" },
  { id: "supabase", transport: "stdio", cmd: ["npx", "-y", "@supabase/mcp-server-supabase@latest"], env: { SUPABASE_ACCESS_TOKEN: "<sbp_…>" }, note: "Supabase projects" },
  { id: "firecrawl", transport: "stdio", cmd: ["npx", "-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY: "<fc-…>" }, note: "Web scraping" },
  { id: "sequential-thinking", transport: "stdio", cmd: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"], note: "Reasoning scratchpad" },
  { id: "n8n", transport: "stdio", cmd: ["npx", "-y", "n8n-mcp"], note: "n8n workflows" },
  { id: "linear", transport: "http", url: "https://mcp.linear.app/sse", note: "Linear (remote, OAuth)" },
  { id: "serena", transport: "stdio", cmd: ["uvx", "--from", "git+https://github.com/oraios/serena", "serena-mcp-server"], note: "Code navigation" },
  { id: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp", note: "Sentry (remote, OAuth)" },
  { id: "zapier", transport: "http", url: "https://mcp.zapier.com/api/mcp/mcp", note: "Zapier actions (use your own MCP URL)" },
  { id: "exa", transport: "http", url: "https://mcp.exa.ai/mcp", note: "Web search" },
];

/**
 * Scaffold `.kya/gateways.json`: an empty active `servers` list plus the
 * `recipes` catalog — move a recipe object into `servers` and fill its
 * placeholders to enable it. Idempotent: an existing file is left alone.
 */
export function scaffoldGateways(
  env: NodeJS.ProcessEnv = process.env,
): { path: string; created: boolean } {
  const path = gatewaysPath(env);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(globalConfigDir(env), { recursive: true });
  const doc = {
    port: GATE_DEFAULT_PORT,
    // failOpen: one broken target never takes the gateway down (a missing
    // server then fails silently — its tools just vanish). failClosed is the
    // strict choice: any broken target stops the whole gateway.
    failureMode: "failOpen",
    servers: [] as unknown[],
    recipes: RECIPES.map(({ note, ...entry }) => ({ note, ...entry })),
  };
  atomicWriteSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return { path, created: true };
}
