import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTraceJson, decodeTraceProtobuf, type DecodedSpan } from "../src/gate/otlp-decode.js";
import { spanToTrailEvent, startOtlpReceiver } from "../src/gate/otlp-receiver.js";
import type { TrailEvent } from "../src/trail.js";

// --- minimal OTLP protobuf encoder (test-side mirror of the decoder) ---

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function field(fieldNo: number, wire: number): number[] {
  return varint((fieldNo << 3) | wire);
}

function lenField(fieldNo: number, payload: number[]): number[] {
  return [...field(fieldNo, 2), ...varint(payload.length), ...payload];
}

function str(s: string): number[] {
  return [...Buffer.from(s, "utf8")];
}

function anyValueString(s: string): number[] {
  return lenField(1, str(s)); // AnyValue.string_value
}

function keyValue(key: string, value: string): number[] {
  return [...lenField(1, str(key)), ...lenField(2, anyValueString(value))];
}

interface FixtureSpan {
  traceIdHex?: string;
  spanIdHex?: string;
  name: string;
  attrs: Record<string, string>;
  statusCode?: number;
  statusMessage?: string;
}

function encodeSpan(s: FixtureSpan): number[] {
  const out: number[] = [];
  if (s.traceIdHex) out.push(...lenField(1, [...Buffer.from(s.traceIdHex, "hex")]));
  if (s.spanIdHex) out.push(...lenField(2, [...Buffer.from(s.spanIdHex, "hex")]));
  out.push(...lenField(5, str(s.name)));
  for (const [k, v] of Object.entries(s.attrs)) {
    out.push(...lenField(9, keyValue(k, v)));
  }
  if (s.statusCode !== undefined || s.statusMessage !== undefined) {
    const status: number[] = [];
    if (s.statusMessage !== undefined) status.push(...lenField(2, str(s.statusMessage)));
    if (s.statusCode !== undefined) status.push(...field(3, 0), ...varint(s.statusCode));
    out.push(...lenField(15, status));
  }
  return out;
}

function encodeTraceRequest(spans: FixtureSpan[]): Buffer {
  const scopeSpans = spans.flatMap((s) => lenField(2, encodeSpan(s)));
  const resourceSpans = lenField(2, scopeSpans);
  return Buffer.from(lenField(1, resourceSpans));
}

const CALL_ATTRS = {
  "mcp.method.name": "tools/call",
  "mcp.target": "github",
  "gen_ai.tool.name": "get_issue",
  "mcp.session.id": "sess-123",
};

const CTX = { fallbackSessionId: "gate-fallback", cwd: "/tmp/x" };

// --- span → trail mapping ---

