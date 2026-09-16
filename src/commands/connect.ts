/**
 * kya connect <host> — wire Shield KYA MCP into a coding host's config file.
 * Idempotent create/merge/skip. Global (home) scope by default; --project for
 * hosts with project-level config. Hosts without a verified MCP config stay
 * copy-paste recipes (recipeOnly).
 *
 * Home-config writes are merge-only and symlink-safe: an existing target is
 * resolved with realpath and must be a regular file (dotfile setups symlink
 * ~/.claude.json & co. — writing the resolved regular file is supported).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../config.js";
import { UsageError } from "../errors.js";
import { hostReload, hostRunning, listProcessNames, reloadMessage } from "../host-reload.js";
import { hookSupported, wireHook } from "./wire-hooks.js";

export type ConnectScope = "global" | "project";
export type ConnectStatus = "created" | "wired" | "skipped";

export interface HostSpec {
  /** Display name for humans. */
  readonly label: string;
  /** Config file under the home dir. */
  readonly globalPath?: (home: string) => string;
  /** Config file under the project cwd. */
  readonly projectPath?: (cwd: string) => string;
  /** Root key holding the server map ("mcpServers" | "mcp" | "amp.mcpServers"). */
  readonly rootKey: string;
  /** Server entry dialect. */
  readonly shape: "standard" | "opencode-local" | "grok-toml";
  /** Set when the host has no verified auto-wire: docs/hosts page to follow. */
  readonly recipeOnly?: string;
}

export function cliJsPath(): string {
  // connect.ts → ../cli.js in dist; when running from dist/commands/connect.js
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

export function standardServerBlock(hostId: string): Record<string, unknown> {
  return {
    command: process.execPath,
    args: [cliJsPath(), "serve-mcp", "--stdio"],
    env: {
      KYA_HOST: "ide",
      KYA_OFFLINE: "1",
      // Separates MCP-originated activity per host on the report's Sessions panel.
      KYA_SESSION_ID: `mcp:${hostId}`,
    },
  };
}

function opencodeBlock(hostId: string): Record<string, unknown> {
  return {
    type: "local",
    command: [process.execPath, cliJsPath(), "serve-mcp", "--stdio"],
    enabled: true,
    environment: {
      KYA_HOST: "ide",
      KYA_OFFLINE: "1",
      KYA_SESSION_ID: `mcp:${hostId}`,
    },
  };
}

export const CONNECT_REGISTRY: Readonly<Record<string, HostSpec>> = {
  claude: {
    label: "Claude Code",
    globalPath: (h) => join(h, ".claude.json"),
    projectPath: (c) => join(c, ".mcp.json"),
    rootKey: "mcpServers",
    shape: "standard",
  },
  grok: {
    label: "Grok",
    globalPath: (h) => join(h, ".grok", "config.toml"),
    rootKey: "mcp_servers",
    shape: "grok-toml",
  },
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
  return Object.keys(CONNECT_REGISTRY).filter((k) => !CONNECT_REGISTRY[k]!.recipeOnly);
}

export function knownHosts(): readonly string[] {
  return Object.keys(CONNECT_REGISTRY);
}

export interface ConnectResult {
  readonly host: string;
  readonly label: string;
  readonly path: string;
  readonly status: ConnectStatus;
  readonly scope: ConnectScope;
  /** Set when --hooks wired (or created) the host's PreToolUse hook config. */
  readonly hooksPath?: string;
  readonly hooksStatus?: ConnectStatus;
  readonly next: string;
}

export interface ConnectInput {
  readonly host: string;
  readonly scope?: ConnectScope;
  readonly force?: boolean;
  /** Also wire the host's PreToolUse hook (claude/grok/kimi only). */
  readonly hooks?: boolean;
  /** Test hook: running process basenames instead of a live ps scan. */
  readonly procs?: ReadonlySet<string>;
}

function serverBlock(hostId: string, spec: HostSpec): Record<string, unknown> {
  return spec.shape === "opencode-local"
    ? opencodeBlock(hostId)
    : standardServerBlock(hostId);
}

/**
 * Resolve the path a write will land on. An existing symlinked host config
 * (dotfiles setups) resolves to its real regular file; anything else that
 * exists but is not a regular file is refused.
 */
export function writeTarget(path: string): string {
  if (!existsSync(path)) return path;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new UsageError(`${path} cannot be resolved — refusing to write`);
  }
  if (!statSync(real).isFile()) {
    throw new UsageError(
      `${path} does not resolve to a regular file — refusing to write`,
    );
  }
  return real;
}

