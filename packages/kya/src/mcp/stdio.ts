import * as readline from "node:readline";
import type { KyaHttpClient } from "../client.js";
import type { Host } from "../config.js";
import {
  handleJsonRpc,
  type JsonRpcRequest,
  type McpHandlerContext,
} from "./protocol.js";

export interface StdioMcpOptions {
  readonly client: KyaHttpClient;
  readonly kyaHost: Host;
  readonly agentId?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** When true, do not attach process signal handlers (tests). */
  readonly bare?: boolean;
}

export interface StdioMcpHandle {
  /** Resolve when stream ends. */
  readonly done: Promise<void>;
  close(): void;
}

/**
 * MCP over stdio — newline-delimited JSON-RPC 2.0 (common host shape).
 * Also accepts Content-Length framed messages (LSP-style) when headers present.
 */
export function startStdioMcp(options: StdioMcpOptions): StdioMcpHandle {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const ctx: McpHandlerContext = {
    client: options.client,
    host: options.kyaHost,
    agentId: options.agentId,
  };

  let closed = false;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const done = new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      void onLine(line.trim(), ctx, output);
    });
    rl.on("close", () => {
      closed = true;
      resolve();
    });
  });

  return {
    done,
    close() {
      if (!closed) rl.close();
    },
  };
}

async function onLine(
  line: string,
  ctx: McpHandlerContext,
  output: NodeJS.WritableStream,
): Promise<void> {
  if (!line || line.startsWith("Content-Length:")) {
    // Content-Length framing without body on same line — skip header-only lines
    return;
  }
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeJson(output, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
  if (!msg.method) {
    writeJson(output, {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: { code: -32600, message: "Invalid Request" },
    });
    return;
  }
  const response = await handleJsonRpc(msg, ctx);
  if (response !== null) {
    writeJson(output, response);
  }
}

function writeJson(output: NodeJS.WritableStream, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}
