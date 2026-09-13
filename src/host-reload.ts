/**
 * Per-host MCP reload behavior — researched against official docs, 2026-09.
 * The blanket "restart your host" instruction was wrong for most hosts: many
 * watch their config file (or offer an in-session reload) and pick up a new
 * server with no restart at all. Messaging in `connect` / `start` is built
 * from this table, and docs/hosts/<id>.md pages mirror it.
 *
 * Classes:
 *   auto    — new server is picked up in the running host (file watcher or
 *             in-session refresh; detail says which)
 *   session — loads in the next session/conversation; app stays open
 *   restart — process must be relaunched (resumeTip preserves context if any)
 */
import { execFileSync } from "node:child_process";

export type ReloadClass = "auto" | "session" | "restart";

export interface HostReload {
  readonly id: string;
  readonly reload: ReloadClass;
  /** One-line mechanism note, shown verbatim to users. */
  readonly detail: string;
  /** Process-name fragments (basename, lowercase) for running detection. */
  readonly processNames: readonly string[];
  /** Context-preserving relaunch tip, when the host has one. */
  readonly resumeTip?: string;
}

export const HOST_RELOAD: Readonly<Record<string, HostReload>> = {
  cursor: {
    id: "cursor",
    reload: "auto",
    detail: "Cursor watches mcp.json and starts new stdio servers on its own",
    processNames: ["cursor", "cursor-agent"],
  },
  kiro: {
    id: "kiro",
    reload: "auto",
    detail: "Kiro hot-reloads mcp.json on save — only the new server starts",
    processNames: ["kiro", "kiro-cli"],
  },
  qwen: {
    id: "qwen",
    reload: "auto",
    detail: "Qwen Code live-reconciles MCP servers when settings.json changes",
    processNames: ["qwen"],
  },
  amp: {
    id: "amp",
    reload: "auto",
    detail: "Amp applies settings.json changes live (workspace entries need one approval)",
    processNames: ["amp"],
  },
  droid: {
    id: "droid",
    reload: "auto",
    detail: "Droid reloads automatically when mcp.json changes",
    processNames: ["droid"],
  },
  cline: {
    id: "cline",
    reload: "auto",
    detail: "Cline watches cline_mcp_settings.json and connects new servers on save",
    processNames: ["code", "code-insiders"],
  },
  grok: {
    id: "grok",
    reload: "auto",
    detail: "in a running Grok session press r in /mcps to refresh after config edits",
    processNames: ["grok"],
  },
  mastracode: {
    id: "mastracode",
    reload: "auto",
    detail: "in a running MastraCode session run /mcp to reload connections",
    processNames: ["mastracode"],
  },
  kimi: {
    id: "kimi",
    reload: "session",
    detail: "Kimi Code registers MCP servers at session start — a new session is enough",
    processNames: ["kimi"],
  },
  claude: {
    id: "claude",
    reload: "restart",
    detail: "Claude Code loads MCP servers at process start",
    processNames: ["claude"],
    resumeTip: "claude --resume keeps the conversation",
  },
  codex: {
    id: "codex",
    reload: "restart",
    detail: "Codex loads MCP servers at process start",
    processNames: ["codex"],
  },
  gemini: {
    id: "gemini",
    reload: "restart",
    detail: "Gemini CLI reads mcpServers once at startup (marked requiresRestart)",
    processNames: ["gemini"],
  },
  copilot: {
    id: "copilot",
    reload: "restart",
    detail: "Copilot CLI loads MCP servers at startup",
    processNames: ["copilot"],
  },
  opencode: {
    id: "opencode",
    reload: "restart",
    detail: "OpenCode connects MCP servers once at startup (hot-reload lands in v2)",
    processNames: ["opencode"],
  },
  kilo: {
    id: "kilo",
    reload: "restart",
    detail: "Kilo Code CLI reads kilo.json at startup (the VS Code extension hot-reloads instead)",
    processNames: ["kilo"],
  },
};

export function hostReload(id: string): HostReload | undefined {
  return HOST_RELOAD[id];
}

/** Basenames of running processes (lowercase). POSIX ps; empty on failure. */
export function listProcessNames(platform: NodeJS.Platform = process.platform): ReadonlySet<string> {
  try {
    if (platform === "win32") {
      const out = execFileSync("tasklist", ["/fo", "csv", "/nh"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return new Set(
        out
          .split("\n")
          .map((line) => line.split('","')[0]?.replace(/^"|"$/g, "").toLowerCase())
          .filter((name): name is string => Boolean(name)),
      );
    }
    const out = execFileSync("ps", ["-axo", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      out
        .split("\n")
        .map((line) => line.trim().split("/").pop()?.toLowerCase())
        .filter((name): name is string => Boolean(name)),
    );
  } catch {
    return new Set();
  }
}

export function hostRunning(info: HostReload, procs: ReadonlySet<string>): boolean {
  return info.processNames.some((name) => procs.has(name));
}

/** Human next-step line for a just-wired host, accurate about restarts. */
export function reloadMessage(info: HostReload, label: string, running: boolean): string {
  switch (info.reload) {
    case "auto":
      return `No restart needed — ${info.detail}.`;
    case "session":
      return running
        ? `${label} is running — start a new session to load shield-kya (${info.detail}). No app restart.`
        : `shield-kya loads in your next ${label} session — no restart needed.`;
    case "restart":
      return running
        ? `${label} is running — relaunch it to load shield-kya (${info.detail}${info.resumeTip ? `; ${info.resumeTip}` : ""}).`
        : `shield-kya loads when you next start ${label} — it is not running, so nothing to restart.`;
  }
}
