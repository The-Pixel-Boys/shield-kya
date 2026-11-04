import { describe, expect, it } from "vitest";
import { buildHeat } from "../src/map/heat.js";
import type { TrailEventLike } from "../src/map/types.js";

const NOW = new Date("2026-10-30T12:00:00.000Z");

function ev(ts: string, over: Partial<TrailEventLike> = {}): TrailEventLike {
  return {
    ts,
    sessionId: "s1",
    product: "claude",
    toolId: "Read",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "offline",
    targetPath: "/Users/tester/dev/app/src/a.ts",
    project: "app",
    ...over,
  };
}

/** Fixed set. Window with now 2026-10-30T12:00Z and 7 days starts 2026-10-24T00:00Z. */
function sample(): TrailEventLike[] {
  return [
    ev("2026-10-30T09:15:00.000Z"), // day 6, hour 9, allow
    ev("2026-10-30T09:45:00.000Z", { verdict: "DENY", reasonCode: "NEVER_EVENT", targetPath: undefined, summary: "shell rm" }), // day 6, hour 9, deny
    ev("2026-10-24T23:59:00.000Z"), // day 0, hour 23, in window
    ev("2026-10-23T23:59:00.000Z"), // before the window: excluded
    ev("2026-10-30T13:00:00.000Z"), // after now: excluded
    ev("2026-10-30T12:00:00.000Z"), // exactly now: included, day 6, hour 12
    ev("2026-10-27T03:00:00.000Z", { verdict: "DENY", reasonCode: "NEVER_EVENT", targetPath: undefined, summary: "shell rm" }), // day 3, hour 3, deny only
  ];
}

