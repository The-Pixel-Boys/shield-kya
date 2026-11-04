import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMap, readTrailFile, toolClassOf } from "../src/map/build.js";
import type { MapGraph, TrailEventLike, Verdicts } from "../src/map/types.js";

const FIXTURE = join(import.meta.dirname, "fixtures/map/trail.jsonl");
const SALT = "test-salt";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kya-map-build-"));
  dirs.push(dir);
  const file = join(dir, "trail.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function ev(over: Partial<TrailEventLike> = {}): TrailEventLike {
  return {
    ts: "2026-10-30T10:00:00.000Z",
    sessionId: "s1",
    product: "claude",
    project: "app",
    toolId: "Read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "offline",
    targetPath: "/Users/tester/dev/app/src/a.ts",
    ...over,
  };
}

async function fixtureEvents(): Promise<TrailEventLike[]> {
  return (await readTrailFile(FIXTURE)).events;
}

function sumVerdicts(v: Verdicts): number {
  return v.allow + v.deny + v.hold + v.observed;
}

describe("buildMap on the synthetic fixture", () => {
  it("has the expected node and edge counts", async () => {
    const r = await readTrailFile(FIXTURE);
    const g = buildMap(r.events, { salt: SALT, read: r });
    const kinds = Object.fromEntries(["device", "agent", "tool", "target"].map((k) => [k, g.nodes.filter((n) => n.kind === k).length]));
    expect(kinds).toEqual({ device: 1, agent: 4, tool: 14, target: 20 });
    expect(g.nodes).toHaveLength(39);
    expect(g.edges.filter((e) => e.kind === "runs")).toHaveLength(4);
    expect(g.edges.filter((e) => e.kind === "uses")).toHaveLength(20);
    expect(g.edges).toHaveLength(57);
    expect(g.schemaVersion).toBe(1);
  });

  it("reads all 75 rows and reports the legacy row and a clean view", async () => {
    const r = await readTrailFile(FIXTURE);
    const g = buildMap(r.events, { salt: SALT, read: r });
    expect(g.view).toMatchObject({ source: "trail", rowsRead: 75, rowsSkipped: 0, rowsOutOfWindow: 0, legacyRows: 1, truncated: false, capExceeded: false });
    expect(g.view.grouped).toEqual({ agents: 0, tools: 0, targets: 0 });
  });

  it("colours verdicts: device totals match the fixture counts", async () => {
    const g = buildMap(await fixtureEvents(), { salt: SALT });
    const dev = g.nodes.find((n) => n.id === "device:local")!;
    expect(dev.count).toBe(75);
    expect(dev.verdicts).toEqual({ allow: 37, deny: 7, hold: 3, observed: 28 });
  });

  it("the secret target is held, the git target has denies, and a plain read is allowed", async () => {
    const g = buildMap(await fixtureEvents(), { salt: SALT });
    const cred = g.nodes.find((n) => n.id === "target:secret:cloud-credential")!;
    expect(cred.verdicts).toEqual({ allow: 0, deny: 0, hold: 1, observed: 0 });
    const git = g.nodes.find((n) => n.id === "target:command:git")!;
    expect(git.verdicts.deny).toBe(2);
    const tmp = g.nodes.find((n) => n.id === "target:tmp:/**")!;
    expect(tmp.verdicts).toEqual({ allow: 2, deny: 0, hold: 0, observed: 0 });
  });

  it("every node and edge keeps allow + deny + hold + observed = count", async () => {
    const g = buildMap(await fixtureEvents(), { salt: SALT });
    for (const n of g.nodes) expect(sumVerdicts(n.verdicts), n.id).toBe(n.count);
    for (const e of g.edges) expect(sumVerdicts(e.verdicts), `${e.from} ${e.to}`).toBe(e.count);
  });

  it("is deterministic: two runs give byte-identical JSON", async () => {
    const events = await fixtureEvents();
    const a = JSON.stringify(buildMap(events, { salt: SALT }));
    const b = JSON.stringify(buildMap(events, { salt: SALT }));
    expect(a).toBe(b);
  });

  it("is order-independent: a shuffled trail gives the same JSON", async () => {
    const events = await fixtureEvents();
    const shuffled = [...events].reverse();
    expect(JSON.stringify(buildMap(shuffled, { salt: SALT }))).toBe(JSON.stringify(buildMap(events, { salt: SALT })));
  });

  it("leaks no raw path, host userinfo, argument, summary or session id", async () => {
    const out = JSON.stringify(buildMap(await fixtureEvents(), { salt: SALT }));
    for (const raw of ["fixture-user", "index.ts", "credentials", "example.conf", "git (+2 args)", "5e1c0a00-0000-4000-8000-00000000c001", "argsHash", "d308e36b"]) {
      expect(out, raw).not.toContain(raw);
    }
  });
});

