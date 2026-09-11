/**
 * One-shot OSS onboarding: init → wire local MCP → open live activity report.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "../config.js";
import { runInit } from "./init.js";
import { runReceipt } from "./receipt.js";
import { appendTrail, defaultSessionId } from "../trail.js";

export interface StartResult {
  readonly initCreated: readonly string[];
  readonly wired: readonly string[];
  readonly skipped: readonly string[];
  readonly liveUrl?: string;
  readonly keepAlive?: Promise<void>;
  readonly next: string;
}

function cliJsPath(): string {
  // start.ts → ../cli.js in dist; when running from dist/commands/start.js
  return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function mcpServerBlock(): Record<string, unknown> {
  return {
    command: process.execPath,
    args: [cliJsPath(), "serve-mcp", "--stdio"],
    env: {
      KYA_HOST: "ide",
      KYA_OFFLINE: "1",
    },
  };
}

function mergeMcpJson(path: string, force: boolean): "wired" | "skipped" | "created" {
  const block = mcpServerBlock();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ mcpServers: { "shield-kya": block } }, null, 2)}\n`,
      "utf8",
    );
    return "created";
  }
  if (!force) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      if (raw.mcpServers?.["shield-kya"]) return "skipped";
      const next = {
        ...raw,
        mcpServers: { ...(raw.mcpServers ?? {}), "shield-kya": block },
      };
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return "wired";
    } catch {
      /* fall through rewrite */
    }
  }
  writeFileSync(
    path,
    `${JSON.stringify({ mcpServers: { "shield-kya": block } }, null, 2)}\n`,
    "utf8",
  );
  return "wired";
}

function seedTrailIfEmpty(cwd: string): void {
  const trail = join(cwd, ".kya", "trail.jsonl");
  if (existsSync(trail) && readFileSync(trail, "utf8").trim()) return;
  appendTrail(cwd, {
    ts: new Date().toISOString(),
    sessionId: defaultSessionId(),
    product: "ide",
    toolId: "kya.start",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    summary: "KYA started — wire MCP in your host, then wrap tools here",
  });
}

export async function runStart(
  config: ResolvedConfig,
  input: { force?: boolean; open?: boolean } = {},
): Promise<StartResult> {
  const force = Boolean(input.force);
  const open = input.open !== false;

  const init = runInit({ cwd: config.cwd, force: false });
  const wired: string[] = [];
  const skipped: string[] = [...init.skipped];

  const targets = [
    join(config.cwd, ".mcp.json"), // Claude Code
    join(config.cwd, "mcp.json"),
    join(config.cwd, ".cursor", "mcp.json"), // Cursor project MCP
  ];
  for (const path of targets) {
    const status = mergeMcpJson(path, force);
    if (status === "skipped") skipped.push(path);
    else wired.push(path);
  }

  seedTrailIfEmpty(config.cwd);

  let liveUrl: string | undefined;
  let keepAlive: Promise<void> | undefined;
  if (open) {
    const receipt = await runReceipt(config, { open: true, days: 3 });
    liveUrl = receipt.liveUrl;
    keepAlive = receipt.keepAlive;
  }

  return {
    initCreated: init.created,
    wired,
    skipped,
    liveUrl,
    keepAlive,
    next:
      "Restart Cursor / Claude Code / Codex so shield-kya MCP loads. " +
      "Then use wrap/evaluate tools — this report updates live. " +
      "Ctrl+C stops the report server.",
  };
}

export function formatStartHuman(r: StartResult): string {
  return [
    "KYA start",
    r.initCreated.length ? `init: ${r.initCreated.join(", ")}` : "init: ok",
    r.wired.length ? `wired: ${r.wired.join(", ")}` : undefined,
    r.liveUrl ? `report: ${r.liveUrl}` : undefined,
    r.next,
  ]
    .filter(Boolean)
    .join("\n");
}