describe("buildHeat: when", () => {
  it("counts per calendar day and hour, with the window fixed by now", () => {
    const h = buildHeat(sample(), { now: NOW, days: 7 });
    expect(h.when.days).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(h.when.hours).toHaveLength(24);
    expect(h.when.cells).toHaveLength(7);
    expect(h.when.cells.every((d) => d.length === 24)).toBe(true);
    expect(h.when.cells[0]![23]).toBe(1);
    expect(h.when.cells[6]![9]).toBe(2);
    expect(h.when.cells[6]![12]).toBe(1);
    expect(h.when.cells[3]![3]).toBe(1);
    const total = h.when.cells.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
    expect(h.when.max).toBe(2);
  });

  it("keeps the deny count per cell, and a deny-only cell is deny 1", () => {
    const h = buildHeat(sample(), { now: NOW, days: 7 });
    expect(h.when.verdictCells[6]![9]).toEqual({ allow: 1, deny: 1, hold: 0, observed: 0 });
    expect(h.when.verdictCells[3]![3]).toEqual({ allow: 0, deny: 1, hold: 0, observed: 0 });
    expect(h.when.verdictCells[3]![3]!.deny).toBe(1);
  });

  it("applies the timezone offset to the day and the hour", () => {
    // 09:15Z is 11:15 at +120, same day. 10:30Z is 12:30 at +120.
    const rows = [ev("2026-10-30T09:15:00.000Z"), ev("2026-10-30T10:30:00.000Z")];
    const plus2 = buildHeat(rows, { now: NOW, days: 7, tzOffsetMinutes: 120 });
    expect(plus2.when.cells[6]![11]).toBe(1);
    expect(plus2.when.cells[6]![12]).toBe(1);
    const utc = buildHeat(rows, { now: NOW, days: 7 });
    expect(utc.when.cells[6]![9]).toBe(1);
    expect(utc.when.cells[6]![10]).toBe(1);
  });

  it("the offset moves an event across midnight into the window", () => {
    // 2026-10-23T23:00Z is 2026-10-24 01:00 at +120: inside the local window, outside the UTC one.
    const rows = [ev("2026-10-23T23:00:00.000Z")];
    expect(buildHeat(rows, { now: NOW, days: 7, tzOffsetMinutes: 120 }).when.cells[0]![1]).toBe(1);
    expect(buildHeat(rows, { now: NOW, days: 7 }).when.cells.flat().reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("empty input gives zero cells for every day", () => {
    const h = buildHeat([], { now: NOW, days: 7 });
    expect(h.when.days).toHaveLength(7);
    expect(h.when.cells.flat().every((c) => c === 0)).toBe(true);
    expect(h.when.max).toBe(0);
    expect(h.where).toEqual({ rows: [], max: 0 });
  });

  it("empty input with no now has no days", () => {
    const h = buildHeat([]);
    expect(h.when.days).toEqual([]);
    expect(h.where.rows).toEqual([]);
  });

  it("excludes rows outside the window in both views", () => {
    const h = buildHeat(sample(), { now: NOW, days: 7 });
    const whereTotal = h.where.rows.reduce((s, r) => s + r.total, 0);
    expect(whereTotal).toBe(5);
  });

  it("uses the latest row as now when no now is given", () => {
    const h = buildHeat(sample(), { days: 7 });
    // The latest row is 13:00Z, which becomes now, so the 13:00Z row counts too.
    expect(h.when.days[6]).toBe("2026-10-30");
    expect(h.when.cells[6]![13]).toBe(1);
    expect(h.when.cells.flat().reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("rejects days below 1", () => {
    expect(() => buildHeat([], { now: NOW, days: 0 })).toThrow(/positive integer/);
  });
});

describe("buildHeat: where", () => {
  it("lists target classes by total, then class name, with verdict columns", () => {
    const rows = [
      ev("2026-10-30T09:00:00.000Z", { toolId: "Bash", summary: "shell git (+1 args)", targetPath: undefined }),
      ev("2026-10-30T09:01:00.000Z", { toolId: "Bash", summary: "shell git (+1 args)", targetPath: undefined }),
      ev("2026-10-30T09:02:00.000Z", { toolId: "Bash", summary: "shell git (+1 args)", targetPath: undefined, verdict: "DENY", reasonCode: "NEVER_EVENT" }),
      ev("2026-10-30T09:03:00.000Z", { toolId: "WebFetch", targetPath: "https://x.example/a", verdict: "REQUIRE_APPROVE", mode: "hold" }),
      ev("2026-10-30T09:04:00.000Z", { toolId: "Read", targetPath: "/Users/tester/dev/app/src/a.ts" }),
    ];
    const h = buildHeat(rows, { now: NOW, days: 7 });
    expect(h.where.rows.map((r) => r.class)).toEqual(["command:git", "network:x.example", "project:app/src/**"]);
    expect(h.where.rows[0]).toEqual({ class: "command:git", family: "command", allow: 2, deny: 1, hold: 0, observed: 0, total: 3 });
    expect(h.where.rows[1]).toMatchObject({ class: "network:x.example", hold: 1, total: 1 });
    expect(h.where.max).toBe(2);
  });

  it("a deny-only target is a row with deny 1", () => {
    const h = buildHeat([ev("2026-10-30T09:00:00.000Z", { verdict: "DENY", reasonCode: "NEVER_EVENT", targetPath: undefined, summary: "shell rm" })], { now: NOW, days: 7 });
    expect(h.where.rows).toEqual([{ class: "command:rm", family: "command", allow: 0, deny: 1, hold: 0, observed: 0, total: 1 }]);
  });

  it("folds targets past the top 40 into one other row per family, keeping deny rows", () => {
    const rows: TrailEventLike[] = [];
    for (let i = 0; i < 45; i++) {
      rows.push(ev("2026-10-30T09:00:00.000Z", { toolId: "Bash", summary: `shell c${i}`, targetPath: undefined }));
      rows.push(ev("2026-10-30T09:01:00.000Z", { toolId: "Bash", summary: `shell c${i}`, targetPath: undefined }));
    }
    rows.push(ev("2026-10-30T09:02:00.000Z", { toolId: "Bash", summary: "shell rm", targetPath: undefined, verdict: "DENY", reasonCode: "NEVER_EVENT" }));
    const h = buildHeat(rows, { now: NOW, days: 7 });
    expect(h.where.rows).toHaveLength(42);
    const other = h.where.rows.find((r) => r.class === "other:command")!;
    expect(other).toMatchObject({ family: "command", grouped: 5, total: 10 });
    expect(h.where.rows.find((r) => r.class === "command:rm")?.deny).toBe(1);
    expect(h.where.rows.reduce((s, r) => s + r.total, 0)).toBe(91);
  });
});

describe("buildHeat: determinism", () => {
  it("same input gives the same output, in any order", () => {
    const a = JSON.stringify(buildHeat(sample(), { now: NOW, days: 7 }));
    const b = JSON.stringify(buildHeat(sample(), { now: NOW, days: 7 }));
    const c = JSON.stringify(buildHeat([...sample()].reverse(), { now: NOW, days: 7 }));
    expect(a).toBe(b);
    expect(c).toBe(a);
  });
});