describe("buildMap: sessions and salt", () => {
  it("the agent id is a 16 hex sessionHash, stable for the same salt", async () => {
    const events = await fixtureEvents();
    const a = buildMap(events, { salt: SALT }).nodes.filter((n) => n.kind === "agent");
    const b = buildMap(events, { salt: SALT }).nodes.filter((n) => n.kind === "agent");
    for (const n of a) {
      expect(n.kind === "agent" && n.sessionHash).toMatch(/^[0-9a-f]{16}$/);
      expect(n.id).toBe(`agent:${n.kind === "agent" ? n.sessionHash : ""}`);
    }
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
  });

  it("a different salt gives different agent ids", async () => {
    const events = await fixtureEvents();
    const a = buildMap(events, { salt: "one" }).nodes.filter((n) => n.kind === "agent").map((n) => n.id);
    const b = buildMap(events, { salt: "two" }).nodes.filter((n) => n.kind === "agent").map((n) => n.id);
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it("the same session id under two products gives two agents", () => {
    const g = buildMap([ev({ product: "claude" }), ev({ product: "kimi" })], { salt: SALT });
    expect(g.nodes.filter((n) => n.kind === "agent")).toHaveLength(2);
  });

  it("a row with no product is a legacy agent", () => {
    const row = ev();
    delete (row as Partial<TrailEventLike>).product;
    const g = buildMap([row], { salt: SALT });
    const agent = g.nodes.find((n) => n.kind === "agent");
    expect(agent).toMatchObject({ product: "unknown", legacy: true });
    expect(g.view.legacyRows).toBe(1);
  });

  it("labels an agent with the project of its latest row", () => {
    const g = buildMap(
      [ev({ project: "old", ts: "2026-10-01T00:00:00.000Z" }), ev({ project: "new", ts: "2026-10-02T00:00:00.000Z" })],
      { salt: SALT },
    );
    expect(g.nodes.find((n) => n.kind === "agent")?.label).toBe("new");
  });

  it("uses a device node per deviceId and device:local otherwise", () => {
    const g = buildMap([ev(), ev({ deviceId: "0123456789abcdef" })], { salt: SALT });
    expect(g.nodes.filter((n) => n.kind === "device").map((n) => n.id)).toEqual(["device:0123456789abcdef", "device:local"]);
    expect(g.edges.filter((e) => e.kind === "runs").map((e) => e.from).sort()).toEqual(["device:0123456789abcdef", "device:local"]);
  });

  it("uses targetClass when the row has it, and derives it otherwise", () => {
    const g = buildMap([ev({ targetClass: "secret:ssh-key", targetPath: "/tmp/x" })], { salt: SALT });
    const t = g.nodes.find((n) => n.kind === "target")!;
    expect(t).toMatchObject({ id: "target:secret:ssh-key", class: "secret:ssh-key", family: "secret" });
  });
});

describe("toolClassOf", () => {
  it.each([
    [{ toolId: "kya:guard-config" }, "kya"],
    [{ toolId: "mcp__fs__write_file" }, "mcp"],
    [{ toolId: "Bash", summary: "shell git (+1 args)" }, "shell"],
    [{ toolId: "WebFetch", targetPath: "https://h.example/x" }, "network"],
    [{ toolId: "Write" }, "write"],
    [{ toolId: "Edit" }, "write"],
    [{ toolId: "Grep" }, "read"],
    [{ toolId: "Glob" }, "read"],
    [{ toolId: "Thing" }, "other"],
  ])("%j gives its class", (row, cls) => {
    expect(toolClassOf(ev(row as Partial<TrailEventLike>))).toBe(cls);
  });
});

describe("buildMap: verdict buckets (schema section 3)", () => {
  it.each([
    ["DENY offline", { verdict: "DENY", mode: "offline" }, "deny"],
    ["DENY shadow", { verdict: "DENY", mode: "offline", shadow: true }, "deny"],
    ["ALLOW shadow", { verdict: "ALLOW", mode: "observe", shadow: true }, "observed"],
    ["REQUIRE_APPROVE hold", { verdict: "REQUIRE_APPROVE", mode: "hold" }, "hold"],
    ["REQUIRE_APPROVE offline", { verdict: "REQUIRE_APPROVE", mode: "offline" }, "observed"],
    ["REQUIRE_APPROVE observe", { verdict: "REQUIRE_APPROVE", mode: "observe" }, "observed"],
    ["ALLOW offline", { verdict: "ALLOW", mode: "offline" }, "allow"],
    ["ALLOW hold", { verdict: "ALLOW", mode: "hold" }, "allow"],
  ] as const)("%s lands in %s", (_name, over, bucket) => {
    const g = buildMap([ev(over as Partial<TrailEventLike>)], { salt: SALT });
    const dev = g.nodes.find((n) => n.id === "device:local")!;
    expect(dev.verdicts[bucket]).toBe(1);
    expect(sumVerdicts(dev.verdicts)).toBe(1);
  });
});

describe("buildMap: cap rule (schema section 7)", () => {
  /** 30 sessions, 31 tools, 61 commands, one deny command. */
  function wide(): TrailEventLike[] {
    const rows: TrailEventLike[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(ev({ sessionId: `s${i}`, toolId: `T${i}`, targetPath: undefined, summary: `shell cmd${i}` }));
      rows.push(ev({ sessionId: `s${i}`, toolId: "Bash", targetPath: undefined, summary: `shell cmd${30 + i}`, ts: `2026-10-30T11:${String(i).padStart(2, "0")}:00.000Z` }));
    }
    rows.push(ev({ sessionId: "s0", toolId: "Bash", verdict: "DENY", reasonCode: "NEVER_EVENT", targetPath: undefined, summary: "shell rm" }));
    return rows;
  }

  it("folds the rest into one other node per product, toolClass and family, and keeps the sums", () => {
    const rows = wide();
    const g = buildMap(rows, { salt: SALT });
    expect(g.view.truncated).toBe(true);
    expect(g.view.capExceeded).toBe(false);
    expect(g.nodes.length).toBeLessThanOrEqual(100);
    expect(g.nodes.find((n) => n.id === "agent:other:claude")).toMatchObject({ kind: "agent", label: "other agents (5)", grouped: 5 });
    expect(g.nodes.filter((n) => n.kind === "agent" && !n.id.startsWith("agent:other")).length).toBe(25);
    expect(g.nodes.find((n) => n.id === "target:other:command")).toMatchObject({ kind: "target", grouped: 20 });
    expect(g.nodes.find((n) => n.id === "tool:other:shell")?.kind).toBe("tool");
    expect(g.view.grouped.agents).toBe(5);
    expect(g.view.grouped.tools).toBe(11);
    expect(g.view.grouped.targets).toBe(20);
    const total = g.nodes.filter((n) => n.kind === "agent").reduce((s, n) => s + n.count, 0);
    expect(total).toBe(rows.length);
  });

  it("always shows a deny target, even with a count of one", () => {
    const g = buildMap(wide(), { salt: SALT });
    expect(g.nodes.find((n) => n.id === "target:command:rm")?.verdicts.deny).toBe(1);
  });

  it("shows everything with uncapped, and no other nodes", () => {
    const g = buildMap(wide(), { salt: SALT, uncapped: true });
    expect(g.view.truncated).toBe(false);
    expect(g.nodes.some((n) => n.kind === "agent" && n.grouped !== undefined)).toBe(false);
    expect(g.nodes.filter((n) => n.kind === "agent")).toHaveLength(30);
  });

  it("shrinks the per-type caps to fit a small node cap", () => {
    const g = buildMap(wide(), { salt: SALT, maxNodes: 20 });
    expect(g.nodes.length).toBeLessThanOrEqual(20);
    expect(g.view.capExceeded).toBe(false);
  });

  it("sets capExceeded when always-shown items alone exceed the cap, and shows them all", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ev({ sessionId: "d", toolId: "Bash", verdict: "DENY", reasonCode: "NEVER_EVENT", targetPath: undefined, summary: `shell bad${i}` }));
    const g = buildMap(rows, { salt: SALT, maxNodes: 5 });
    expect(g.view.capExceeded).toBe(true);
    expect(g.nodes.filter((n) => n.kind === "target" && n.id.startsWith("target:command:bad"))).toHaveLength(10);
  });

  it("drops edges over 250 and records the drop, keeping deny edges", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ev({ sessionId: "d", toolId: "Bash", verdict: "DENY", reasonCode: "NEVER_EVENT", targetPath: undefined, summary: `shell bad${i}` }));
    const g = buildMap(rows, { salt: SALT });
    expect(g.edges.length).toBe(250);
    expect(g.view.edgesDropped).toBe(302 - 250);
    expect(g.view.truncated).toBe(true);
    expect(g.edges.every((e) => e.verdicts.deny > 0 || e.kind !== "touches")).toBe(true);
  });
});

