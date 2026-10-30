// CTA suppression matrix (src/cta.ts) and the CLI wiring around it.
// Each suppression condition must alone stop the CTA; the clean case must print it once a day.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { CTA_INTERVAL_MS, CTA_LINES, ctaSkipReason, ctaStatePath, maybeCta, type CtaGate } from "../src/cta.js";
import { globalTrailPath, MAX_TRAIL_BYTES, trailTruncated } from "../src/trail.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A clean gate: terminal, not CI, nothing set, no state. Each test breaks exactly one condition. */
function clean(): { gate: CtaGate; log: string[] } {
  const home = tmp("kya-cta-home-");
  const cwd = tmp("kya-cta-cwd-");
  mkdirSync(join(home, ".kya"), { recursive: true });
  return {
    gate: { env: { KYA_HOME: home }, cwd, isTty: true, now: NOW },
    log: [],
  };
}

describe("CTA suppression matrix", () => {
  it("prints when nothing suppresses it", () => {
    const { gate, log } = clean();
    expect(ctaSkipReason(gate)).toBeUndefined();
    expect(maybeCta("certify-gaps", gate, (m) => log.push(m))).toBe(true);
    expect(log).toEqual([CTA_LINES["certify-gaps"]]);
  });

  it.each([
    ["--json output", (g: CtaGate) => ({ ...g, json: true })],
    ["certify --quiet", (g: CtaGate) => ({ ...g, quiet: true })],
    ["stdout not a terminal", (g: CtaGate) => ({ ...g, isTty: false })],
    ["CI=true", (g: CtaGate) => ({ ...g, env: { ...g.env, CI: "true" } })],
    ["CI=1", (g: CtaGate) => ({ ...g, env: { ...g.env, CI: "1" } })],
    ["GITHUB_ACTIONS=true", (g: CtaGate) => ({ ...g, env: { ...g.env, GITHUB_ACTIONS: "true" } })],
    ["KYA_QUIET=1", (g: CtaGate) => ({ ...g, env: { ...g.env, KYA_QUIET: "1" } })],
    ["KYA_CTA=0", (g: CtaGate) => ({ ...g, env: { ...g.env, KYA_CTA: "0" } })],
    ["KYA_CTA=off", (g: CtaGate) => ({ ...g, env: { ...g.env, KYA_CTA: "off" } })],
  ])("%s suppresses the CTA", (_label, mutate) => {
    const { gate, log } = clean();
    const g = mutate(gate);
    expect(ctaSkipReason(g)).toBeDefined();
    expect(maybeCta("receipt-share", g, (m) => log.push(m))).toBe(false);
    expect(log).toEqual([]);
    expect(existsSync(ctaStatePath(g.env))).toBe(false);
  });

  it("a config opt-out in .kya/config.json suppresses the CTA", () => {
    const { gate, log } = clean();
    mkdirSync(join(gate.cwd, ".kya"), { recursive: true });
    writeFileSync(join(gate.cwd, ".kya", "config.json"), JSON.stringify({ ctaOptOut: true }));
    expect(ctaSkipReason(gate)).toBe("opted out in .kya/config.json");
    expect(maybeCta("certify-gaps", gate, (m) => log.push(m))).toBe(false);
    expect(log).toEqual([]);
  });

  it("a saved opt-out in ~/.kya/cta.json suppresses the CTA", () => {
    const { gate, log } = clean();
    writeFileSync(ctaStatePath(gate.env), JSON.stringify({ optOut: true }));
    expect(ctaSkipReason(gate)).toBe("opted out");
    expect(maybeCta("certify-gaps", gate, (m) => log.push(m))).toBe(false);
  });

  it("a second CTA within 24 hours is suppressed, and one after 24 hours prints again", () => {
    const { gate, log } = clean();
    expect(maybeCta("certify-gaps", gate, (m) => log.push(m))).toBe(true);
    const soon = { ...gate, now: NOW + CTA_INTERVAL_MS - 1000 };
    expect(maybeCta("receipt-share", soon, (m) => log.push(m))).toBe(false);
    const later = { ...gate, now: NOW + CTA_INTERVAL_MS + 1000 };
    expect(maybeCta("receipt-truncated", later, (m) => log.push(m))).toBe(true);
    expect(log).toEqual([CTA_LINES["certify-gaps"], CTA_LINES["receipt-truncated"]]);
  });

  it("a last-shown time in the future also suppresses (clock moved back)", () => {
    const { gate } = clean();
    writeFileSync(ctaStatePath(gate.env), JSON.stringify({ lastShownAt: new Date(NOW + 3600_000).toISOString() }));
    expect(ctaSkipReason(gate)).toBe("already shown in the last 24 hours");
  });

  it("CI=false is not CI (same truthy rule as telemetry)", () => {
    const { gate } = clean();
    expect(ctaSkipReason({ ...gate, env: { ...gate.env, CI: "false" } })).toBeUndefined();
  });

  it("a read or write failure never throws out of maybeCta", () => {
    const { gate, log } = clean();
    // A directory where the state file should be makes the write fail; the CTA line still prints.
    mkdirSync(ctaStatePath(gate.env), { recursive: true });
    expect(maybeCta("certify-gaps", gate, (m) => log.push(m))).toBe(true);
    expect(log).toHaveLength(1);
  });
});

