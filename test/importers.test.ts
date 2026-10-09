import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkImportSize,
  importTraces,
  MAX_IMPORT_BYTES,
  renderImportSummary,
  type ImportResult,
} from "../src/importers/index.js";
import { globalTrailPath, readTrail } from "../src/trail.js";

describe("trace importers", () => {
  let home: string;
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let file: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kya-import-home-"));
    cwd = mkdtempSync(join(tmpdir(), "kya-import-proj-"));
    env = { KYA_HOME: home };
    file = join(cwd, "export.json");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("langsmith JSON array: counts, verdicts, latency, tokens, session", async () => {
    writeFileSync(
      file,
      JSON.stringify([
        {
          name: "search_docs",
          run_type: "tool",
          inputs: { query: "returns", limit: 5 },
          outputs: { hits: 3 },
          start_time: "2026-09-15T10:00:00.000Z",
          end_time: "2026-09-15T10:00:01.250Z",
          session_name: "ls-session-1",
          prompt_tokens: 120,
          completion_tokens: 40,
        },
        {
          name: "apply_patch",
          run_type: "tool",
          inputs: { path: "a.ts" },
          start_time: "2026-09-15T10:01:00.000Z",
          end_time: "2026-09-15T10:01:00.500Z",
          session_name: "ls-session-1",
          error: "patch conflict",
        },
      ]),
      "utf8",
    );
    const result = await importTraces({ from: "langsmith", file, cwd, env });
    expect(result).toMatchObject({ imported: 2, skipped: 0, errors: [] });

    const events = readTrail(cwd, env);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      ts: "2026-09-15T10:00:00.000Z",
      sessionId: "ls-session-1",
      host: "import",
      toolId: "search_docs",
      verdict: "ALLOW",
      reasonCode: "IMPORTED",
      mode: "observe",
      latencyMs: 1250,
      tokensIn: 120,
      tokensOut: 40,
    });
    expect(events[0]!.packId).toBeUndefined();
    expect(events[0]!.summary).toBe("inputs: query, limit");
    expect(events[1]).toMatchObject({
      toolId: "apply_patch",
      verdict: "DENY",
      reasonCode: "IMPORTED_ERROR",
      latencyMs: 500,
    });
    expect(events[1]!.tokensIn).toBeUndefined();
  });

  it("langsmith: bad records are skipped with errors, good ones still import", async () => {
    writeFileSync(
      file,
      JSON.stringify({
        runs: [
          { name: "ok_tool", start_time: "2026-09-15T10:00:00.000Z" },
          { run_type: "tool", start_time: "2026-09-15T10:00:01.000Z" },
          "not-an-object",
        ],
      }),
      "utf8",
    );
    const result = await importTraces({ from: "langsmith", file, cwd, env });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("missing name");
    const [event] = readTrail(cwd, env);
    expect(event!.toolId).toBe("ok_tool");
    // No session_name in the export - fallback import-<source>-<date>.
    expect(event!.sessionId).toMatch(/^import-langsmith-\d{4}-\d{2}-\d{2}$/);
  });

  it("langsmith summary renders input keys only and redacts secrets", async () => {
    writeFileSync(
      file,
      JSON.stringify([
        {
          name: "call_api",
          inputs: { prompt: "hello", "api_key=sk_live_123": "ignored" },
          start_time: "2026-09-15T10:00:00.000Z",
          error: "upstream said api_key=sk_live_999",
        },
      ]),
      "utf8",
    );
    const result = await importTraces({ from: "langsmith", file, cwd, env });
    expect(result.imported).toBe(1);
    const raw = readFileSync(globalTrailPath(env), "utf8");
    expect(raw).not.toContain("sk_live_123");
    expect(raw).not.toContain("sk_live_999");
    expect(raw).not.toContain("hello"); // input values never copied
    const [event] = readTrail(cwd, env);
    expect(event!.summary).toBe("inputs: prompt, api_key=[redacted]");
  });

  it("langfuse JSONL: level ERROR denies, both usage shapes map to tokens", async () => {
    const lines = [
      JSON.stringify({
        type: "GENERATION",
        name: "llm_call",
        startTime: "2026-09-15T10:00:00.000Z",
        endTime: "2026-09-15T10:00:02.000Z",
        usage: { input: 200, output: 80 },
        level: "DEFAULT",
        sessionId: "lf-sess",
      }),
      "{ this is not json",
      JSON.stringify({
        type: "SPAN",
        name: "tool_run",
        startTime: "2026-09-15T10:01:00.000Z",
        endTime: "2026-09-15T10:01:00.100Z",
        usage: { promptTokens: 10, completionTokens: 4 },
        level: "ERROR",
        statusMessage: "tool blew up",
        traceId: "lf-trace-9",
      }),
    ].join("\n");
    writeFileSync(file, lines, "utf8");

    const result = await importTraces({ from: "langfuse", file, cwd, env });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toContain("line 2");

    const events = readTrail(cwd, env);
    expect(events[0]).toMatchObject({
      toolId: "llm_call",
      verdict: "ALLOW",
      reasonCode: "IMPORTED",
      sessionId: "lf-sess",
      latencyMs: 2000,
      tokensIn: 200,
      tokensOut: 80,
    });
    expect(events[1]).toMatchObject({
      toolId: "tool_run",
      verdict: "DENY",
      reasonCode: "IMPORTED_ERROR",
      sessionId: "lf-trace-9",
      latencyMs: 100,
      tokensIn: 10,
      tokensOut: 4,
    });
  });

  it("phoenix: tool.name attribute wins, statusCode ERROR denies, context trace id is the session", async () => {
    writeFileSync(
      file,
      JSON.stringify({
        spans: [
          {
            name: "chain.step",
            startTime: "2026-09-15T10:00:00.000Z",
            endTime: "2026-09-15T10:00:00.750Z",
            statusCode: "OK",
            context: { trace_id: "phx-trace-1", span_id: "s1" },
            attributes: {
              "tool.name": "real_tool",
              "input.value": "raw input with api_key=sk_live_777",
              "llm.token_count.prompt": 33,
              "llm.token_count.completion": 11,
            },
          },
          {
            name: "failing_tool",
            startTime: "2026-09-15T10:02:00.000Z",
            endTime: "2026-09-15T10:02:01.000Z",
            statusCode: "ERROR",
            context: { trace_id: "phx-trace-1", span_id: "s2" },
            attributes: {},
          },
        ],
      }),
      "utf8",
    );
    const result = await importTraces({ from: "phoenix", file, cwd, env });
    expect(result).toMatchObject({ imported: 2, skipped: 0, errors: [] });

    const events = readTrail(cwd, env);
    expect(events[0]).toMatchObject({
      toolId: "real_tool",
      verdict: "ALLOW",
      sessionId: "phx-trace-1",
      latencyMs: 750,
      tokensIn: 33,
      tokensOut: 11,
    });
    expect(events[1]).toMatchObject({
      toolId: "failing_tool",
      verdict: "DENY",
      reasonCode: "IMPORTED_ERROR",
      latencyMs: 1000,
    });
    // Raw input.value (with the secret) never reaches the trail.
    const raw = readFileSync(globalTrailPath(env), "utf8");
    expect(raw).not.toContain("sk_live_777");
    expect(raw).not.toContain("raw input");
  });

  it("otel: resourceSpans nesting, status code 2 denies, nano times map to ts/latency", async () => {
    const startMs = Date.parse("2026-09-15T10:00:00.000Z");
    const nano = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
    writeFileSync(
      file,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "otel-trace-1",
                    spanId: "a",
                    name: "tool.search",
                    startTimeUnixNano: nano(startMs),
                    endTimeUnixNano: nano(startMs + 250),
                    status: { code: 1 },
                    attributes: [
                      { key: "llm.token_count.prompt", value: { intValue: "55" } },
                      { key: "llm.token_count.completion", value: { intValue: 12 } },
                    ],
                  },
                  {
                    traceId: "otel-trace-1",
                    spanId: "b",
                    name: "tool.exec",
                    startTimeUnixNano: nano(startMs + 1000),
                    endTimeUnixNano: nano(startMs + 1500),
                    status: { code: 2, message: "boom" },
                  },
                ],
              },
            ],
          },
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "otel-trace-2",
                    name: "tool.other",
                    startTimeUnixNano: nano(startMs + 2000),
                    status: { code: "STATUS_CODE_ERROR" },
                  },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const result = await importTraces({ from: "otel", file, cwd, env });
    expect(result).toMatchObject({ imported: 3, skipped: 0, errors: [] });

    const events = readTrail(cwd, env);
    expect(events[0]).toMatchObject({
      ts: "2026-09-15T10:00:00.000Z",
      toolId: "tool.search",
      verdict: "ALLOW",
      reasonCode: "IMPORTED",
      sessionId: "otel-trace-1",
      latencyMs: 250,
      tokensIn: 55,
      tokensOut: 12,
    });
    expect(events[1]).toMatchObject({
      toolId: "tool.exec",
      verdict: "DENY",
      reasonCode: "IMPORTED_ERROR",
      latencyMs: 500,
    });
    expect(events[2]).toMatchObject({
      toolId: "tool.other",
      verdict: "DENY",
      sessionId: "otel-trace-2",
    });
    expect(events[2]!.latencyMs).toBeUndefined();
  });

  it("otel spans missing a name are skipped without aborting the file", async () => {
    writeFileSync(
      file,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  { traceId: "t", startTimeUnixNano: "1000000" },
                  { traceId: "t", name: "ok", startTimeUnixNano: "2000000" },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    const result = await importTraces({ from: "otel", file, cwd, env });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toContain("missing name");
  });

  it("50MB guard: checkImportSize flags only files over the cap", () => {
    expect(checkImportSize(0)).toBeUndefined();
    expect(checkImportSize(MAX_IMPORT_BYTES)).toBeUndefined();
    const msg = checkImportSize(MAX_IMPORT_BYTES + 1);
    expect(msg).toContain("50MB");
    expect(msg).toContain(String(MAX_IMPORT_BYTES + 1));
  });

  it("a missing file returns an error entry instead of throwing", async () => {
    const result = await importTraces({
      from: "langsmith",
      file: join(cwd, "nope.json"),
      cwd,
      env,
    });
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("cannot read");
  });

  it("an empty file imports nothing and reports no error", async () => {
    writeFileSync(file, "", "utf8");
    const result = await importTraces({ from: "phoenix", file, cwd, env });
    expect(result).toMatchObject({ imported: 0, skipped: 0, errors: [] });
  });

  it("renderImportSummary: two lines clean, three with errors", () => {
    const clean: ImportResult = { imported: 5, skipped: 0, errors: [] };
    expect(renderImportSummary(clean).split("\n")).toEqual([
      "imported 5 trace record(s) into the KYA trail",
      "skipped 0 record(s)",
    ]);
    const dirty: ImportResult = { imported: 1, skipped: 2, errors: ["record 2: missing name"] };
    const lines = renderImportSummary(dirty).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("errors: 1 (first: record 2: missing name)");
  });
});
