/**
 * Local live receipt: serve HTML + SSE on loopback only, watch trail.jsonl, reload on change.
 * Requires a minted token (?t=) - same pattern as HTTP MCP shared secret.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { kyaHome, readFileConfig, type ResolvedConfig } from "../config.js";
import { runGateDoctor, runGateRun, runGateStop } from "../commands/gate.js";
import { runInvestigate } from "../commands/investigate.js";
import { runOrr } from "../commands/orr.js";
import { loadInvestigateLastRun } from "../investigate/last-run.js";
import {
  defaultAgtAuditPath,
  importTraces,
  type ImportSource,
} from "../importers/index.js";
import {
  notifyOnTrailEvent,
  resolveWebhooks,
  type NotifyFileConfig,
} from "../notify/index.js";
import { otlpExportSelfTest, resolveOtlpExportConfig } from "../otel/exporter.js";
import { CLI_VERSION } from "../version.js";
import { scanEndpoint } from "../discover/scan.js";
import { writeDiscoverySnapshot } from "../discover/snapshot.js";
import { evaluateGatewayTool } from "./gate-page.js";
import {
  loadReceiptModel,
  renderReceiptHtml,
  renderFeedPage,
  buildLiveFragments,
  type FeedFilters,
} from "./render-receipt.js";
import { trailPath, type TrailEvent } from "../trail.js";
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

/** Outcome of one report action, mapped onto jsonOk/badRequest by the server. */
export interface ReportActionResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const IMPORT_SOURCES: readonly ImportSource[] = ["langsmith", "langfuse", "phoenix", "otel", "agt", "adr-sensor", "openshell"];

const OTEL_CONFIG_HINT =
  "configure otlpExport.endpoint in .kya/config.json or KYA_OTLP_EXPORT_ENDPOINT";

/**
 * Ephemeral 127.0.0.1 HTTP sink that answers 200 to every POST. Lets the
 * zero-config self-tests (notify, otel) exercise the real delivery/export
 * pipeline end to end instead of dead-ending with a config error; the sink
 * closes as soon as the handler finishes.
 */