describe("spanToTrailEvent", () => {
  const span = (over: Partial<DecodedSpan>): DecodedSpan => ({
    name: "call_tool",
    attributes: { ...CALL_ATTRS },
    statusCode: 1,
    ...over,
  });

  it("success → ALLOW with <serverId>__<tool> id and session from the span", () => {
    const e = spanToTrailEvent(span({}), CTX);
    expect(e).toMatchObject({
      sessionId: "sess-123",
      toolId: "github__get_issue",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
    });
  });

  it("policy denial (ERROR + 'Unknown tool', as the gateway reports it) → DENY / POLICY_DENY", () => {
    const e = spanToTrailEvent(
      span({ statusCode: 2, statusMessage: "mcp: Unknown tool: drop_database" }),
      CTX,
    );
    expect(e).toMatchObject({ verdict: "DENY", reasonCode: "POLICY_DENY" });
  });

  it("downstream API denials classify as TOOL_ERROR, never POLICY_DENY", () => {
    for (const msg of [
      "HTTP 403 Forbidden from upstream API",
      "upstream returned 401 unauthorized",
      "tool failed: authorization header rejected",
      "access denied by remote server",
    ]) {
      const e = spanToTrailEvent(span({ statusCode: 2, statusMessage: msg }), CTX);
      expect(e, msg).toMatchObject({ verdict: "ALLOW", reasonCode: "TOOL_ERROR" });
    }
  });

  it("tool failure (ERROR, no denial wording) stays ALLOW / TOOL_ERROR", () => {
    const e = spanToTrailEvent(span({ statusCode: 2, statusMessage: "upstream 500" }), CTX);
    expect(e).toMatchObject({ verdict: "ALLOW", reasonCode: "TOOL_ERROR" });
  });

  it("unknown target still records with its target prefix", () => {
    const e = spanToTrailEvent(
      span({ attributes: { ...CALL_ATTRS, "mcp.target": "homegrown" } }),
      CTX,
    );
    expect(e?.toolId).toBe("homegrown__get_issue");
  });

  it("missing session id falls back to the per-gate-run id", () => {
    const attrs = { ...CALL_ATTRS } as Record<string, string>;
    delete attrs["mcp.session.id"];
    const e = spanToTrailEvent(span({ attributes: attrs }), CTX);
    expect(e?.sessionId).toBe("gate-fallback");
  });

  it("non-tools/call spans and tool-less spans are skipped", () => {
    expect(
      spanToTrailEvent(span({ attributes: { ...CALL_ATTRS, "mcp.method.name": "tools/list" } }), CTX),
    ).toBeUndefined();
    const attrs = { ...CALL_ATTRS } as Record<string, string>;
    delete attrs["gen_ai.tool.name"];
    expect(spanToTrailEvent(span({ attributes: attrs }), CTX)).toBeUndefined();
  });
});

// --- decoders ---

describe("decodeTraceProtobuf", () => {
  it("decodes a tools/call span with status and attributes", () => {
    const body = encodeTraceRequest([
      {
        spanIdHex: "f7f30629c29d9089",
        name: "call_tool",
        attrs: CALL_ATTRS,
        statusCode: 1,
      },
    ]);
    const spans = decodeTraceProtobuf(body);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      spanId: "f7f30629c29d9089",
      name: "call_tool",
      statusCode: 1,
    });
    expect(spans[0]!.attributes).toMatchObject(CALL_ATTRS);
  });

  it("decodes an error status message", () => {
    const body = encodeTraceRequest([
      { name: "call_tool", attrs: CALL_ATTRS, statusCode: 2, statusMessage: "denied by policy" },
    ]);
    const spans = decodeTraceProtobuf(body);
    expect(spans[0]!.statusMessage).toBe("denied by policy");
  });

  it("rejects truncated garbage without hanging", () => {
    expect(() => decodeTraceProtobuf(Buffer.from([0xff, 0xff, 0xff]))).toThrow();
  });
});

