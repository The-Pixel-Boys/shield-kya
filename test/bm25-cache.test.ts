/**
 * POST /feed reuses the BM25 index while the trail version, the chip filters and
 * the event window stay the same. Cached results must equal fresh ones, and a
 * trail write must give a new index.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eventKey, rankEvents } from "../src/receipt/search.js";
import { readTrail, trailVersion, type TrailEvent } from "../src/trail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOOLS = ["github.create_issue", "fs.write_file", "shell.rm", "slack.post_message", "stripe.transfer"];
const VERDICTS = ["ALLOW", "DENY", "HOLD"];

function event(n: number): TrailEvent {
  return {
    ts: new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + n * 1000).toISOString(),
    sessionId: `s-${n % 3}`,
    toolId: `mcp__${TOOLS[n % TOOLS.length]}`,
    verdict: VERDICTS[n % VERDICTS.length],
    reasonCode: n % 4 === 0 ? "NEVER_EVENT" : "OK",
    mode: n % 2 ? "observe" : "hold",
    summary: `step ${n} ${["deploy production", "delete files", "send payment", "read notes"][n % 4]}`,
  } as TrailEvent;
}

const QUERIES = [
  "deploy",
  "delete files",
  "payment",
  "github issue",
  "rm",
  "blocked",
  "dangerous",
  "slack",
  "stripe transfer",
  "production",
  "notes",
  "write file",
  "held approval",
  "step 7",
  "observe",
  "hold",
  "send",
  "denied stripe",
  "create",
  "post message",
];

function ids(events: readonly TrailEvent[], query: string, filters: Record<string, string[]>, indexVersion?: string): string[] {
  return rankEvents(events, { query, filters, indexVersion }).map((r) => `${eventKey(r.event)}=${r.score}`);
}

describe("BM25 index cache", () => {
  it("cached and fresh results are identical for 20 queries and three filter sets", () => {
    const events = Array.from({ length: 300 }, (_, n) => event(n));
    for (const filters of [{}, { verdict: ["DENY"] }, { mode: ["observe"] }]) {
      for (const q of QUERIES) {
        const fresh = ids(events, q, filters);
        expect(ids(events, q, filters, "v1")).toEqual(fresh);
        expect(ids(events, q, filters, "v1")).toEqual(fresh);
      }
    }
  });

  it("a trail write gives a new version and a new index", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-bm25-"));
    dirs.push(home);
    const cwd = join(home, "project");
    mkdirSync(join(home, ".kya"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const env = { KYA_HOME: home };
    const trail = join(home, ".kya", "trail.jsonl");
    appendFileSync(trail, Array.from({ length: 40 }, (_, n) => JSON.stringify(event(n))).join("\n") + "\n");

    const v1 = trailVersion(cwd, env);
    const before = readTrail(cwd, env);
    expect(before).toHaveLength(40);
    expect(ids(before, "zebracorn", {}, v1)).toEqual([]);

    // Same first and last event, same count: only the trail version tells the two apart.
    const changed = before.map((e, n) => (n === 20 ? { ...e, summary: "zebracorn escaped" } : e));
    appendFileSync(trail, "\n");
    const v2 = trailVersion(cwd, env);
    expect(v2).not.toBe(v1);
    const found = ids(changed, "zebracorn", {}, v2);
    expect(found).toEqual(ids(changed, "zebracorn", {}));
    expect(found).toHaveLength(1);
  });
});
