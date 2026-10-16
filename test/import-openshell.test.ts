/**
 * kya import --from openshell: mapping, JSON/JSONL/[ocsf] parsing, idempotence,
 * bad files, size guard, stdin, and CLI wiring (importers/openshell.ts,
 * commands/import-traces.ts).
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

interface OcsfRecord {
  uid?: string;
  time?: number;
  time_dt?: string;
  class_name?: string;
  category_name?: string;
  activity_name?: string;
  disposition?: string;
  status?: string;
  session_id?: string;
  src_endpoint?: { ip?: string; hostname?: string; port?: number };
  dst_endpoint?: { ip?: string; hostname?: string; port?: number };
  http_request?: Record<string, unknown>;
  http_response?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

const TS = "2026-10-10T07:00:00.000Z";
const TS_MS = Date.parse(TS);

function record(over: Partial<OcsfRecord>): OcsfRecord {
  return {
    uid: "uid-" + Math.random().toString(36).slice(2),
    time_dt: TS,
    class_name: "Network Activity",
    activity_name: "Open",
    disposition: "Allowed",
    session_id: "osh-sess-1",
    ...over,
  };
}

describe("kya import --from openshell", () => {
  let home: string;
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let file: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kya-osh-home-"));
    cwd = mkdtempSync(join(tmpdir(), "kya-osh-proj-"));
    env = { KYA_HOME: home };
    file = join(cwd, "openshell-events.jsonl");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const write = (v: unknown) => writeFileSync(file, JSON.stringify(v), "utf8");
  const writeLines = (lines: unknown[]) => writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  const run = () => importTraces({ from: "openshell", file, cwd, env });

  it("maps a denied network event to a DENY row with provenance and redacted endpoint summary", async () => {
    const r = record({
      disposition: "Denied",
      dst_endpoint: { hostname: "example.com", port: 443 },
      src_endpoint: { ip: "10.0.0.2", port: 51234 },
    });
    write([r]);
    const result = await run();
    expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [], duplicates: 0 });

    const [ev] = readTrail(cwd, env);
    expect(ev).toMatchObject({
      ts: TS,
      sessionId: "osh-sess-1",
      host: "import",
      toolId: "openshell.network",
      verdict: "DENY",
      reasonCode: "OPENSHELL_POLICY",
      mode: "observe",
      importFormat: "openshell",
      importedFrom: "openshell",
      sourceHash: r.uid,
    });
    expect(ev!.summary).toBe("dst: example.com:443");
    expect(ev!.argsHash).toBeUndefined();
    expect(ev!.diffPreview).toBeUndefined();
    expect(ev!.targetPath).toBeUndefined();
    expect(ev!.packId).toBeUndefined();
  });

  it("maps an audit-mode allow to ALLOW and uses the epoch-ms time field", async () => {
    const r = record({ time: TS_MS, time_dt: undefined, disposition: "Allowed" });
    write([r]);
    const result = await run();
    expect(result).toMatchObject({ imported: 1, skipped: 0 });
    const [ev] = readTrail(cwd, env);
    expect(ev).toMatchObject({ ts: TS, verdict: "ALLOW", reasonCode: "OPENSHELL_POLICY" });
  });

  it("uses openshell.http for L7 events (http_request block or HTTP class)", async () => {
    const withBlock = record({ http_request: { method: "POST" } });
    const withClass = record({ class_name: "HTTP Activity", category_name: "HTTP Activity" });
    write([withBlock, withClass]);
    await run();
    const events = readTrail(cwd, env);
    expect(events.map((e) => e.toolId)).toEqual(["openshell.http", "openshell.http"]);
  });

  it("marks DENY from disposition, status, or status_detail", async () => {
    const byDisposition = record({ disposition: "Denied" });
    const byStatus = record({ disposition: undefined, status: "Denied" });
    const byDetail = record({ disposition: undefined, status_detail: "Policy DENIED the connection" });
    const allowed = record({});
    write([byDisposition, byStatus, byDetail, allowed]);
    await run();
    const events = readTrail(cwd, env);
    expect(events.map((e) => [e.verdict, e.reasonCode])).toEqual([
      ["DENY", "OPENSHELL_POLICY"],
      ["DENY", "OPENSHELL_POLICY"],
      ["DENY", "OPENSHELL_POLICY"],
      ["ALLOW", "OPENSHELL_POLICY"],
    ]);
  });

  it("accepts JSONL, whole-file JSON array, and single JSON object", async () => {
    const a = record({});
    const b = record({});

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

  it("tolerates [ocsf] text lines with tag tokens before the JSON", async () => {
    const denied = record({ disposition: "Denied" });
    const http = record({ http_request: { method: "GET" } });
    writeFileSync(
      file,
      [
        `[ocsf] NET:OPEN src=10.0.0.2 DENIED ${JSON.stringify(denied)}`,
        `[ocsf] HTTP:GET /v1/models ALLOWED ${JSON.stringify(http)}`,
      ].join("\n"),
      "utf8",
    );
    const result = await run();
    expect(result).toMatchObject({ imported: 2, skipped: 0, errors: [] });
    const events = readTrail(cwd, env);
    expect(events.map((e) => [e.toolId, e.verdict])).toEqual([
      ["openshell.network", "DENY"],
      ["openshell.http", "ALLOW"],
    ]);
  });

  it("skips bad lines and malformed records without aborting the file", async () => {
    const ok = record({});
    const metaSession = record({ session_id: undefined, metadata: { session_id: "meta-sess" } });
    writeFileSync(
      file,
      [
        JSON.stringify(ok),
        "{ this is not json",
        "just some log noise",
        JSON.stringify({ notAnEvent: true }),
        JSON.stringify({ uid: "x", time_dt: "not a date" }),
        JSON.stringify(metaSession),
      ].join("\n"),
      "utf8",
    );
    const result = await run();
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(4);
    expect(result.errors.some((m) => m.includes("line 2"))).toBe(true);
    expect(result.errors.some((m) => m.includes("line 3"))).toBe(true);
    expect(result.errors.some((m) => m.includes("missing uid"))).toBe(true);
    expect(result.errors.some((m) => m.includes("missing or invalid timestamp"))).toBe(true);
    const events = readTrail(cwd, env);
    expect(events.filter((e) => e.sessionId === "osh-sess-1")).toHaveLength(1);
    expect(events.filter((e) => e.sessionId === "meta-sess")).toHaveLength(1);
  });

  it("is idempotent: a second import adds no rows and reports duplicates", async () => {
    const r = record({});
    write([r]);
    await run();
    const again = await run();
    expect(again).toMatchObject({ imported: 0, skipped: 1, errors: [], duplicates: 1 });
    expect(readTrail(cwd, env)).toHaveLength(1);
    expect(renderImportSummary(again)).toContain("already imported: 1 record(s)");
  });

  it("a grown export only adds the new events", async () => {
    const a = record({});
    const b = record({});
    write([a]);
    await run();
    write([a, b]);
    const result = await run();
    expect(result).toMatchObject({ imported: 1, duplicates: 1 });
    expect(readTrail(cwd, env)).toHaveLength(2);
  });

  it("falls back to import-openshell-<date> when session_id is missing", async () => {
    const r = record({ session_id: undefined });
    write([r]);
    await run();
    const [ev] = readTrail(cwd, env);
    expect(ev!.sessionId).toMatch(/^import-openshell-\d{4}-\d{2}-\d{2}$/);
  });

  it("50MB guard refuses oversized files", async () => {
    const huge = "x".repeat(55 * 1024 * 1024);
    writeFileSync(file, huge, "utf8");
    const result = await importTraces({ from: "openshell", file, cwd, env });
    expect(result.imported).toBe(0);
    expect(result.errors[0]).toContain("over the");
    expect(result.errors[0]).toContain("50MB");
  });

  it("refuses directories and FIFOs, without blocking", async () => {
    const dir = await importTraces({ from: "openshell", file: cwd, cwd, env });
    expect(dir.errors[0]).toContain("not a regular file");
    const fifo = join(cwd, "fifo");
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      const r = await importTraces({ from: "openshell", file: fifo, cwd, env });
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

    it("--from openshell resolves and requires a file", async () => {
      expect(importOptionsFromArgs(parseArgs(["import", "--from", "openshell", "/x.jsonl"]))).toEqual({
        from: "openshell",
        file: "/x.jsonl",
      });
      expect(importOptionsFromArgs(parseArgs(["import", "--from", "OPENSHELL", "/y.jsonl"]))).toEqual({
        from: "openshell",
        file: "/y.jsonl",
      });
      const { io, err } = capture();
      await expect(runImport({ from: "openshell", file: undefined }, io, cwd, env)).resolves.toBe(2);
      expect(err[0]).toContain("Usage: kya import");
    });

    it("exit 0 with summary for a valid import", async () => {
      write([record({})]);
      const { io, out } = capture();
      expect(await runImport({ from: "openshell", file }, io, cwd, env)).toBe(0);
      expect(out[0]).toContain("imported 1 trace record(s)");
    });

    it("garbage file exits non-zero and imports nothing", async () => {
      writeFileSync(file, "garbage", "utf8");
      const { io, out } = capture();
      expect(await runImport({ from: "openshell", file }, io, cwd, env)).toBe(1);
      expect(out.join("\n")).toContain("imported 0 trace record(s)");
      expect(out.join("\n")).toContain("errors: 1");
      expect(readTrail(cwd, env)).toEqual([]);
    });
  });

  describe("built CLI smoke (skip if dist absent)", () => {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const haveCli = existsSync(cli);

    it.skipIf(!haveCli)("imports through the built CLI", () => {
      write([record({})]);
      const r = spawnSync("node", [cli, "import", "--from", "openshell", file], {
        env: { ...process.env, KYA_HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("imported 1 trace record(s)");
    }, 120_000);

    it.skipIf(!haveCli)("explicit /dev/stdin from a real pipe imports the records", () => {
      write([record({}), record({})]);
      const r = spawnSync("sh", ["-c", `cat '${file}' | node '${cli}' import --from openshell /dev/stdin`], {
        env: { ...process.env, KYA_HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("imported 2 trace record(s)");
      expect(readTrail(cwd, env)).toHaveLength(2);
    }, 120_000);
  });
});
