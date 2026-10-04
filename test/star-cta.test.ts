import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  maybePrintStarCta,
  starCtaFlagPath,
  starCtaShown,
  STAR_CTA_LINE,
  STAR_CTA_MIN_EVENTS,
} from "../src/star-cta.js";
import { appendTrail } from "../src/trail.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-star-cta-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedTrail(count: number): void {
  for (let i = 0; i < count; i++) {
    appendTrail(dir, {
      ts: new Date(Date.now() - i * 1000).toISOString(),
      sessionId: `seed-${i}`,
      toolId: "org.sample.safe.read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
    });
  }
}

describe("maybePrintStarCta", () => {
  it("prints once at or above the event threshold and persists the flag", () => {
    seedTrail(STAR_CTA_MIN_EVENTS);
    const logs: string[] = [];
    expect(maybePrintStarCta(dir, 3, (m) => logs.push(m))).toBe(true);
    expect(logs).toEqual([STAR_CTA_LINE]);
    expect(logs[0]).toContain("https://github.com/The-Pixel-Boys/shield-agent");
    expect(starCtaShown(dir)).toBe(true);

    const second: string[] = [];
    expect(maybePrintStarCta(dir, 3, (m) => second.push(m))).toBe(false);
    expect(second).toEqual([]);
  });

  it("does not print below the threshold and leaves no flag", () => {
    seedTrail(STAR_CTA_MIN_EVENTS - 1);
    const logs: string[] = [];
    expect(maybePrintStarCta(dir, 3, (m) => logs.push(m))).toBe(false);
    expect(logs).toEqual([]);
    expect(starCtaShown(dir)).toBe(false);
  });

  it("does not print when the flag already exists, even with many events", () => {
    seedTrail(50);
    mkdirSync(join(dir, ".kya"), { recursive: true });
    writeFileSync(starCtaFlagPath(dir), "2026-01-01T00:00:00.000Z\n", "utf8");
    const logs: string[] = [];
    expect(maybePrintStarCta(dir, 3, (m) => logs.push(m))).toBe(false);
    expect(logs).toEqual([]);
  });

  it("honors the days window", () => {
    // One event now, the rest 10 days old: a 3-day window has too few events.
    seedTrail(1);
    for (let i = 1; i < STAR_CTA_MIN_EVENTS; i++) {
      appendTrail(dir, {
        ts: new Date(Date.now() - (i + 4) * 24 * 60 * 60 * 1000).toISOString(),
        sessionId: `old-${i}`,
        toolId: "org.sample.safe.read",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      });
    }
    const logs: string[] = [];
    expect(maybePrintStarCta(dir, 3, (m) => logs.push(m))).toBe(false);
    expect(starCtaShown(dir)).toBe(false);
  });
});