describe("buildMap: window and bad rows", () => {
  it("drops rows older than days and counts them", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const rows = [ev({ ts: "2026-10-29T12:00:00.000Z" }), ev({ ts: "2026-10-01T12:00:00.000Z" })];
    const g = buildMap(rows, { salt: SALT, now, days: 7 });
    expect(g.view.rowsOutOfWindow).toBe(1);
    expect(g.nodes.find((n) => n.id === "device:local")?.count).toBe(1);
  });

  it("throws when days is set without now (the builder reads no clock)", () => {
    expect(() => buildMap([ev()], { salt: SALT, days: 7 })).toThrow(/needs now/);
  });

  it("skips and counts rows of the wrong shape in an iterable", () => {
    const bad = { ts: "nope", sessionId: "x", toolId: "Read", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" } as unknown as TrailEventLike;
    const g = buildMap([ev(), bad, { ...ev(), mode: "weird" } as unknown as TrailEventLike], { salt: SALT });
    expect(g.view.rowsSkipped).toBe(2);
    expect(g.view.rowsRead).toBe(3);
    expect(g.nodes.find((n) => n.id === "device:local")?.count).toBe(1);
  });
});

describe("readTrailFile", () => {
  it("reads the whole fixture with no skips", async () => {
    const r = await readTrailFile(FIXTURE);
    expect(r).toMatchObject({ rowsRead: 75, rowsSkipped: 0, rowsOutOfWindow: 0 });
    expect(r.events).toHaveLength(75);
  });

  it("counts bad lines, ignores blank lines, and filters by days", async () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const good = JSON.stringify(ev({ ts: "2026-10-29T12:00:00.000Z" }));
    const old = JSON.stringify(ev({ ts: "2026-09-01T12:00:00.000Z" }));
    const file = tmpFile([good, "", "not json", "[1,2]", JSON.stringify({ ...ev(), mode: "bogus" }), JSON.stringify(ev({ ts: "nope" })), old]);
    const r = await readTrailFile(file, { days: 7, now });
    expect(r.events).toHaveLength(1);
    expect(r).toMatchObject({ rowsRead: 6, rowsSkipped: 4, rowsOutOfWindow: 1 });
  });

  it("reads past the last 1 MB, so the first row of a big trail is kept", async () => {
    const first = JSON.stringify(ev({ sessionId: "first-row", ts: "2026-10-01T00:00:00.000Z" }));
    const pad = "x".repeat(600);
    const lines = [first];
    for (let i = 0; i < 3000; i++) lines.push(JSON.stringify(ev({ sessionId: `s${i % 50}`, diffPreview: pad } as Partial<TrailEventLike>)));
    const file = tmpFile(lines);
    const r = await readTrailFile(file);
    expect(r.events).toHaveLength(3001);
    expect(r.events[0]?.sessionId).toBe("first-row");
  });

  it("rejects a missing file", async () => {
    await expect(readTrailFile(join(tmpdir(), "kya-map-no-such-file.jsonl"))).rejects.toThrow();
  });
});

