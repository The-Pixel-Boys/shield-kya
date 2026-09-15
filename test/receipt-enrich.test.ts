import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIdentity,
  loadOrrCard,
  loadSandboxes,
  loadShowbackCard,
  loadWiredHosts,
} from "../src/receipt/enrich.js";
import { parseUsageRecords as parseFromCostPerTask } from "../src/showback/cost-per-task.js";
import {
  MAX_USAGE_FILE_BYTES,
  parseUsageFilePayload,
  parseUsageRecords,
} from "../src/showback/usage-file.js";

let dir: string;
let homes: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-enrich-"));
  homes = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function mkHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kya-enrich-home-"));
  homes.push(home);
  return home;
}

function write(rel: string, content: string): string {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

const ORR_REPORT = {
  rubric_version: "0",
  generated_at: "2026-09-14T00:00:00.000Z",
  target: { name: "demo-target", path: ".", kind: "path" },
  overall: "amber",
  disposition: "conditional",
  primary_failure_mode: "secret handling",
  most_urgent_fix: "rotate leaked keys",
  scorecards: [
    { category: "security_platform", name: "a", result: "pass", hardness: "hard" },
    { category: "security_platform", name: "b", result: "pass", hardness: "soft" },
    { category: "engineering_craft", name: "c", result: "fail", hardness: "soft" },
    { category: "engineering_craft", name: "d", result: "partial", hardness: "soft" },
    { category: "scale_operations", name: "e", result: "not_evaluated", hardness: "soft" },
  ],
};

describe("loadIdentity", () => {
  it("reads .kya/config.json fields", () => {
    write(
      ".kya/config.json",
      JSON.stringify({
        agentId: "agt-1",
        agentName: "refund-bot",
        host: "ide",
        baseUrl: "http://127.0.0.1:8090",
      }),
    );
    expect(loadIdentity(dir)).toEqual({
      agentId: "agt-1",
      agentName: "refund-bot",
      host: "ide",
      baseUrl: "http://127.0.0.1:8090",
    });
  });

  it("returns undefined when config.json is missing", () => {
    expect(loadIdentity(dir)).toBeUndefined();
  });

  it("returns undefined on corrupt JSON", () => {
    write(".kya/config.json", "{not json");
    expect(loadIdentity(dir)).toBeUndefined();
  });

  it("drops non-string fields and configs with no recognized fields", () => {
    write(
      ".kya/config.json",
      JSON.stringify({
        agentId: 42,
        agentName: ["x"],
        host: "evil",
        baseUrl: "http://127.0.0.1:8090",
      }),
    );
    expect(loadIdentity(dir)).toEqual({ baseUrl: "http://127.0.0.1:8090" });
    write(".kya/config.json", JSON.stringify({ foo: "bar" }));
    expect(loadIdentity(dir)).toBeUndefined();
  });
});

describe("loadSandboxes", () => {
  it("returns running and killed rows plus the configured backend", () => {
    write(
      ".kya/sandboxes.json",
      JSON.stringify([
        { sandboxId: "sbx-1", backend: "mock", createdAt: "t", status: "running" },
        { sandboxId: "sbx-2", backend: "mock", createdAt: "t", status: "killed" },
      ]),
    );
    const card = loadSandboxes(dir, { KYA_SANDBOX: "Mock" });
    expect(card.backend).toBe("mock");
    expect(card.sandboxes.map((s) => s.status)).toEqual(["running", "killed"]);
  });

  it("returns an empty list when sandboxes.json is absent", () => {
    const card = loadSandboxes(dir, {});
    expect(card.backend).toBeUndefined();
    expect(card.sandboxes).toEqual([]);
  });

  it("returns an empty list on corrupt state", () => {
    write(".kya/sandboxes.json", "nope");
    expect(loadSandboxes(dir, {}).sandboxes).toEqual([]);
  });
});

describe("loadOrrCard", () => {
  it("picks the card fields and counts scorecards by result", () => {
    write("orr-report/report.json", JSON.stringify(ORR_REPORT));
    expect(loadOrrCard(dir)).toEqual({
      overall: "amber",
      disposition: "conditional",
      primaryFailureMode: "secret handling",
      mostUrgentFix: "rotate leaked keys",
      generatedAt: "2026-09-14T00:00:00.000Z",
      targetName: "demo-target",
      scorecards: { pass: 2, fail: 1, partial: 1, notEvaluated: 1 },
    });
  });

  it("returns undefined when report.json is missing", () => {
    expect(loadOrrCard(dir)).toBeUndefined();
  });

  it("returns undefined on corrupt JSON", () => {
    write("orr-report/report.json", "{oops");
    expect(loadOrrCard(dir)).toBeUndefined();
  });

  it("rejects non-object JSON", () => {
    write("orr-report/report.json", JSON.stringify([1, 2, 3]));
    expect(loadOrrCard(dir)).toBeUndefined();
  });

  it("rejects an oversized report", () => {
    const big = { ...ORR_REPORT, pad: "x".repeat(300 * 1024) };
    write("orr-report/report.json", JSON.stringify(big));
    expect(loadOrrCard(dir)).toBeUndefined();
  });

  it("caps free-text fields at 500 chars", () => {
    const big = {
      ...ORR_REPORT,
      primary_failure_mode: "p".repeat(600),
      most_urgent_fix: "f".repeat(600),
      target: { ...ORR_REPORT.target, name: "t".repeat(600) },
    };
    write("orr-report/report.json", JSON.stringify(big));
    const card = loadOrrCard(dir);
    expect(card?.primaryFailureMode).toHaveLength(500);
    expect(card?.mostUrgentFix).toHaveLength(500);
    expect(card?.targetName).toHaveLength(500);
  });

  it("refuses a symlink escaping cwd", () => {
    const outside = join(tmpdir(), "kya-enrich-orr-outside.json");
    writeFileSync(outside, JSON.stringify(ORR_REPORT), "utf8");
    try {
      mkdirSync(join(dir, "orr-report"), { recursive: true });
      symlinkSync(outside, join(dir, "orr-report", "report.json"));
      expect(loadOrrCard(dir)).toBeUndefined();
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("loadShowbackCard", () => {
  const usage = [
    { agentId: "refund-bot", runId: "run-1", tokensIn: 1000, tokensOut: 200 },
  ];

  it("builds showback from a bare array", () => {
    write(".kya/usage.json", JSON.stringify(usage));
    const card = loadShowbackCard(dir);
    expect(card?.totalTokensIn).toBe(1000);
    expect(card?.totalTokensOut).toBe(200);
    expect(card?.perRun[0]?.runId).toBe("run-1");
    expect(card?.billingMeter).toBe(false);
  });

  it("accepts a { usage: [...] } wrapper", () => {
    write(".kya/usage.json", JSON.stringify({ usage }));
    expect(loadShowbackCard(dir)?.totalTokensIn).toBe(1000);
  });

  it("returns undefined when usage.json is missing", () => {
    expect(loadShowbackCard(dir)).toBeUndefined();
  });

  it("returns undefined on corrupt JSON", () => {
    write(".kya/usage.json", "[[[");
    expect(loadShowbackCard(dir)).toBeUndefined();
  });

  it("returns undefined when no records parse", () => {
    write(".kya/usage.json", JSON.stringify([]));
    expect(loadShowbackCard(dir)).toBeUndefined();
  });

  it("returns undefined for an oversized file", () => {
    write(".kya/usage.json", " ".repeat(MAX_USAGE_FILE_BYTES + 1));
    expect(loadShowbackCard(dir)).toBeUndefined();
  });

  it("refuses a symlink escaping cwd", () => {
    const outside = join(tmpdir(), "kya-enrich-usage-outside.json");
    writeFileSync(outside, JSON.stringify(usage), "utf8");
    try {
      mkdirSync(join(dir, ".kya"), { recursive: true });
      symlinkSync(outside, join(dir, ".kya", "usage.json"));
      expect(loadShowbackCard(dir)).toBeUndefined();
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("loadWiredHosts", () => {
  it("detects a global wiring via the cursor mcp.json", () => {
    const home = mkHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { "shield-kya": { command: "kya" } } }),
      "utf8",
    );
    const rows = loadWiredHosts(dir, home, new Set());
    const cursor = rows.find((r) => r.id === "cursor");
    expect(cursor?.wired).toBe("global");
    expect(cursor?.label).toBe("Cursor (IDE + Agent CLI)");
    expect(cursor?.reload?.reload).toBe("auto");
    expect(cursor?.running).toBe(false);
    expect(rows.find((r) => r.id === "kimi")?.wired).toBe("none");
  });

  it("reports both when global and project configs are wired", () => {
    const home = mkHome();
    const block = JSON.stringify({ mcpServers: { "shield-kya": {} } });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), block, "utf8");
    write(".cursor/mcp.json", block);
    const cursor = loadWiredHosts(dir, home, new Set()).find(
      (r) => r.id === "cursor",
    );
    expect(cursor?.wired).toBe("both");
  });

  it("uses rootKey as a literal key (amp.mcpServers)", () => {
    const home = mkHome();
    mkdirSync(join(home, ".config", "amp"), { recursive: true });
    writeFileSync(
      join(home, ".config", "amp", "settings.json"),
      JSON.stringify({ "amp.mcpServers": { "shield-kya": {} } }),
      "utf8",
    );
    const amp = loadWiredHosts(dir, home, new Set()).find((r) => r.id === "amp");
    expect(amp?.wired).toBe("global");
  });

  it("treats corrupt host config as not wired", () => {
    const home = mkHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), "{broken", "utf8");
    const cursor = loadWiredHosts(dir, home, new Set()).find(
      (r) => r.id === "cursor",
    );
    expect(cursor?.wired).toBe("none");
  });

  it("treats an oversize host config as not wired", () => {
    const home = mkHome();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const pad = "x".repeat(1024 * 1024);
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { "shield-kya": { command: pad } } }),
      "utf8",
    );
    const cursor = loadWiredHosts(dir, home, new Set()).find(
      (r) => r.id === "cursor",
    );
    expect(cursor?.wired).toBe("none");
  });

  it("never probes recipeOnly hosts and flags them", () => {
    const rows = loadWiredHosts(dir, mkHome());
    for (const id of ["cline", "droid"]) {
      const row = rows.find((r) => r.id === id);
      expect(row?.wired).toBe("none");
      expect(row?.recipeOnly).toMatch(/^docs\/hosts\//);
    }
    expect(rows.filter((r) => r.recipeOnly)).toHaveLength(2);
    expect(rows).toHaveLength(13);
  });

  it("running follows the injected process set", () => {
    const rows = loadWiredHosts(dir, dir, new Set(["cursor"]));
    expect(rows.find((r) => r.id === "cursor")?.running).toBe(true);
    expect(rows.find((r) => r.id === "opencode")?.running).toBe(false);
  });
});

describe("usage-file extraction", () => {
  it("re-exports parseUsageRecords with identical behavior", () => {
    const raw = [{ agent_id: "a", tokens_in: "5", tokens_out: 2 }];
    expect(parseUsageRecords(raw)).toEqual(parseFromCostPerTask(raw));
    expect(MAX_USAGE_FILE_BYTES).toBe(256 * 1024);
  });

  it("parses both payload shapes and rejects others", () => {
    const usage = [{ agentId: "a", tokensIn: 1, tokensOut: 1 }];
    expect(parseUsageFilePayload(usage)).toHaveLength(1);
    expect(parseUsageFilePayload({ usage })).toHaveLength(1);
    expect(() => parseUsageFilePayload({ nope: true })).toThrow();
    expect(() => parseUsageFilePayload("nope")).toThrow();
  });
});
