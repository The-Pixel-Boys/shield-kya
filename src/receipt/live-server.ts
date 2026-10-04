/**
 * Local live receipt: serve HTML + SSE on loopback only, watch trail.jsonl, reload on change.
 * Requires a minted token (?t=) — same pattern as HTTP MCP shared secret.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname } from "node:path";
import type { ResolvedConfig } from "../config.js";
import { runGateDoctor, runGateRun, runGateStop } from "../commands/gate.js";
import { CLI_VERSION } from "../version.js";
import { evaluateGatewayTool } from "./gate-page.js";
import {
  loadReceiptModel,
  renderReceiptHtml,
  renderFeedPage,
  type FeedFilters,
} from "./render-receipt.js";
import { trailPath } from "../trail.js";
import { buildEventEmbeddings, EventEmbeddingCache, LocalMiniLmProvider } from "./embeddings.js";
import type { EmbeddingProvider } from "./embeddings.js";

const LOOPBACK = "127.0.0.1";
const MAX_SSE_CLIENTS = 8;

export interface LiveReceiptOptions {
  readonly config: ResolvedConfig;
  readonly sessionId?: string;
  readonly days: number;
  /** Prefer this port; 0 = ephemeral. Loopback-only bind. */
  readonly port?: number;
  /** Test-only injection point for the embedding provider. */
  readonly embeddingProvider?: EmbeddingProvider;
}

export interface LiveReceiptServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly waitUntilClosed: Promise<void>;
  close(): Promise<void>;
}

function dropClient(clients: Set<ServerResponse>, res: ServerResponse): void {
  clients.delete(res);
  try {
    res.destroy();
  } catch {
    /* already closed */
  }
}

function tokenOk(reqUrl: URL, req: { headers: { authorization?: string } }, token: string): boolean {
  const q = reqUrl.searchParams.get("t") ?? reqUrl.searchParams.get("token");
  if (q && q === token) return true;
  const auth = req.headers.authorization ?? "";
  if (auth === `Bearer ${token}`) return true;
  return false;
}