describe("trail truncation signal", () => {
  it("is false for a small trail and true past the read cap", () => {
    const home = tmp("kya-cta-trail-");
    const cwd = tmp("kya-cta-trail-cwd-");
    const env = { KYA_HOME: home };
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(globalTrailPath(env), "{}\n");
    expect(trailTruncated(cwd, env)).toBe(false);
    writeFileSync(globalTrailPath(env), Buffer.alloc(MAX_TRAIL_BYTES + 1, 0x20));
    expect(trailTruncated(cwd, env)).toBe(true);
  });
});

describe("CLI wiring", () => {
  function captureIo(isTty: boolean) {
    const logs: string[] = [];
    const io: CliIo = { log: (m) => logs.push(m), error: () => {}, exit: () => {}, isTty };
    return { io, logs };
  }

  it("certify still exits 1 on gaps, with or without the CTA, and the CTA shows only on a terminal", async () => {
    const cwd = tmp("kya-cta-certify-cwd-");
    const home = tmp("kya-cta-certify-home-");
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(
      globalTrailPath({ KYA_HOME: home }),
      `${JSON.stringify({ ts: new Date().toISOString(), sessionId: "s1", toolId: "Read", verdict: "ALLOW", reasonCode: "LOW_RISK_READ", mode: "hold" })}\n`,
    );
    const env = { KYA_SKIP_NODE_CHECK: "1", KYA_HOME: home };
    const quiet = captureIo(false);
    const codeOff = await runCli(["certify"], quiet.io, env, cwd);
    expect(quiet.logs.join("\n")).not.toContain(CTA_LINES["certify-gaps"]);
    const tty = captureIo(true);
    const codeOn = await runCli(["certify"], tty.io, env, cwd);
    expect(tty.logs.join("\n")).toContain(CTA_LINES["certify-gaps"]);
    expect(codeOff).toBe(1);
    expect(codeOn).toBe(codeOff);
  });

  it("certify --json never prints the CTA", async () => {
    const cwd = tmp("kya-cta-json-cwd-");
    const home = tmp("kya-cta-json-home-");
    const tty = captureIo(true);
    await runCli(["certify", "--json"], tty.io, { KYA_SKIP_NODE_CHECK: "1", KYA_HOME: home }, cwd);
    expect(tty.logs.join("\n")).not.toContain("kya login");
  });

  it("receipt prints the share hint once a day on a terminal, and never in CI", async () => {
    const cwd = tmp("kya-cta-receipt-cwd-");
    const home = tmp("kya-cta-receipt-home-");
    const env = { KYA_SKIP_NODE_CHECK: "1", KYA_HOME: home, KYA_NO_BROWSER: "1" };
    const ci = captureIo(true);
    await runCli(["receipt"], ci.io, { ...env, CI: "true" }, cwd);
    expect(ci.logs.join("\n")).not.toContain(CTA_LINES["receipt-share"]);
    const tty = captureIo(true);
    await runCli(["receipt"], tty.io, env, cwd);
    expect(tty.logs.join("\n")).toContain(CTA_LINES["receipt-share"]);
    const again = captureIo(true);
    await runCli(["receipt"], again.io, env, cwd);
    expect(again.logs.join("\n")).not.toContain("kya receipt --share for");
    expect(readFileSync(ctaStatePath(env), "utf8")).toContain("lastShownAt");
  });
});