async function withLoopbackSink<T>(run: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    } else {
      res.writeHead(405).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** Merged global + project .kya/config.json, project wins (same as notify dispatch). */
function mergedFileConfig(cwd: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  return { ...readFileConfig(kyaHome(env)), ...readFileConfig(cwd) } as Record<string, unknown>;
}

const ORR_REPORT_REL = join("orr-report", "report.json");
/** Re-run the board when the report is older than this (30 minutes). */
const ORR_REFRESH_MS = 30 * 60 * 1000;

function orrReportPath(cwd: string): string {
  return join(cwd, ORR_REPORT_REL);
}

/** True when <cwd>/orr-report/report.json is missing or older than ORR_REFRESH_MS. */
function orrReportStale(cwd: string): boolean {
  try {
    const st = statSync(orrReportPath(cwd));
    return Date.now() - st.mtimeMs > ORR_REFRESH_MS;
  } catch {
    return true;
  }
}

/**
 * Run the ORR board against cwd and write <cwd>/orr-report/report.json (+ .md).
 * Read-only probes; never throws (a failed board must not break the report
 * server). The first-party producer set keeps it dependency-free.
 */
export function runOrrBoard(cwd: string): { ok: boolean; detail: string } {
  try {
    const result = runOrr({
      path: cwd,
      out: join(cwd, "orr-report"),
      rubric: "0",
      disableCategories: [],
      formats: ["json", "md"],
      producers: ["sa.first_party"],
      skipOptionalProducers: true,
      quiet: true,
      jsonStdout: false,
    });
    const overall = result.report.overall;
    const disposition = result.report.disposition.replace(/_/g, " ");
    return { ok: true, detail: `overall ${overall} · ${disposition}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** POST /action/orr-run: regenerate the ORR board on demand. */
export async function runReportOrrAction(cwd: string): Promise<ReportActionResult> {
  const ran = runOrrBoard(cwd);
  return {
    status: 200,
    body: ran.ok
      ? { ok: true, detail: `ORR board regenerated: ${ran.detail}` }
      : { ok: false, error: `ORR run failed: ${ran.detail}` },
  };
}

/**
 * POST /action/import: validate the empty-state form body and run one import.
 * `file` must be an absolute path to an existing regular file; agt may omit it
 * and falls back to the default AGT audit log path.
 */
export async function runReportImportAction(
  body: unknown,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ReportActionResult> {
  const raw = (body ?? {}) as Record<string, unknown>;
  const from = (typeof raw["from"] === "string" ? raw["from"].trim().toLowerCase() : "") as ImportSource;
  if (!IMPORT_SOURCES.includes(from)) {
    return {
      status: 400,
      body: { ok: false, error: "invalid source - expected one of langsmith|langfuse|phoenix|otel|agt|adr-sensor|openshell" },
    };
  }
  let file = typeof raw["file"] === "string" ? raw["file"].trim() : "";
  if (!file && from === "agt") file = defaultAgtAuditPath(env);
  if (!file) {
    return { status: 400, body: { ok: false, error: "file path required" } };
  }
  if (!isAbsolute(file)) {
    return { status: 400, body: { ok: false, error: "file must be an absolute path" } };
  }
  try {
    if (!statSync(file).isFile()) {
      return { status: 400, body: { ok: false, error: "not a regular file" } };
    }
  } catch {
    return { status: 400, body: { ok: false, error: `file not found: ${file}` } };
  }
  const result = await importTraces({ from, file, cwd, env });
  return { status: 200, body: { ok: true, imported: result.imported, errors: result.errors } };
}

/** POST /action/investigate: run the detectors and persist investigate-last.json. */
export async function runReportInvestigateAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ReportActionResult> {
  await runInvestigate({ json: false }, { log: () => {} }, cwd, env);
  const summary = loadInvestigateLastRun(env);
  const findings = summary?.findings.reduce((n, f) => n + f.count, 0) ?? 0;
  return { status: 200, body: { ok: true, findings, incidents: summary?.incidents ?? 0 } };
}

/** POST /action/discover: run an endpoint scan and persist latest.json. */
export async function runReportDiscoverAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ReportActionResult> {
  const snapshot = scanEndpoint({ env, cwd });
  writeDiscoverySnapshot(snapshot, env);
  return { status: 200, body: { ok: true, total: snapshot.inventory.length } };
}

/** POST /action/notify-test: fire a synthetic DENY event at the configured webhooks. */
export async function runReportNotifyTestAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ReportActionResult> {
  const config = mergedFileConfig(cwd, env) as NotifyFileConfig;
  const targets = resolveWebhooks(config, env);
  const event: TrailEvent = {
    ts: new Date().toISOString(),
    sessionId: "kya-report-test",
    toolId: "kya.test",
    verdict: "DENY",
    reasonCode: "TEST_ALERT",
    mode: "observe",
    summary: "test alert from the kya report",
  };
  if (targets.length === 0) {
    // Zero-config self-test: deliver through the real sender to an ephemeral
    // loopback sink so the button proves the pipeline instead of dead-ending.
    // The delivery lands in notify-log.jsonl and shows up in the Alerts panel.
    return withLoopbackSink(async (url) => {
      const loopbackConfig: NotifyFileConfig = {
        notify: { webhooks: [{ url, events: ["DENY"], template: "generic" }] },
      };
      await notifyOnTrailEvent(event, loopbackConfig, env);
      return {
        status: 200,
        body: {
          ok: true,
          targets: 1,
          loopback: true,
          detail:
            "test alert delivered to a temporary loopback receiver (delivery recorded in the Alerts panel). Set notify.webhooks in .kya/config.json or KYA_NOTIFY_WEBHOOK to alert a real target.",
        },
      };
    });
  }
  await notifyOnTrailEvent(event, config, env);
  return { status: 200, body: { ok: true, targets: targets.length } };
}

/** POST /action/otel-test: run the OTLP self-test against the configured endpoint. */
export async function runReportOtelTestAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ReportActionResult> {
  const config = resolveOtlpExportConfig(env, mergedFileConfig(cwd, env));
  if (!config) {
    // Zero-config self-test: stand up an ephemeral loopback collector and run
    // the real exporter against it, so the button proves the export path
    // instead of dead-ending with a config error.
    return withLoopbackSink(async (url) => {
      const result = await otlpExportSelfTest({ endpoint: url });
      return {
        status: 200,
        body: {
          ok: result.ok,
          loopback: true,
          detail: result.ok
            ? `span accepted by a temporary loopback collector (${result.detail}). Set otlpExport.endpoint in .kya/config.json or KYA_OTLP_EXPORT_ENDPOINT to export for real.`
            : `${result.detail} - ${OTEL_CONFIG_HINT}`,
        },
      };
    });
  }
  try {
    const result = await otlpExportSelfTest(config);
    return {
      status: 200,
      body: { ok: result.ok, detail: result.detail, ...(result.ok ? {} : { error: result.detail }) },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 200, body: { ok: false, error: `${message} - ${OTEL_CONFIG_HINT}` } };
  }
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
  let orrTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let onSignal: (() => void) | undefined;
  const cache = new EventEmbeddingCache();
  const provider = options.embeddingProvider ?? new LocalMiniLmProvider(process.env);
  let embeddings = new Map<string, number[]>();
  let embeddingRefreshPromise: Promise<void> | undefined;

  const refreshEmbeddings = async (): Promise<void> => {
    const model = loadReceiptModel({ cwd, sessionId: options.sessionId, days: options.days });
    // Embed newest events first so plain-language search returns recent matches
    // while older events continue to warm in the background.
    const events = [...model.events].reverse();
    embeddings = await buildEventEmbeddings(events, provider, cache);
  };

  const ensureEmbeddingsWarming = (): void => {
    // Start embedding generation in the background; do NOT block the current
    // request. Semantic results will appear on the next search once the cache
    // is warm. This keeps plain-language search responsive on first open.
    if (embeddingRefreshPromise) return;
    embeddingRefreshPromise = refreshEmbeddings().finally(() => {
      embeddingRefreshPromise = undefined;
    });
  };

  const embedQuery = async (q: string): Promise<number[] | undefined> => {
    if (!q.trim()) return undefined;
    return provider.embed(q.trim());
  };

  const broadcast = (source: "trail" | "orr" | "action"): void => {
    const payload = `data: ${JSON.stringify({ source })}\n\n`;
    for (const client of [...clients]) {
      try {
        client.write(payload);
      } catch {
        dropClient(clients, client);
      }
    }
  };

  const scheduleBroadcast = (source: "trail" | "orr" | "action"): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => broadcast(source), 120);
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
          url.pathname === "/feed" ||
          url.pathname === "/action/investigate" ||
          url.pathname === "/action/discover" ||
          url.pathname === "/action/import" ||
          url.pathname === "/action/notify-test" ||
          url.pathname === "/action/otel-test" ||
          url.pathname === "/action/orr-run" ||
          url.pathname === "/fragments");
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

      if (req.method === "POST" && url.pathname === "/action/investigate") {
        void (async () => {
          try {
            const result = await runReportInvestigateAction(cwd, process.env);
            if (result.status === 200) scheduleBroadcast("action");
            return jsonOk(res, result.body);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(`${JSON.stringify({ ok: false, error: message })}\n`);
            return;
          }
        })();
        return;
      }

      if (req.method === "POST" && url.pathname === "/action/discover") {
        void (async () => {
          try {
            const result = await runReportDiscoverAction(cwd, process.env);
            if (result.status === 200) scheduleBroadcast("action");
            return jsonOk(res, result.body);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(`${JSON.stringify({ ok: false, error: message })}\n`);
            return;
          }
        })();
        return;
      }

      if (req.method === "POST" && url.pathname === "/action/import") {
        void (async () => {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            return badRequest(res, { ok: false, error: "invalid JSON body" });
          }
          try {
            const result = await runReportImportAction(body, cwd, process.env);
            if (result.status === 200) scheduleBroadcast("action");
            return result.status === 200 ? jsonOk(res, result.body) : badRequest(res, result.body);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(`${JSON.stringify({ ok: false, error: message })}\n`);
            return;
          }
        })();
        return;
      }

      if (req.method === "POST" && url.pathname === "/action/notify-test") {
        void (async () => {
          try {
            const result = await runReportNotifyTestAction(cwd, process.env);
            return jsonOk(res, result.body);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(`${JSON.stringify({ ok: false, error: message })}\n`);
            return;
          }
        })();
        return;
      }

      if (req.method === "POST" && url.pathname === "/action/otel-test") {
        void (async () => {
          try {
            const result = await runReportOtelTestAction(cwd, process.env);
            return jsonOk(res, result.body);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(`${JSON.stringify({ ok: false, error: message })}\n`);
            return;
          }
        })();
        return;
      }

      if (req.method === "POST" && url.pathname === "/action/orr-run") {
        void (async () => {
          try {
            const result = await runReportOrrAction(cwd);
            return jsonOk(res, result.body);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(`${JSON.stringify({ ok: false, error: message })}\n`);
            return;
          }
        })();
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
              ensureEmbeddingsWarming();
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

      if (req.method === "POST" && url.pathname === "/fragments") {
        // Targeted live refresh: the client swaps these containers in place
        // instead of reloading the whole page. Body is unused today; drained
        // so keep-alive sockets are not wedged.
        void (async () => {
          try {
            await readJsonBody(req);
            const model = loadReceiptModel({
              cwd,
              sessionId: options.sessionId,
              days: options.days,
            });
            return jsonOk(res, { ok: true, ...buildLiveFragments(model, true) });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(`${JSON.stringify({ ok: false, error: message })}\n`);
            return;
          }
        })();
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        // Cheap liveness + version handshake for daemon reuse - never renders,
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
      if (orrTimer) clearInterval(orrTimer);
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

      // ORR board: generate at start when missing/stale, then re-run on a
      // 30-minute cadence while the report server lives. Background, never
      // blocking; the SSE broadcast makes the panel pick the result up live.
      const refreshOrr = (): void => {
        if (closed || !orrReportStale(cwd)) return;
        const ran = runOrrBoard(cwd);
        if (ran.ok) scheduleBroadcast("orr");
      };
      setTimeout(refreshOrr, 1_500);
      orrTimer = setInterval(refreshOrr, ORR_REFRESH_MS);
      orrTimer.unref?.();

      try {
        mkdirSync(dirname(path), { recursive: true });
        watcher = watch(dirname(path), { persistent: true }, (_event, filename) => {
          if (!filename || String(filename).endsWith("trail.jsonl")) {
            scheduleBroadcast("trail");
          }
        });
        watcher.on("error", () => {
          /* FS errors - page stays up; next start remounts */
        });
      } catch {
        /* still serve; live reload may be degraded */
      }

      // Embeddings are warmed lazily on the first search (see ensureEmbeddingsWarming
      // in POST /feed). Eager startup warming competes with query embeddings and can
      // make the first plain-language search feel hung on large trails.

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