/** Exported for tests: every request handler must reject non-loopback clients. */
export function isLoopbackClient(req: {
  socket?: { remoteAddress?: string };
  headers: IncomingHttpHeaders;
}): boolean {
  // Any proxy-forwarded header means the request did not arrive directly from
  // the local browser; the report server is never behind a proxy.
  if (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.headers["forwarded"]
  ) {
    return false;
  }
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function startLiveReceiptServer(
  options: LiveReceiptOptions,
): Promise<LiveReceiptServer> {
  const cwd = options.config.cwd;
  const path = trailPath(cwd);
  const token = randomBytes(24).toString("base64url");
  const clients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let onSignal: (() => void) | undefined;
  const cache = new EventEmbeddingCache();
  const provider = options.embeddingProvider ?? new LocalMiniLmProvider(process.env);
  let embeddings = new Map<string, number[]>();

  const refreshEmbeddings = async (): Promise<void> => {
    const model = loadReceiptModel({ cwd, sessionId: options.sessionId, days: options.days });
    embeddings = await buildEventEmbeddings(model.events, provider, cache);
  };

  const embedQuery = async (q: string): Promise<number[] | undefined> => {
    if (!q.trim()) return undefined;
    return provider.embed(q.trim());
  };

  const broadcast = (): void => {
    for (const client of [...clients]) {
      try {
        client.write(`data: reload\n\n`);
      } catch {
        dropClient(clients, client);
      }
    }
  };

  const scheduleBroadcast = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(broadcast, 120);
  };

  const unauthorized = (res: ServerResponse): void => {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unauthorized\n");
  };

  const forbidden = (res: ServerResponse, body: object): void => {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify(body)}\n`);
  };

  const badRequest = (res: ServerResponse, body: object): void => {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify(body)}\n`);
  };

  const jsonOk = (res: ServerResponse, body: object): void => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify(body)}\n`);
  };

  const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });

  function isFeedFilters(value: unknown): value is FeedFilters {
    if (typeof value !== "object" || value === null) return false;
    for (const [k, v] of Object.entries(value)) {
      if (typeof k !== "string") return false;
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return false;
    }
    return true;
  }

  const server: Server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
      const isPostAction =
        req.method === "POST" &&
        (url.pathname === "/gate/playground" ||
          url.pathname === "/gate/action" ||
          url.pathname === "/stop" ||
          url.pathname === "/feed");
      if (isPostAction && !isLoopbackClient(req)) {
        return forbidden(res, { ok: false, error: "loopback only" });
      }
      if (!tokenOk(url, req, token)) {
        return unauthorized(res);
      }

      if (req.method === "POST" && url.pathname === "/gate/playground") {
        void (async () => {
          try {
            const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
            const serverId = typeof body?.server === "string" ? body.server.trim() : "";
            const toolName = typeof body?.tool === "string" ? body.tool.trim() : "";
            if (!/^[a-z0-9][a-z0-9-]*$/i.test(serverId)) {
              return badRequest(res, { ok: false, error: "invalid server id" });
            }
            if (!toolName) {
              return badRequest(res, { ok: false, error: "tool name required" });
            }
            const result = evaluateGatewayTool(serverId, toolName);
            return jsonOk(res, { ok: true, verdict: result.verdict, reason: result.reason });
          } catch {
            return badRequest(res, { ok: false, error: "invalid JSON body" });
          }
        })();
        return;
      }

      if (req.method === "POST" && url.pathname === "/gate/action") {
        void (async () => {
          try {
            const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
            const action = body?.action;
            if (action !== "start" && action !== "stop" && action !== "restart" && action !== "doctor") {
              return badRequest(res, { ok: false, error: "invalid action" });
            }
            if (action === "start" || action === "restart") {
              try {
                const result = await runGateRun(options.config);
                return jsonOk(res, {
                  ok: true,
                  action,
                  state: "running",
                  url: result.url,
                  servers: result.servers.length,
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(`${JSON.stringify({ ok: false, action, error: message })}\n`);
                return;
              }
            }
            if (action === "stop") {
              try {
                const result = await runGateStop();
                return jsonOk(res, { ok: true, action, state: "stopped", stopped: result.stopped });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(`${JSON.stringify({ ok: false, action, error: message })}\n`);
                return;
              }
            }
            // doctor
            try {
              const result = await runGateDoctor();
              return jsonOk(res, { ok: true, action, state: "doctor", report: result });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
              res.end(`${JSON.stringify({ ok: false, action, error: message })}\n`);
              return;
            }
          } catch {
            return badRequest(res, { ok: false, error: "invalid JSON body" });
          }
        })();
        return;
      }

      if (req.method === "POST" && url.pathname === "/stop") {
        jsonOk(res, { ok: true, stopped: true });
        res.on("finish", () => {
          void closeAll();
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/feed") {
        void (async () => {
          try {
            const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
            const filters = isFeedFilters(body?.filters) ? body.filters : {};
            const requestedPage = typeof body?.page === "number" && body.page > 0 ? Math.floor(body.page) : 1;
            const q = typeof body?.q === "string" ? body.q : "";
            const model = loadReceiptModel({
              cwd,
              sessionId: options.sessionId,
              days: options.days,
            });
            if (q.trim() && embeddings.size === 0) {
              await refreshEmbeddings();
            }
            const queryEmbedding = await embedQuery(q);
            const result = renderFeedPage(
              model.events,
              filters,
              requestedPage,
              Date.now(),
              true,
              q,
              embeddings,
              queryEmbedding,
            );
            return jsonOk(res, {
              ok: true,
              feedHtml: result.feedHtml,
              paginationHtml: result.paginationHtml,
              total: result.total,
              page: result.page,
              pages: result.pages,
            });
          } catch (err) {
            if (err instanceof SyntaxError) {
              return badRequest(res, { ok: false, error: "invalid JSON body" });
            }
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(`${JSON.stringify({ ok: false, error: message })}\n`);
            return;
          }
        })();
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        // Cheap liveness + version handshake for daemon reuse — never renders,
        // so a render-time failure (e.g. assertNoSecrets) cannot wedge it. The
        // version lets a newer CLI refuse to reuse a stale daemon left running
        // by an older install.
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(`${JSON.stringify({ ok: true, version: CLI_VERSION })}\n`);
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        if (clients.size >= MAX_SSE_CLIENTS) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("too many live clients\n");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        res.write(`: connected\n\n`);
        clients.add(res);
        const onErr = (): void => dropClient(clients, res);
        req.on("close", onErr);
        req.on("error", onErr);
        res.on("error", onErr);
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        let html: string;
        try {
          const q = url.searchParams.get("q") ?? "";
          html = renderReceiptHtml(
            loadReceiptModel({
              cwd,
              sessionId: options.sessionId,
              days: options.days,
              live: true,
              liveToken: token,
              searchQuery: q,
            }),
          );
        } catch {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("receipt render failed\n");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    } catch {
      try {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("error\n");
      } catch {
        /* ignore */
      }
    }
  });

  const closeAll = (): Promise<void> =>
    new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      if (debounce) clearTimeout(debounce);
      if (onSignal) {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        onSignal = undefined;
      }
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      for (const client of [...clients]) {
        dropClient(clients, client);
      }
      clients.clear();
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(done);
      const force = (server as Server & { closeAllConnections?: () => void })
        .closeAllConnections;
      if (typeof force === "function") force.call(server);
      setTimeout(done, 2000);
    });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = `http://${LOOPBACK}:${port}/?t=${token}`;

      try {
        mkdirSync(dirname(path), { recursive: true });
        watcher = watch(dirname(path), { persistent: true }, (_event, filename) => {
          if (!filename || String(filename).endsWith("trail.jsonl")) {
            scheduleBroadcast();
            void refreshEmbeddings();
          }
        });
        watcher.on("error", () => {
          /* FS errors — page stays up; next start remounts */
        });
      } catch {
        /* still serve; live reload may be degraded */
      }

      // Warm the embedding cache in the background; failures degrade to BM25.
      void refreshEmbeddings();

      const waitUntilClosed = new Promise<void>((waitResolve) => {
        onSignal = (): void => {
          void closeAll().then(waitResolve);
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        server.once("close", () => waitResolve());
      });

      resolve({
        url,
        port,
        token,
        waitUntilClosed,
        close: closeAll,
      });
    });
  });
}