describe("decodeTraceJson", () => {
  it("normalizes OTLP/JSON including string status codes", () => {
    const spans = decodeTraceJson({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  spanId: "abc",
                  name: "call_tool",
                  attributes: Object.entries(CALL_ATTRS).map(([key, v]) => ({
                    key,
                    value: { stringValue: v },
                  })),
                  status: { code: "STATUS_CODE_ERROR", message: "denied" },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(spans[0]).toMatchObject({ name: "call_tool", statusCode: 2, statusMessage: "denied" });
  });
});

// --- receiver round-trip ---

describe("startOtlpReceiver", () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), "kya-gate-otlp-"));
  }

  it("appends tools/call spans from protobuf POSTs to the trail sink, deduped by span id", async () => {
    const cwd = tmp();
    try {
      const events: TrailEvent[] = [];
      const rx = await startOtlpReceiver({
        port: 0,
        cwd,
        fallbackSessionId: "gate-test",
        append: (_cwd, e) => {
          events.push(e);
        },
      });
      try {
        const span: FixtureSpan = {
          spanIdHex: "aaaaaaaaaaaaaaaa",
          name: "call_tool",
          attrs: CALL_ATTRS,
          statusCode: 1,
        };
        const body = encodeTraceRequest([span]);
        for (let i = 0; i < 2; i++) {
          const res = await fetch(`${rx.url}/v1/traces`, {
            method: "POST",
            headers: { "content-type": "application/x-protobuf" },
            body,
          });
          expect(res.status).toBe(200);
        }
        expect(events).toHaveLength(1); // second export of the same span id is deduped
        expect(events[0]).toMatchObject({ toolId: "github__get_issue", verdict: "ALLOW" });
      } finally {
        await rx.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("collapses the gateway's server+client span pair for one tools/call into a single event", async () => {
    const cwd = tmp();
    try {
      const events: TrailEvent[] = [];
      const rx = await startOtlpReceiver({
        port: 0,
        cwd,
        fallbackSessionId: "gate-test",
        append: (_cwd, e) => {
          events.push(e);
        },
      });
      try {
        // Mirrors a real v1.5.0 export batch: a server span with the session
        // id, then the per-target client span without it (same trace id).
        const body = encodeTraceRequest([
          {
            traceIdHex: "cbfe7b61a521cb1a3bbabac4638b3fb8",
            spanIdHex: "1111111111111111",
            name: "tools/call",
            attrs: CALL_ATTRS,
            statusCode: 1,
          },
          {
            traceIdHex: "cbfe7b61a521cb1a3bbabac4638b3fb8",
            spanIdHex: "2222222222222222",
            name: "tools/call github_get_issue",
            attrs: {
              "mcp.method.name": "tools/call",
              "mcp.target": "github",
              "gen_ai.tool.name": "get_issue",
            },
            statusCode: 0,
          },
        ]);
        const res = await fetch(`${rx.url}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf" },
          body,
        });
        expect(res.status).toBe(200);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ toolId: "github__get_issue", sessionId: "sess-123" });
      } finally {
        await rx.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("collapses twins split across export batches via the trace-id TTL cache", async () => {
    const cwd = tmp();
    try {
      const events: TrailEvent[] = [];
      const rx = await startOtlpReceiver({
        port: 0,
        cwd,
        fallbackSessionId: "gate-test",
        append: (_cwd, e) => {
          events.push(e);
        },
      });
      try {
        const serverSpan: FixtureSpan = {
          traceIdHex: "aaaa7b61a521cb1a3bbabac4638b3fb8",
          spanIdHex: "3333333333333333",
          name: "tools/call",
          attrs: CALL_ATTRS,
          statusCode: 1,
        };
        const clientTwin: FixtureSpan = {
          traceIdHex: "aaaa7b61a521cb1a3bbabac4638b3fb8",
          spanIdHex: "4444444444444444",
          name: "tools/call github_get_issue",
          attrs: {
            "mcp.method.name": "tools/call",
            "mcp.target": "github",
            "gen_ai.tool.name": "get_issue",
          },
          statusCode: 0,
        };
        // Batch 1: only the server span. Batch 2: only the client twin.
        for (const span of [serverSpan, clientTwin]) {
          const res = await fetch(`${rx.url}/v1/traces`, {
            method: "POST",
            headers: { "content-type": "application/x-protobuf" },
            body: encodeTraceRequest([span]),
          });
          expect(res.status).toBe(200);
        }
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ toolId: "github__get_issue", sessionId: "sess-123" });
      } finally {
        await rx.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("answers 400 on garbage and keeps serving", async () => {
    const cwd = tmp();
    try {
      const rx = await startOtlpReceiver({
        port: 0,
        cwd,
        fallbackSessionId: "gate-test",
        append: () => {},
      });
      try {
        const bad = await fetch(`${rx.url}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf" },
          body: Buffer.from([0xff, 0xff]),
        });
        expect(bad.status).toBe(400);
        const missing = await fetch(`${rx.url}/nope`, { method: "POST" });
        expect(missing.status).toBe(404);
        const good = await fetch(`${rx.url}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resourceSpans: [] }),
        });
        expect(good.status).toBe(200);
      } finally {
        await rx.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
