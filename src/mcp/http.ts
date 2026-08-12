import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { KyaHttpClient } from "../client.js";
import type { Host } from "../config.js";
import {
  handleJsonRpc,
  handleMcpToolCall,
  MCP_SERVER_INFO,
  MCP_TOOLS,
  type JsonRpcRequest,
  type McpHandlerContext,
} from "./protocol.js";

export interface HttpMcpOptions {
  readonly host?: string;
  readonly port: number;
  readonly client: KyaHttpClient;
  readonly kyaHost: Host;
  readonly agentId?: string;
}

export interface HttpMcpServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Lightweight HTTP MCP gate for local smoke / non-stdio hosts.
 * - GET  /health
 * - GET  /connectors/mcp.json  (descriptor)
 * - GET  /mcp/tools
 * - POST /mcp                  (JSON-RPC)
 * - POST /mcp/tools/:name      (direct tool call)
 */
export function startHttpMcp(options: HttpMcpOptions): Promise<HttpMcpServer> {
  const listenHost = options.host ?? "127.0.0.1";
  const ctx: McpHandlerContext = {
    client: options.client,
    host: options.kyaHost,
    agentId: options.agentId,
  };

  const server = createServer((req, res) => {
    void handleHttp(req, res, ctx);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, listenHost, () => {
      const addr = server.address();
      const port =
        typeof addr === "object" && addr ? addr.port : options.port;
      resolve({
        server,
        port,
        url: `http://${listenHost}:${port}`,
        close: () =>
          new Promise((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McpHandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && (path === "/health" || path === "/")) {
      return json(res, 200, {
        ok: true,
        server: MCP_SERVER_INFO.name,
        version: MCP_SERVER_INFO.version,
      });
    }

    if (method === "GET" && path === "/connectors/mcp.json") {
      return json(res, 200, {
        name: MCP_SERVER_INFO.name,
        title: MCP_SERVER_INFO.title,
        description: MCP_SERVER_INFO.description,
        protocol: "mcp",
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        http: {
          policyEvaluate: "/api/v1/kya/policy/evaluate",
          sessionIngest: "/api/v1/kya/sessions/ingest",
          mcp: "/mcp",
        },
      });
    }

    if (method === "GET" && path === "/mcp/tools") {
      return json(res, 200, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    if (method === "POST" && path === "/mcp") {
      const body = await readBody(req);
      const msg = JSON.parse(body || "{}") as JsonRpcRequest;
      const response = await handleJsonRpc(msg, ctx);
      if (response === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      return json(res, 200, response);
    }

    const toolMatch = path.match(/^\/mcp\/tools\/([^/]+)$/);
    if (method === "POST" && toolMatch) {
      const name = decodeURIComponent(toolMatch[1]!);
      const body = await readBody(req);
      const args = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const result = await handleMcpToolCall(name, args, ctx);
      return json(res, result.isError ? 400 : 200, result);
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: message });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