describe("buildMap performance", () => {
  it("builds 20,000 generated events in under 2 seconds", () => {
    const rows: TrailEventLike[] = [];
    const tools = ["Bash", "Read", "Write", "Edit", "Grep", "WebFetch", "mcp__a__b", "kimi.lookup"];
    for (let i = 0; i < 20_000; i++) {
      const k = i % 97;
      rows.push(
        ev({
          sessionId: `session-${i % 200}`,
          product: i % 3 === 0 ? "kimi" : "claude",
          toolId: tools[i % tools.length]!,
          verdict: i % 50 === 0 ? "DENY" : i % 4 === 0 ? "REQUIRE_APPROVE" : "ALLOW",
          mode: "offline",
          ts: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
          targetPath: k % 2 === 0 ? `/Users/tester/dev/app/src/f${k}.ts` : undefined,
          summary: k % 2 === 1 ? `shell bin${k}` : undefined,
        }),
      );
    }
    const t0 = performance.now();
    const g = buildMap(rows, { salt: SALT });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);
    expect(g.view.rowsRead).toBe(20_000);
  });
});

describe("buildMap: stored fields are checked before use (review item 6)", () => {
  it("a deviceId that is not 16 hex becomes device:local, so a hostile trail cannot name a node", () => {
    const g = buildMap([ev({ deviceId: "<img src=x>" })], { salt: SALT });
    expect(g.nodes.filter((n) => n.kind === "device").map((n) => n.id)).toEqual(["device:local"]);
  });

  it("a stored targetClass that is too long or has control characters is ignored and derived again", () => {
    for (const bad of ["network:" + "a".repeat(200), "secret:\u0000x", "no colon here"]) {
      const g = buildMap([ev({ targetClass: bad, toolId: "Bash", summary: "shell git (+1 args)", targetPath: undefined })], { salt: SALT });
      const ids = g.nodes.filter((n) => n.kind === "target").map((n) => n.id);
      expect(ids.join(",")).not.toContain(bad);
      expect(ids).toContain("target:command:git");
    }
  });
});
