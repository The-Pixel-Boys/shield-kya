/**
 * Local OTLP/HTTP traces receiver. The gateway exports spans to
 * `http://127.0.0.1:<otlpPort>/v1/traces`; each `tools/call` span becomes one
 * TrailEvent on the global trail (mode "observe") so the report's MCP server
 * facet lights up for gate traffic.
 *
 * Privacy: only whitelisted span attributes are read (method, target, tool
 * name, session id). Tool arguments are never extracted, and the persisted
 * fields pass through the secret scanner before hitting the trail.
 *
 * Known limitation: the receiver is unauthenticated — any local process can
 * POST spans and inject trail events. That is the same trust boundary as the
 * user-writable trail file itself (any local process can append to
 * ~/.kya/trail.jsonl), so no new privilege is granted; remote injection is
 * impossible because the receiver binds 127.0.0.1 only.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendTrail, type TrailEvent } from "../trail.js";
import { assertNoSecrets } from "../dash/render.js";
import {
  decodeTraceJson,
  decodeTraceProtobuf,
  type DecodedSpan,
} from "./otlp-decode.js";

const STATUS_ERROR = 2;

/** Twin-collapse window: how long a sessioned call suppresses its client-span twin. */
const TWIN_TTL_MS = 30_000;

// Verified against the real gateway (v1.5.0): a CEL-filtered tool call is
// refused as `-32602 Unknown tool` over HTTP 400; the span carries ERROR
// status and an "Unknown tool" error message. Downstream API denials (a
// tool's own 403/"forbidden" result) are NOT policy denials and must not
// match this signal — they classify as TOOL_ERROR.
const DENIAL_SIGNAL = /\bunknown tool\b/i;

export interface SpanMapContext {
  /** Per-gate-run fallback when the span carries no mcp.session.id. */
  readonly fallbackSessionId: string;
  /** Project label for the trail event (cwd basename resolved by caller). */
  readonly cwd: string;
}

function attr(span: DecodedSpan, key: string): string | undefined {
  const v = span.attributes[key];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Map one decoded span to a TrailEvent, or undefined when the span is not an
 * MCP tools/call. toolId is `<target>__<tool>` so the registry's MCP facet
 * recognizes calls to known servers.
 */
export function spanToTrailEvent(span: DecodedSpan, ctx: SpanMapContext): TrailEvent | undefined {
  if (attr(span, "mcp.method.name") !== "tools/call") return undefined;
  const tool = attr(span, "gen_ai.tool.name");
  if (!tool) return undefined;
  const target = attr(span, "mcp.target") ?? "unknown";
  const sessionId = attr(span, "mcp.session.id") || ctx.fallbackSessionId;

  let verdict = "ALLOW";
  let reasonCode = "ALLOW";
  if (span.statusCode === STATUS_ERROR) {
    if (DENIAL_SIGNAL.test(span.statusMessage ?? "")) {
      verdict = "DENY";
      reasonCode = "POLICY_DENY";
    } else {
      // The gate allowed the call; the tool itself failed.
      reasonCode = "TOOL_ERROR";
    }
  }

  const toolId = `${target}__${tool}`;
  // Defense-in-depth: nothing we persist may smuggle a secret out of a span.
  assertNoSecrets(`${toolId}\n${sessionId}`);
  return {
    ts: new Date().toISOString(),
    sessionId,
    toolId,
    verdict,
    reasonCode,
    mode: "observe",
    summary: `gate: ${target}.${tool}`,
  };
}

export interface OtlpReceiver {
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface OtlpReceiverOptions {
  /** 0 = ephemeral (tests); the resolved port is on the handle. */
  readonly port: number;
  readonly cwd: string;
  readonly fallbackSessionId: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable sink (tests); defaults to appendTrail. */
  readonly append?: (cwd: string, event: TrailEvent, env: NodeJS.ProcessEnv) => void;
}

function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Accept OTLP trace exports on 127.0.0.1 and append tools/call spans to the
 * trail. Malformed payloads get a 400 and are dropped — the receiver never
 * dies on bad input (the gateway keeps exporting).
 */
export async function startOtlpReceiver(opts: OtlpReceiverOptions): Promise<OtlpReceiver> {
  const env = opts.env ?? process.env;
  const append = opts.append ?? appendTrail;
  const ctx: SpanMapContext = { fallbackSessionId: opts.fallbackSessionId, cwd: opts.cwd };
  const seenSpanIds = new Set<string>();
  /** traceId|target__tool → expiry: sessioned calls, for cross-batch twin collapse. */
  const sessionedCalls = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/traces") {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
        return;
      }
      let spans: DecodedSpan[];
      try {
        const body = await readBody(req);
        const contentType = (req.headers["content-type"] ?? "").toLowerCase();
        spans = contentType.includes("json")
          ? decodeTraceJson(JSON.parse(body.toString("utf8")))
          : decodeTraceProtobuf(body);
      } catch {
        res.writeHead(400, { "content-type": "text/plain" }).end("bad otlp payload\n");
        return;
      }
      // The gateway emits a client span per target call next to the server
      // span for the same tools/call; only the server span carries
      // mcp.session.id. Twins share a trace_id: collapse the sessionless one
      // via a short-TTL cache so a pair split across export batches (or
      // re-exported) still trails exactly once.
      const now = Date.now();
      for (const [k, exp] of sessionedCalls) {
        if (exp <= now) sessionedCalls.delete(k);
      }
      const twinKey = (s: DecodedSpan): string =>
        `${s.traceId ?? ""}|${String(s.attributes["mcp.target"] ?? "unknown")}__${String(s.attributes["gen_ai.tool.name"] ?? "")}`;
      const batchTwins = new Set(
        spans
          .filter(
            (s) =>
              s.attributes["mcp.method.name"] === "tools/call" &&
              typeof s.attributes["mcp.session.id"] === "string",
          )
          .map(twinKey),
      );
      for (const span of spans) {
        const isCall = span.attributes["mcp.method.name"] === "tools/call";
        const hasSession = typeof span.attributes["mcp.session.id"] === "string";
        if (isCall && hasSession) {
          sessionedCalls.set(twinKey(span), now + TWIN_TTL_MS);
        }
        if (
          isCall &&
          !hasSession &&
          (batchTwins.has(twinKey(span)) ||
            (sessionedCalls.get(twinKey(span)) ?? 0) > now)
        ) {
          continue;
        }
        if (span.spanId) {
          if (seenSpanIds.has(span.spanId)) continue;
          seenSpanIds.add(span.spanId);
          if (seenSpanIds.size > 100_000) seenSpanIds.clear();
        }
        try {
          const event = spanToTrailEvent(span, ctx);
          if (event) append(opts.cwd, event, env);
        } catch {
          // Secret-scanner trip or append failure: drop the event, keep serving.
        }
      }
      // OTLP/HTTP success: partialSuccess-free empty response.
      res.writeHead(200, { "content-type": "application/x-protobuf" }).end(Buffer.alloc(0));
    })().catch(() => {
      try {
        res.writeHead(500).end();
      } catch {
        /* already closed */
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
