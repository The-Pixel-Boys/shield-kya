/**
 * Spec F3 follow-up: the agent-flow export (`kya export`) and the editor extension read `outcome`, not only `verdict`.
 * Export: real CLI (dist/cli.js) with a temp HOME and a temp KYA_HOME. Editor extension: its core module is tested in
 * vscode/test/core.test.cjs; here only the list of outcomes is checked against kya's own list.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRAIL_OUTCOMES } from "../src/trail.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kya-outcome-readers-")));
  home = join(root, "home");
  cwd = join(root, "proj");
  mkdirSync(join(home, ".kya"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const now = Date.now();
const row = (i: number, extra: Record<string, unknown>) => ({
  ts: new Date(now - (10 - i) * 1000).toISOString(),
  sessionId: "sess-outcome",
  toolId: "Bash",
  verdict: "REQUIRE_APPROVE",
  reasonCode: "SHELL_EXEC",
  mode: "offline",
  product: "claude-code",
  ...extra,
});

function exportFlow(rows: Record<string, unknown>[]): { code: number | null; calls: Record<string, string>[]; err: string } {
  writeFileSync(join(home, ".kya", "trail.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const r = spawnSync(process.execPath, [CLI, "export", "--format", "agent-flow"], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home, KYA_NO_BROWSER: "1", KYA_UPDATE_CHECK: "0" },
  });
  const calls = (r.stdout ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "tool_call_end").map((e) => e.payload);
  return { code: r.status, calls, err: r.stderr ?? "" };
}

describe("kya export --format agent-flow reads the outcome (real CLI)", { timeout: 120_000 }, () => {
  it("sends the recorded outcome next to the policy verdict", () => {
    // Policy said REQUIRE_APPROVE for each row, but the calls ended four different ways.
    const r = exportFlow(TRAIL_OUTCOMES.map((outcome, i) => row(i, { outcome })));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => [c.verdict, c.outcome])).toEqual(TRAIL_OUTCOMES.map((o) => ["REQUIRE_APPROVE", o]));
  });

  it("old rows with no outcome keep working: no outcome key, verdict as before", () => {
    const r = exportFlow([row(1, {}), row(2, { verdict: "ALLOW", reasonCode: "OK" })]);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) expect(c).not.toHaveProperty("outcome");
    expect(r.calls.map((c) => c.verdict)).toEqual(["REQUIRE_APPROVE", "ALLOW"]);
  });

  it("a bad outcome value is not passed on", () => {
    const r = exportFlow([row(1, { outcome: "bogus" })]);
    expect(r.code).toBe(0);
    expect(r.calls[0]).not.toHaveProperty("outcome");
  });
});

describe("editor extension outcome list", () => {
  it("lists the same outcomes as kya", () => {
    const core = readFileSync(join(import.meta.dirname, "..", "vscode", "src", "core.ts"), "utf8");
    const list = /const OUTCOMES: readonly unknown\[\] = \[([^\]]*)\]/.exec(core)?.[1] ?? "";
    expect(list.split(",").map((s) => s.trim().replace(/"/g, ""))).toEqual([...TRAIL_OUTCOMES]);
  });
});