/**
 * Crash-safe write: tmp file in the same directory, then rename onto the
 * target (atomic on POSIX and win32 within one volume). A mid-write crash
 * leaves the original config intact; the tmp file is removed best-effort.
 * An existing target's file mode is carried over — a rename would otherwise
 * turn a 0600 config into the umask default.
 */
export function atomicWriteSync(target: string, content: string): void {
  const tmp = `${target}.kya-tmp-${process.pid}`;
  try {
    let mode: number | undefined;
    try {
      mode = statSync(target).mode;
    } catch {
      /* new file — keep default mode */
    }
    writeFileSync(tmp, content, "utf8");
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode);
      } catch {
        /* win32 chmod semantics differ; POSIX correctness is what matters */
      }
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Where a create should land. A dangling symlink (dotfiles target not yet
 * materialized) resolves to its link target — relative links resolve against
 * the link's directory — so the rename completes the link instead of
 * replacing it with a regular file.
 */
export function createTarget(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      const resolved = resolve(dirname(path), readlinkSync(path));
      mkdirSync(dirname(resolved), { recursive: true });
      return resolved;
    }
  } catch {
    /* not a symlink or unreadable link — plain create below */
  }
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Merge "shield-kya" into a JSON host config under rootKey. Never clobbers. */
export function mergeJsonHostConfig(
  path: string,
  rootKey: string,
  block: Record<string, unknown>,
  force: boolean,
): ConnectStatus {
  if (!existsSync(path)) {
    atomicWriteSync(
      createTarget(path),
      `${JSON.stringify({ [rootKey]: { "shield-kya": block } }, null, 2)}\n`,
    );
    return "created";
  }
  const target = writeTarget(path);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  } catch {
    // Never rewrite a host's real config we cannot parse — that destroys settings.
    throw new UsageError(
      `${path} is not valid JSON — fix it by hand or back it up and delete it, then re-run connect`,
    );
  }
  const existing = raw[rootKey];
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    throw new UsageError(
      `${path} has "${rootKey}" but it is not an object — refusing to clobber it`,
    );
  }
  const servers = (existing ?? {}) as Record<string, unknown>;
  // Presence of the key — even a null value — counts as wired: never touch it
  // without --force.
  if (Object.prototype.hasOwnProperty.call(servers, "shield-kya") && !force) {
    return "skipped";
  }
  raw[rootKey] = { ...servers, "shield-kya": block };
  atomicWriteSync(target, `${JSON.stringify(raw, null, 2)}\n`);
  return "wired";
}

