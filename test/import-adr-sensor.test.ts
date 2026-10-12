/**
 * kya import --from adr-sensor: mapping, JSON/JSONL parsing, idempotence, bad files,
 * size guard, and CLI wiring (importers/adr-sensor.ts, commands/import-traces.ts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importOptionsFromArgs, runImport } from "../src/commands/import-traces.js";
import { importTraces, renderImportSummary } from "../src/importers/index.js";
import { parseArgs } from "../src/parse-args.js";
import { globalTrailPath, readTrail } from "../src/trail.js";

interface ToolCall {
  tool_name: string;
  tool_type?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  status?: string;
  error?: string;
}

interface ChatMessage {
  role: string;
  content: string;
  tools?: ToolCall[];
  tool_calls?: ToolCall[];
}

interface AgentEvent {
  uuid?: string;
  timestamp: string;
  source?: string;
  session_id?: string;
  chat_history?: ChatMessage[];
  token_usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: string;
  status?: string;
  [key: string]: unknown;
}

function event(
  over: Partial<AgentEvent> & { timestamp: string; session_id?: string },
  tools?: ToolCall[],
): AgentEvent {
  return {
    uuid: "uuid-" + Math.random().toString(36).slice(2),
    source: "claude",
    session_id: "adr-sess-1",
    chat_history: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok", tools },
    ],
    ...over,
  };
}

function makeUuid(e: AgentEvent): string {
  return e.uuid ?? "missing";
}

describe("kya import --from adr-sensor", () => {
  let home: string;
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let file: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kya-adr-home-"));
    cwd = mkdtempSync(join(tmpdir(), "kya-adr-proj-"));
    env = { KYA_HOME: home };
    file = join(cwd, "adr-events.jsonl");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const write = (v: unknown) => writeFileSync(file, JSON.stringify(v), "utf8");
  const writeLines = (lines: unknown[]) => writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  const run = () => importTraces({ from: "adr-sensor", file, cwd, env });

  it("maps each tool call to a TrailEvent with provenance and redacted input-key summary", async () => {
    const e = event(
      { timestamp: "2026-10-10T07:00:00.000Z" },
      [
        { tool_name: "Read", arguments: { path: "/etc/passwd" } },
        { tool_name: "Bash", arguments: { command: "rm -rf /", api_key: "sk_live_123" } },
      ],
    );
    write([e]);
    const result = await run();
    expect(result).toMatchObject({ imported: 2, skipped: 0, errors: [], duplicates: 0 });

    const events = readTrail(cwd, env);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      ts: "2026-10-10T07:00:00.000Z",
      sessionId: "adr-sess-1",
      host: "import",
      toolId: "Read",
      verdict: "ALLOW",
      reasonCode: "IMPORTED",
      mode: "observe",
      importFormat: "adr-sensor",
      importedFrom: "adr-sensor",
      sourceHash: makeUuid(e),
    });
    expect(events[1]).toMatchObject({
      toolId: "Bash",
      verdict: "ALLOW",
      reasonCode: "IMPORTED",
    });
    expect(events[0]!.summary).toBe("input: path");
    expect(events[1]!.summary).toBe("input: command, api_key");
    for (const ev of events) {
      expect(ev.argsHash).toBeUndefined();
      expect(ev.diffPreview).toBeUndefined();
      expect(ev.targetPath).toBeUndefined();
      expect(ev.packId).toBeUndefined();
    }
  });

  it("reads token_usage and maps prompt/completion tokens", async () => {
    const e = event(
      { timestamp: "2026-10-10T07:00:00.000Z", token_usage: { prompt_tokens: 100, completion_tokens: 40 } },
      [{ tool_name: "Edit", arguments: { path: "a.ts" } }],
    );
    write([e]);
    await run();
    const [ev] = readTrail(cwd, env);
    expect(ev).toMatchObject({ tokensIn: 100, tokensOut: 40 });
  });

  it("DENYs when the event, message, or tool result signals an error", async () => {
    const ok = event({ timestamp: "2026-10-10T07:00:00.000Z" }, [{ tool_name: "Read" }]);
    const topLevelError = event(
      { timestamp: "2026-10-10T07:00:01.000Z", error: "upstream failure" },
      [{ tool_name: "Read" }],
    );
    const toolError = event(
      { timestamp: "2026-10-10T07:00:02.000Z" },
      [{ tool_name: "Bash", status: "error", error: "exit 1" }],
    );
    write([ok, topLevelError, toolError]);
    await run();
    const events = readTrail(cwd, env);
    expect(events.map((e) => [e.toolId, e.verdict, e.reasonCode])).toEqual([
      ["Read", "ALLOW", "IMPORTED"],
      ["Read", "DENY", "IMPORTED_ERROR"],
      ["Bash", "DENY", "IMPORTED_ERROR"],
    ]);
  });

  it("emits a session event when there are no tool calls", async () => {
    const e = event({ timestamp: "2026-10-10T07:00:00.000Z", chat_history: [{ role: "user", content: "hi" }] });
    write([e]);
    const result = await run();
    expect(result).toMatchObject({ imported: 1, skipped: 0 });
    const [ev] = readTrail(cwd, env);
    expect(ev).toMatchObject({
      toolId: "adr-sensor:session",
      verdict: "ALLOW",
      reasonCode: "IMPORTED",
      importedFrom: "adr-sensor",
    });
  });

  it("accepts JSONL, whole-file JSON array, and single JSON object", async () => {
    const a = event({ timestamp: "2026-10-10T07:00:00.000Z" }, [{ tool_name: "A" }]);
    const b = event({ timestamp: "2026-10-10T07:00:01.000Z" }, [{ tool_name: "B" }]);

    writeLines([a, b]);
    expect((await run()).imported).toBe(2);
    expect(readTrail(cwd, env)).toHaveLength(2);

    rmSync(globalTrailPath(env), { force: true });
    write([a, b]);
    expect((await run()).imported).toBe(2);
    expect(readTrail(cwd, env)).toHaveLength(2);

    rmSync(globalTrailPath(env), { force: true });
    write(a);
    expect((await run()).imported).toBe(1);
    expect(readTrail(cwd, env)).toHaveLength(1);
  });

  it("skips bad JSONL lines and malformed records without aborting the file", async () => {
    const ok = event({ timestamp: "2026-10-10T07:00:00.000Z" }, [{ tool_name: "Ok" }]);
    const sessionOnly = event({ timestamp: "2026-10-10T07:00:01.000Z", session_id: undefined }); // fallback session, no tools
    writeFileSync(
      file,
      [
        JSON.stringify(ok),
        "{ this is not json",
        JSON.stringify({ notAnEvent: true }),
        JSON.stringify({ uuid: "x", timestamp: "not a date" }),
        JSON.stringify(sessionOnly),
      ].join("\n"),
      "utf8",
    );
    const result = await run();
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(3);
    expect(result.errors.some((m) => m.includes("line 2"))).toBe(true);
    expect(result.errors.some((m) => m.includes("missing uuid"))).toBe(true);
    expect(result.errors.some((m) => m.includes("missing or invalid timestamp"))).toBe(true);
    const events = readTrail(cwd, env);
    expect(events.filter((e) => e.toolId === "Ok")).toHaveLength(1);
    expect(events.filter((e) => e.sessionId.startsWith("import-adr-sensor-"))).toHaveLength(1);
  });

  it("is idempotent: a second import adds no rows and reports duplicates", async () => {
    const e = event({ timestamp: "2026-10-10T07:00:00.000Z" }, [{ tool_name: "Read" }, { tool_name: "Bash" }]);
    write([e]);
    await run();
    const again = await run();
    expect(again).toMatchObject({ imported: 0, skipped: 2, errors: [], duplicates: 2 });
    expect(readTrail(cwd, env)).toHaveLength(2);
    expect(renderImportSummary(again)).toContain("already imported: 2 record(s)");
  });

  it("a grown export only adds the new events", async () => {
    const a = event({ timestamp: "2026-10-10T07:00:00.000Z" }, [{ tool_name: "A" }]);
    const b = event({ timestamp: "2026-10-10T07:00:01.000Z" }, [{ tool_name: "B" }]);
    write([a]);
    await run();
    write([a, b]);
    const result = await run();
    expect(result).toMatchObject({ imported: 1, duplicates: 1 });
    expect(readTrail(cwd, env)).toHaveLength(2);
  });

  it("falls back to import-adr-sensor-<date> when session_id is missing", async () => {
    const e = event({ timestamp: "2026-10-10T07:00:00.000Z", session_id: undefined }, [{ tool_name: "T" }]);
    write([e]);
    await run();
    const [ev] = readTrail(cwd, env);
    expect(ev!.sessionId).toMatch(/^import-adr-sensor-\d{4}-\d{2}-\d{2}$/);
  });

  it("treats tool_calls as an alias for tools on messages", async () => {
    const e: AgentEvent = {
      uuid: "uuid-tool-calls",
      timestamp: "2026-10-10T07:00:00.000Z",
      source: "cursor",
      session_id: "s1",
      chat_history: [{ role: "assistant", content: "ok", tool_calls: [{ tool_name: "Write" }] }],
    };
    write([e]);
    await run();
    const [ev] = readTrail(cwd, env);
    expect(ev!.toolId).toBe("Write");
  });

  it("50MB guard refuses oversized files", async () => {
    const huge = "x".repeat(55 * 1024 * 1024);
    writeFileSync(file, huge, "utf8");
    const result = await importTraces({ from: "adr-sensor", file, cwd, env });
    expect(result.imported).toBe(0);
    expect(result.errors[0]).toContain("over the");
    expect(result.errors[0]).toContain("50MB");
  });

  it("refuses directories and FIFOs, without blocking", async () => {
    const dir = await importTraces({ from: "adr-sensor", file: cwd, cwd, env });
    expect(dir.errors[0]).toContain("not a regular file");
    const fifo = join(cwd, "fifo");
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      const r = await importTraces({ from: "adr-sensor", file: fifo, cwd, env });
      expect(r.imported).toBe(0);
      expect(r.errors[0]).toContain("not a regular file");
    }
  });

  describe("CLI wiring", () => {
    const capture = () => {
      const out: string[] = [];
      const err: string[] = [];
      return { out, err, io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) } };
    };

    it("--from adr-sensor resolves and requires a file", async () => {
      expect(importOptionsFromArgs(parseArgs(["import", "--from", "adr-sensor", "/x.jsonl"]))).toEqual({
        from: "adr-sensor",
        file: "/x.jsonl",
      });
      expect(importOptionsFromArgs(parseArgs(["import", "--from", "ADR-SENSOR", "/y.jsonl"]))).toEqual({
        from: "adr-sensor",
        file: "/y.jsonl",
      });
      const { io, err } = capture();
      await expect(runImport({ from: "adr-sensor", file: undefined }, io, cwd, env)).resolves.toBe(2);
      expect(err[0]).toContain("Usage: kya import");
    });

    it("exit 0 with summary for a valid import", async () => {
      const e = event({ timestamp: "2026-10-10T07:00:00.000Z" }, [{ tool_name: "Read" }]);
      write([e]);
      const { io, out } = capture();
      expect(await runImport({ from: "adr-sensor", file }, io, cwd, env)).toBe(0);
      expect(out[0]).toContain("imported 1 trace record(s)");
    });

    it("garbage file exits non-zero and imports nothing", async () => {
      writeFileSync(file, "garbage", "utf8");
      const { io, out } = capture();
      expect(await runImport({ from: "adr-sensor", file }, io, cwd, env)).toBe(1);
      expect(out.join("\n")).toContain("imported 0 trace record(s)");
      expect(out.join("\n")).toContain("errors: 1");
      expect(readTrail(cwd, env)).toEqual([]);
    });
  });

  describe("built CLI smoke (skip if dist absent)", () => {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const haveCli = existsSync(cli);

    it.skipIf(!haveCli)("imports through the built CLI", () => {
      const e = event({ timestamp: "2026-10-10T07:00:00.000Z" }, [{ tool_name: "Read" }]);
      write([e]);
      const r = spawnSync("node", [cli, "import", "--from", "adr-sensor", file], {
        env: { ...process.env, KYA_HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("imported 1 trace record(s)");
    }, 120_000);
  });
});
