/**
 * CLI wiring for kya import and kya investigate (commands/import-traces.ts,
 * commands/investigate.ts over the importers/investigate modules).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImport } from "../src/commands/import-traces.js";
import { runInvestigate } from "../src/commands/investigate.js";
import { appendTrail, readTrail } from "../src/trail.js";

const home = () => mkdtempSync(join(tmpdir(), "kya-wiring-home-"));
const cwdOf = () => mkdtempSync(join(tmpdir(), "kya-wiring-proj-"));

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) },
    out,
    err,
  };
}

describe("kya import (command wiring)", () => {
  it("usage error without --from or file", async () => {
    const { io, err } = captureIo();
    const code = await runImport({ from: undefined, file: undefined }, io, cwdOf(), home());
    expect(code).toBe(2);
    expect(err[0]).toContain("Usage: kya import");
  });

  it("imports a small langsmith export into the trail", async () => {
    const env = { KYA_HOME: home() };
    const cwd = cwdOf();
    const file = join(cwd, "runs.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          name: "write_file",
          run_type: "tool",
          start_time: "2026-10-09T10:00:00.000Z",
          end_time: "2026-10-09T10:00:01.500Z",
          session_name: "sess-ls",
          prompt_tokens: 120,
          completion_tokens: 30,
        },
      ]),
    );
    const { io, out } = captureIo();
    const code = await runImport({ from: "langsmith", file }, io, cwd, env);
    expect(code).toBe(0);
    const events = readTrail(cwd, env);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      toolId: "write_file",
      verdict: "ALLOW",
      reasonCode: "IMPORTED",
      mode: "observe",
      host: "import",
      sessionId: "sess-ls",
      latencyMs: 1500,
      tokensIn: 120,
      tokensOut: 30,
    });
    expect(out.join("\n")).toContain("1");
  });
});

describe("kya investigate (command wiring)", () => {
  it("prints the report header on an empty trail, exit 0", async () => {
    const env = { KYA_HOME: home() };
    const { io, out } = captureIo();
    const code = await runInvestigate({ json: false }, io, cwdOf(), env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("kya investigate");
  });

  it("flags a deny spike from seeded trail events", async () => {
    const env = { KYA_HOME: home() };
    const cwd = cwdOf();
    const base = Date.now();
    for (let i = 0; i < 4; i++) {
      appendTrail(cwd, {
        ts: new Date(base + i * 60_000).toISOString(),
        sessionId: "s-spike",
        host: "ide",
        toolId: "Bash",
        verdict: "DENY",
        reasonCode: "SHELL_EXEC",
        mode: "hold",
      }, env);
    }
    const { io, out } = captureIo();
    const code = await runInvestigate({ json: false }, io, cwd, env);
    expect(code).toBe(0);
    expect(out.join("\n").toLowerCase()).toContain("deny");
  });

  it("--json emits structured findings, incidents, briefs", async () => {
    const env = { KYA_HOME: home() };
    const cwd = cwdOf();
    appendTrail(cwd, {
      ts: new Date().toISOString(),
      sessionId: "s1",
      host: "ide",
      toolId: "org.sample.never.event",
      verdict: "DENY",
      reasonCode: "NEVER_EVENT",
      mode: "offline",
      neverEvent: true,
    }, env);
    appendTrail(cwd, {
      ts: new Date().toISOString(),
      sessionId: "s1",
      host: "ide",
      toolId: "org.sample.never.event",
      verdict: "DENY",
      reasonCode: "NEVER_EVENT",
      mode: "offline",
      neverEvent: true,
    }, env);
    const { io, out } = captureIo();
    const code = await runInvestigate({ json: true }, io, cwd, env);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as {
      findings: unknown[];
      incidents: { id: string }[];
      briefs: Record<string, string>;
    };
    expect(parsed.incidents.length).toBeGreaterThan(0);
    expect(Object.keys(parsed.briefs)).toEqual(parsed.incidents.map((i) => i.id));
    expect(Object.values(parsed.briefs)[0]).toContain("kya certify");
  });
});