const GROK_TABLE_HEADER = "[mcp_servers.shield-kya]";
// Horizontal whitespace only ([^\S\n]): \s would match newlines and let the
// match start on a preceding blank line, mis-slicing the --force replace.
const GROK_TABLE_RE = /^[^\S\n]*\[mcp_servers\.shield-kya\][^\S\n]*(?:#.*)?$/m;
const GROK_QUOTED_TABLE_RE =
  /^\s*\[\s*mcp_servers\s*\.\s*["']shield-kya["']\s*\]/m;
const GROK_INLINE_RE = /^\s*shield-kya\s*=/m;

function grokTableBlock(hostId: string): string {
  // JSON string literal syntax is valid TOML for these shapes.
  const args = [cliJsPath(), "serve-mcp", "--stdio"]
    .map((s) => JSON.stringify(s))
    .join(", ");
  return [
    GROK_TABLE_HEADER,
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${args}]`,
    `env = { KYA_HOST = "ide", KYA_OFFLINE = "1", KYA_SESSION_ID = ${JSON.stringify(`mcp:${hostId}`)} }`,
    "enabled = true",
    "",
  ].join("\n");
}

/**
 * Minimal TOML wiring for Grok: append the [mcp_servers.shield-kya] table at
 * EOF, skip when present, --force replaces the existing table block. An inline
 * `shield-kya = …` definition under [mcp_servers] cannot be merged safely as
 * text — refuse it with a clear error.
 */
function mergeGrokToml(path: string, hostId: string, force: boolean): ConnectStatus {
  const block = grokTableBlock(hostId);
  if (!existsSync(path)) {
    atomicWriteSync(createTarget(path), block);
    return "created";
  }
  const target = writeTarget(path);
  const text = readFileSync(target, "utf8");
  const header = GROK_TABLE_RE.exec(text);
  if (header && !force) return "skipped";
  if (!header) {
    if (GROK_QUOTED_TABLE_RE.test(text)) {
      throw new UsageError(
        `${path} has a quoted [mcp_servers."shield-kya"] table — appending an unquoted one would duplicate it; fix the header by hand, then re-run connect`,
      );
    }
    if (GROK_INLINE_RE.test(text)) {
      throw new UsageError(
        `${path} defines shield-kya inline under [mcp_servers] — remove that line by hand, then re-run connect`,
      );
    }
    const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    atomicWriteSync(target, `${text}${sep}${block}`);
    return "wired";
  }
  // --force: replace the existing table (header line through the next table
  // header or EOF) with a fresh block.
  const start = header.index;
  const lineEnd = text.indexOf("\n", start);
  const bodyStart = lineEnd === -1 ? text.length : lineEnd + 1;
  const nextHeader = text.slice(bodyStart).search(/^[^\S\n]*\[/m);
  const end = nextHeader === -1 ? text.length : bodyStart + nextHeader;
  const replaced = `${text.slice(0, start)}${block}${text.slice(end)}`;
  atomicWriteSync(target, replaced);
  return "wired";
}

function mergeHostConfig(
  path: string,
  hostId: string,
  spec: HostSpec,
  force: boolean,
): ConnectStatus {
  if (spec.shape === "grok-toml") return mergeGrokToml(path, hostId, force);
  return mergeJsonHostConfig(path, spec.rootKey, serverBlock(hostId, spec), force);
}

export interface WireHostInput {
  readonly host: string;
  readonly scope?: ConnectScope;
  readonly force?: boolean;
  readonly home: string;
  readonly cwd: string;
}

export interface WireHostResult {
  readonly host: string;
  readonly label: string;
  readonly path: string;
  readonly status: ConnectStatus;
  readonly scope: ConnectScope;
}

/** Shared wiring used by `kya connect` and `kya start`. */
export function wireHost(input: WireHostInput): WireHostResult {
  const key = input.host.trim().toLowerCase();
  const spec = CONNECT_REGISTRY[key];
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
  const path =
    scope === "project"
      ? spec.projectPath?.(input.cwd)
      : spec.globalPath?.(input.home);
  if (!path) {
    throw new UsageError(
      `${spec.label} has no ${scope}-scope config — try --${scope === "project" ? "global" : "project"}`,
    );
  }
  const status = mergeHostConfig(path, key, spec, Boolean(input.force));
  return { host: key, label: spec.label, path, status, scope };
}

/** Per-host next-step line after wiring (accurate about restarts). */
export function wireNextMessage(
  hostId: string,
  label: string,
  procs: ReadonlySet<string>,
): string {
  const verify =
    "Verify: ask the agent to list its MCP tools — kya.policy_evaluate, kya.session_ingest, kya.request_approval should appear.";
  const reload = hostReload(hostId);
  return reload
    ? `${reloadMessage(reload, label, hostRunning(reload, procs))} ${verify}`
    : `Restart ${label} so the shield-kya MCP server loads. ${verify}`;
}

export async function runConnect(
  config: ResolvedConfig,
  input: ConnectInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectResult> {
  const home = env.KYA_HOME?.trim() || homedir();
  if (input.hooks && !hookSupported(input.host)) {
    throw new UsageError(
      `no hook wiring for ${input.host} — supported: claude, grok, kimi`,
    );
  }
  const wired = wireHost({
    host: input.host,
    scope: input.scope,
    force: input.force,
    home,
    cwd: config.cwd,
  });
  let hooksPath: string | undefined;
  let hooksStatus: ConnectStatus | undefined;
  if (input.hooks) {
    let r;
    try {
      r = wireHook({ host: wired.host, home, force: input.force });
    } catch (err) {
      // The MCP write already landed — say so, so the user knows the state.
      if (err instanceof UsageError) {
        throw new UsageError(
          `${err.message} (note: MCP config was already wired at ${wired.path})`,
        );
      }
      throw err;
    }
    hooksPath = r.path;
    hooksStatus = r.status;
  }
  return {
    ...wired,
    hooksPath,
    hooksStatus,
    next:
      wireNextMessage(
        wired.host,
        wired.label,
        input.procs ?? listProcessNames(),
      ) + (hooksStatus && hooksStatus !== "skipped" ? " Hooks take effect in new sessions." : ""),
  };
}

export function formatConnectHuman(r: ConnectResult): string {
  const verb =
    r.status === "created"
      ? "created"
      : r.status === "wired"
        ? "wired"
        : "already wired (skipped — use --force to overwrite)";
  const hooksVerb =
    r.hooksStatus === undefined
      ? undefined
      : r.hooksStatus === "created"
        ? "hooks created"
        : r.hooksStatus === "wired"
          ? "hooks wired"
          : "hooks already wired (skipped — use --force to overwrite)";
  return [
    `KYA connect ${r.host}`,
    `${verb}: ${r.path}`,
    hooksVerb ? `${hooksVerb}: ${r.hooksPath}` : undefined,
    r.next,
  ]
    .filter(Boolean)
    .join("\n");
}
