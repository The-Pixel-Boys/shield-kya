/**
 * Local live receipt: serve HTML + SSE on loopback only, watch trail.jsonl, reload on change.
 * Requires a minted token (?t=) — same pattern as HTTP MCP shared secret.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { configDir, type ResolvedConfig } from "../config.js";
import { loadReceiptModel, renderReceiptHtml } from "./render-receipt.js";
import { trailPath } from "../trail.js";

const LOOPBACK = "127.0.0.1";
const MAX_SSE_CLIENTS = 8;

export interface LiveReceiptOptions {
  readonly config: ResolvedConfig;
  readonly sessionId?: string;
  readonly days: number;
  /** Prefer this port; 0 = ephemeral. Loopback-only bind. */
  readonly port?: number;
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

  const server: Server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
      if (!tokenOk(url, req, token)) {
        return unauthorized(res);
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
          html = renderReceiptHtml(
            loadReceiptModel({
              cwd,
              sessionId: options.sessionId,
              days: options.days,
              live: true,
            }),
          );
        } catch {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("receipt render failed\n");
          return;
        }
        // Inject token into EventSource so the browser can auth without a second prompt.
        html = html.replace(
          "EventSource('/events')",
          `EventSource('/events?t=${token}')`,
        );
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
        mkdirSync(configDir(cwd), { recursive: true });
        watcher = watch(dirname(path), { persistent: true }, (_event, filename) => {
          if (!filename || String(filename).endsWith("trail.jsonl")) {
            scheduleBroadcast();
          }
        });
        watcher.on("error", () => {
          /* FS errors — page stays up; next start remounts */
        });
      } catch {
        /* still serve; live reload may be degraded */
      }

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
