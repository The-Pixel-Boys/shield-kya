/**
 * Integration: what each host would spawn from the config `kya connect` writes,
 * then a real MCP stdio handshake (initialize + tools/list) against it.
 * Requires `pnpm build` first (hosts spawn dist/cli.js).
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { connectableHosts, runConnect } from "../src/commands/connect.js";

const root = join(import.meta.dirname, "..");
const cliJs = join(root, "dist", "cli.js");

interface WiredServer {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

/** Read the written config the way the host would. */
function extractServer(host: string, configPath: string): WiredServer {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  if (host === "opencode" || host === "kilo") {
    const entry = raw["mcp"]?.["shield-kya"] as {
      command: string[];
      environment: Record<string, string>;
    };
    return {
      command: entry.command[0]!,
      args: entry.command.slice(1),
      env: entry.environment,
    };
  }
  const rootKey = host === "amp" ? "amp.mcpServers" : "mcpServers";
  const entry = raw[rootKey]?.["shield-kya"] as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  return { command: entry.command, args: entry.args, env: entry.env };
}

interface JsonRpcResponse {
  readonly id: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

function handshake(
  server: WiredServer,
  env: Record<string, string>,
): Promise<{ initialize: JsonRpcResponse; toolsList: JsonRpcResponse }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // vitest runs from src; a real install wires dist/cli.js — spawn exactly that.
    const args = [...server.args];
    args[0] = cliJs;
    const child = spawn(server.command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("handshake timed out"));
    }, 15000);

    let buffer = "";
    const byId = new Map<number, JsonRpcResponse>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === "number") byId.set(msg.id, msg);
        } catch {
          /* ignore non-JSON chatter */
        }
      }
      const init = byId.get(0);
      const list = byId.get(1);
      if (init && list) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolvePromise({ initialize: init, toolsList: list });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(
        new Error(`serve-mcp exited ${code} before handshake completed`),
      );
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "connect-mcp-test", version: "0.0.0" },
        },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    );
  });
}

describe("connect → host spawns serve-mcp → MCP handshake", () => {
  for (const host of connectableHosts()) {
    it(
      `${host}: wired config yields a live MCP server with the 3 kya tools`,
      { timeout: 20000 },
      async () => {
        expect(
          existsSync(cliJs),
          "dist/cli.js missing — run pnpm build first",
        ).toBe(true);
        const home = mkdtempSync(join(tmpdir(), "kya-connect-mcp-"));
        const cwd = mkdtempSync(join(tmpdir(), "kya-connect-mcp-cwd-"));
        try {
          const config = resolveConfig({
            cwd,
            offline: true,
            allowMissingApiKey: true,
            flags: { offline: true },
          });
          const wired = await runConnect(config, { host }, { KYA_HOME: home });
          const server = extractServer(host, wired.path);
          const { initialize, toolsList } = await handshake(server, server.env);

          expect(initialize.error).toBeUndefined();
          const serverInfo = (initialize.result as { serverInfo: { name: string } })
            .serverInfo;
          expect(serverInfo.name).toBe("shield-kya");

          expect(toolsList.error).toBeUndefined();
          const tools = (toolsList.result as { tools: { name: string }[] }).tools;
          expect(tools.map((t) => t.name).sort()).toEqual([
            "kya.policy_evaluate",
            "kya.request_approval",
            "kya.session_ingest",
          ]);
        } finally {
          rmSync(home, { recursive: true, force: true });
          rmSync(cwd, { recursive: true, force: true });
        }
      },
    );
  }
});
