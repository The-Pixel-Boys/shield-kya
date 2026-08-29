import { randomBytes, timingSafeEqual } from "node:crypto";
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
  /** Optional shared secret; also read from KYA_MCP_HTTP_TOKEN. */
  readonly sharedSecret?: string;
}

export interface HttpMcpServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  /** Required on every route except GET /health. */
  readonly token: string;
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
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 64 * 1024;

export function startHttpMcp(options: HttpMcpOptions): Promise<HttpMcpServer> {
  const listenHost = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(listenHost)) {
    return Promise.reject(new Error("HTTP MCP may only bind to loopback"));
  }
  const sharedSecret =
    options.sharedSecret ??
    process.env.KYA_MCP_HTTP_TOKEN ??
    randomBytes(24).toString("base64url");
  const ctx: McpHandlerContext = {
    client: options.client,
    host: options.kyaHost,
    agentId: options.agentId,
  };

  const server = createServer((req, res) => {
    void handleHttp(req, res, ctx, sharedSecret);
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
        token: sharedSecret,
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
  sharedSecret: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (!hostIsLoopback(req)) {
      return json(res, 421, { error: "misdirected" });
    }

    if (method === "GET" && (path === "/health" || path === "/")) {
      return json(res, 200, {
        ok: true,
        server: MCP_SERVER_INFO.name,
        version: MCP_SERVER_INFO.version,
      });
    }

    if (!authorizeMcp(req, res, sharedSecret)) {
      return;
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
      const msg = parseJsonBody(body) as JsonRpcRequest;
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
      const args = body
        ? (parseJsonBody(body) as Record<string, unknown>)
        : {};
      const result = await handleMcpToolCall(name, args, ctx);
      return json(res, result.isError ? 400 : 200, result);
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return json(res, 400, { error: "invalid json" });
    }
    if (err instanceof Error && err.message === "body too large") {
      return json(res, 413, { error: "body too large" });
    }
    json(res, 500, { error: "internal error" });
  }
}

function parseJsonBody(body: string): unknown {
  if (!body) return {};
  return JSON.parse(body) as unknown;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorizeMcp(
  req: IncomingMessage,
  res: ServerResponse,
  sharedSecret: string,
): boolean {
  if (!sharedSecret) {
    return true;
  }
  const presented = req.headers["x-kya-mcp-token"];
  const token = Array.isArray(presented) ? presented[0] : presented;
  if (!token || !tokensEqual(token, sharedSecret)) {
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function tokensEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function hostIsLoopback(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  const header = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  let hostname = header;
  if (hostname.startsWith("[")) {
    const end = hostname.indexOf("]");
    hostname = end >= 0 ? hostname.slice(1, end) : hostname;
  } else {
    hostname = hostname.split(":")[0] ?? "";
  }
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
