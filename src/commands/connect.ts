/**
 * kya connect <host> — wire Shield KYA MCP into a coding host's config file.
 * Idempotent create/merge/skip, modeled on start.ts mergeMcpJson.
 * Global (home) scope by default; --project for hosts with project-level config.
 * Hosts without a verified MCP config stay copy-paste recipes (recipeOnly).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../config.js";
import { UsageError } from "../errors.js";

export type ConnectScope = "global" | "project";
export type ConnectStatus = "created" | "wired" | "skipped";

interface HostSpec {
  /** Display name for humans. */
  readonly label: string;
  /** Config file under the home dir. */
  readonly globalPath?: (home: string) => string;
  /** Config file under the project cwd. */
  readonly projectPath?: (cwd: string) => string;
  /** Root key holding the server map ("mcpServers" | "mcp" | "amp.mcpServers"). */
  readonly rootKey: string;
  /** Server entry dialect. */
  readonly shape: "standard" | "opencode-local";
  /** Set when the host has no verified auto-wire: docs/hosts page to follow. */
  readonly recipeOnly?: string;
}

function cliJsPath(): string {
  // connect.ts → ../cli.js in dist; when running from dist/commands/connect.js
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function standardBlock(): Record<string, unknown> {
  return {
    command: process.execPath,
    args: [cliJsPath(), "serve-mcp", "--stdio"],
    env: {
      KYA_HOST: "ide",
      KYA_OFFLINE: "1",
    },
  };
}

function opencodeBlock(): Record<string, unknown> {
  return {
    type: "local",
    command: [process.execPath, cliJsPath(), "serve-mcp", "--stdio"],
    enabled: true,
    environment: {
      KYA_HOST: "ide",
      KYA_OFFLINE: "1",
    },
  };
}

const REGISTRY: Readonly<Record<string, HostSpec>> = {
  opencode: {
    label: "OpenCode",
    globalPath: (h) => join(h, ".config", "opencode", "opencode.json"),
    projectPath: (c) => join(c, "opencode.json"),
    rootKey: "mcp",
    shape: "opencode-local",
  },
  kilo: {
    label: "Kilo Code CLI",
    globalPath: (h) => join(h, ".config", "kilo", "kilo.json"),
    projectPath: (c) => join(c, "kilo.json"),
    rootKey: "mcp",
    shape: "opencode-local",
  },
  kiro: {
    label: "Kiro CLI",
    globalPath: (h) => join(h, ".kiro", "settings", "mcp.json"),
    projectPath: (c) => join(c, ".kiro", "settings", "mcp.json"),
    rootKey: "mcpServers",
    shape: "standard",
  },
  qwen: {
    label: "Qwen Code",
    globalPath: (h) => join(h, ".qwen", "settings.json"),
    projectPath: (c) => join(c, ".qwen", "settings.json"),
    rootKey: "mcpServers",
    shape: "standard",
  },
  kimi: {
    label: "Kimi Code CLI",
    globalPath: (h) => join(h, ".kimi-code", "mcp.json"),
    projectPath: (c) => join(c, ".kimi-code", "mcp.json"),
    rootKey: "mcpServers",
    shape: "standard",
  },
  mastracode: {
    label: "MastraCode",
    globalPath: (h) => join(h, ".mastracode", "mcp.json"),
    projectPath: (c) => join(c, ".mastracode", "mcp.json"),
    rootKey: "mcpServers",
    shape: "standard",
  },
  amp: {
    label: "Amp",
    globalPath: (h) => join(h, ".config", "amp", "settings.json"),
    rootKey: "amp.mcpServers",
    shape: "standard",
  },
  copilot: {
    label: "GitHub Copilot CLI",
    globalPath: (h) => join(h, ".copilot", "mcp-config.json"),
    rootKey: "mcpServers",
    shape: "standard",
  },
  cursor: {
    label: "Cursor (IDE + Agent CLI)",
    globalPath: (h) => join(h, ".cursor", "mcp.json"),
    projectPath: (c) => join(c, ".cursor", "mcp.json"),
    rootKey: "mcpServers",
    shape: "standard",
  },
  // Verified config but no safe auto-wire (GUI-managed or unverified schema).
  cline: {
    label: "Cline",
    rootKey: "mcpServers",
    shape: "standard",
    recipeOnly: "docs/hosts/cline.md",
  },
  droid: {
    label: "Droid",
    rootKey: "mcpServers",
    shape: "standard",
    recipeOnly: "docs/hosts/droid.md",
  },
};

export function connectableHosts(): readonly string[] {
  return Object.keys(REGISTRY).filter((k) => !REGISTRY[k]!.recipeOnly);
}

export function knownHosts(): readonly string[] {
  return Object.keys(REGISTRY);
}

export interface ConnectResult {
  readonly host: string;
  readonly label: string;
  readonly path: string;
  readonly status: ConnectStatus;
  readonly scope: ConnectScope;
  readonly next: string;
}

export interface ConnectInput {
  readonly host: string;
  readonly scope?: ConnectScope;
  readonly force?: boolean;
}

function serverBlock(spec: HostSpec): Record<string, unknown> {
  return spec.shape === "opencode-local" ? opencodeBlock() : standardBlock();
}

function mergeHostConfig(
  path: string,
  spec: HostSpec,
  force: boolean,
): ConnectStatus {
  const block = serverBlock(spec);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ [spec.rootKey]: { "shield-kya": block } }, null, 2)}\n`,
      "utf8",
    );
    return "created";
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // Never rewrite a host's real config we cannot parse — that destroys settings.
    throw new UsageError(
      `${path} is not valid JSON — fix it by hand or back it up and delete it, then re-run connect`,
    );
  }
  const existing = raw[spec.rootKey];
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    throw new UsageError(
      `${path} has "${spec.rootKey}" but it is not an object — refusing to clobber it`,
    );
  }
  const servers = (existing ?? {}) as Record<string, unknown>;
  if (servers["shield-kya"] && !force) return "skipped";
  raw[spec.rootKey] = { ...servers, "shield-kya": block };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return "wired";
}

export async function runConnect(
  config: ResolvedConfig,
  input: ConnectInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectResult> {
  const key = input.host.trim().toLowerCase();
  const spec = REGISTRY[key];
  if (!spec) {
    throw new UsageError(
      `unknown host "${input.host}" — supported: ${knownHosts().join(", ")}`,
    );
  }
  if (spec.recipeOnly) {
    throw new UsageError(
      `${spec.label} has no safe auto-wire — follow the copy-paste recipe in ${spec.recipeOnly}`,
    );
  }
  const scope: ConnectScope = input.scope ?? "global";
  const home = env.KYA_HOME?.trim() || homedir();
  const path =
    scope === "project"
      ? spec.projectPath?.(config.cwd)
      : spec.globalPath?.(home);
  if (!path) {
    throw new UsageError(
      `${spec.label} has no ${scope}-scope config — try --${scope === "project" ? "global" : "project"}`,
    );
  }
  const status = mergeHostConfig(path, spec, Boolean(input.force));
  return {
    host: key,
    label: spec.label,
    path,
    status,
    scope,
    next: `Restart ${spec.label} so the shield-kya MCP server loads. Verify: ask the agent to list its MCP tools — kya.policy_evaluate, kya.session_ingest, kya.request_approval should appear.`,
  };
}

export function formatConnectHuman(r: ConnectResult): string {
  const verb =
    r.status === "created"
      ? "created"
      : r.status === "wired"
        ? "wired"
        : "already wired (skipped — use --force to overwrite)";
  return [
    `KYA connect ${r.host}`,
    `${verb}: ${r.path}`,
    r.next,
  ].join("\n");
}
