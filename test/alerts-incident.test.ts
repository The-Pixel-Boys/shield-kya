/**
 * Incident alerts (kya-alerts, N3): severity floor, dedupe, state cap, config precedence,
 * KYA_ALERTS override, payload privacy, delivery rules. No model. Real files in a temp KYA_HOME,
 * the receiver is a fetch stub (the real-stack run is test/alerts-e2e.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAlertsConfig } from "../src/alerts/config.js";
import { runAlertScan, windowEvents } from "../src/alerts/scan.js";
import {
  ALERTS_STATE_KEEP,
  alertsStatePath,
  incidentRef,
  needsAlert,
  readAlertsState,
  writeAlertsState,
  type AlertEntry,
} from "../src/alerts/state.js";
import { buildIncidentAlert, buildTestIncidentAlert } from "../src/alerts/incident-alert.js";
import { investigateTrail } from "../src/investigate/index.js";
import {
  NOTIFY_TEMPLATES,
  notifyIncident,
  notifyOnTrailEvent,
  readNotifyLog,
  resetNotifyState,
  resolveIncidentWebhooks,
  serializeIncidentPayload,
} from "../src/notify/index.js";
import { appendTrail, globalTrailPath, legacyTrailPath, type TrailEvent } from "../src/trail.js";
import { runAlerts } from "../src/commands/alerts.js";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const HOME_PATH = "/Users/alice";
let home: string;
let project: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kya-alerts-home-"));
  project = mkdtempSync(join(tmpdir(), "kya-alerts-proj-"));
  env = { KYA_HOME: home, KYA_ALERTS_DESKTOP: "off" }; // never pop a real desktop notification from a test
  resetNotifyState();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function writeUserConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, ".kya"), { recursive: true });
  writeFileSync(join(home, ".kya", "config.json"), JSON.stringify(cfg));
}
function writeProjectConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(project, ".kya"), { recursive: true });
  writeFileSync(join(project, ".kya", "config.json"), JSON.stringify(cfg));
}

function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

function neverEvent(minAgo: number, over: Partial<TrailEvent> = {}): TrailEvent {
  return {
    ts: minutesAgo(minAgo),
    sessionId: "SESSION-SECRET-777",
    host: "ide",
    product: "claude",
    project: "private-folder",
    toolId: "mcp__postgres__drop_table",
    verdict: "DENY",
    reasonCode: "NEVER_EVENT",
    mode: "offline",
    neverEvent: true,
    argsHash: "ARGSHASH-DEADBEEF",
    diffPreview: "DIFFPREVIEW-LINE",
    targetPath: `${HOME_PATH}/p/TARGETPATH.txt`,
    summary: `drop table in ${HOME_PATH}/p`,
    ...over,
  };
}

function lowEvent(minAgo: number): TrailEvent {
  return { ts: minutesAgo(minAgo), sessionId: "s2", toolId: "Mystery", verdict: "REQUIRE_APPROVE", reasonCode: "UNKNOWN_TOOL", mode: "hold" };
}

function seed(events: TrailEvent[]): void {
  for (const e of events) appendTrail(project, e, env);
}

interface Sink {
  readonly bodies: Array<{ url: string; body: string }>;
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
}
function sink(ok = true): Sink {
  const bodies: Sink["bodies"] = [];
  return {
    bodies,
    fetchImpl: async (url, init) => {
      bodies.push({ url, body: String(init?.body ?? "") });
      return { ok, status: ok ? 200 : 500 };
    },
  };
}
const fastDeps = (s: Sink) => ({ fetchImpl: s.fetchImpl, sleep: async () => undefined, now: () => NOW });
const kinds = (s: Sink, url?: string) =>
  s.bodies.filter((b) => !url || b.url === url).map((b) => JSON.parse(b.body) as Record<string, unknown>);

function enable(extra: Record<string, unknown> = {}): void {
  writeUserConfig({
    alerts: { enabled: true },
    notify: { webhooks: [{ url: "http://127.0.0.1:9/hook", events: ["incident.opened"] }] },
    ...extra,
  });
}

describe("kya-alerts config", () => {
  it("defaults: off, floor high, window 120", () => {
    expect(resolveAlertsConfig(env)).toMatchObject({ enabled: false, minSeverity: "high", windowMinutes: 120, source: "default" });
  });

  it("user config values apply and bad values fall back", () => {
    writeUserConfig({ alerts: { enabled: true, minSeverity: "medium", windowMinutes: 30 } });
    expect(resolveAlertsConfig(env)).toMatchObject({ enabled: true, minSeverity: "medium", windowMinutes: 30, source: "config" });
    writeUserConfig({ alerts: { enabled: "yes", minSeverity: "urgent", windowMinutes: -5 } });
    expect(resolveAlertsConfig(env)).toMatchObject({ enabled: false, minSeverity: "high", windowMinutes: 120 });
  });

  it("KYA_ALERTS=on|off overrides the file in both directions", () => {
    writeUserConfig({ alerts: { enabled: false } });
    expect(resolveAlertsConfig({ ...env, KYA_ALERTS: "on" })).toMatchObject({ enabled: true, source: "env" });
    writeUserConfig({ alerts: { enabled: true } });
    expect(resolveAlertsConfig({ ...env, KYA_ALERTS: "off" })).toMatchObject({ enabled: false, source: "env" });
    expect(resolveAlertsConfig({ ...env, KYA_ALERTS: "maybe" }).enabled).toBe(true);
  });

  it("a project config cannot turn alerts off, lower the floor or add a receiver", async () => {
    enable();
    writeProjectConfig({
      alerts: { enabled: false, minSeverity: "critical" },
      notify: { webhooks: [{ url: "http://127.0.0.1:9/attacker" }] },
    });
    seed([neverEvent(10), neverEvent(9)]);
    const s = sink();
    const r = await runAlertScan(project, env, fastDeps(s));
    expect(r.alerted).toHaveLength(1);
    expect(s.bodies.map((b) => b.url)).toEqual(["http://127.0.0.1:9/hook"]);
  });

  it("a project config cannot enable alerts that the user left off", async () => {
    writeUserConfig({ notify: { webhooks: [{ url: "http://127.0.0.1:9/hook" }] } });
    writeProjectConfig({ alerts: { enabled: true } });
    seed([neverEvent(10), neverEvent(9)]);
    const s = sink();
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(0);
    expect(s.bodies).toHaveLength(0);
  });
});

describe("kya-alerts severity floor", () => {
  it.each([
    ["critical", 0],
    ["high", 1],
    ["low", 2],
  ] as const)("floor %s alerts %i incident(s)", async (floor, expected) => {
    enable();
    writeUserConfig({
      alerts: { enabled: true, minSeverity: floor },
      notify: { webhooks: [{ url: "http://127.0.0.1:9/hook" }] },
    });
    seed([neverEvent(10), neverEvent(9), lowEvent(8)]);
    const s = sink();
    const r = await runAlertScan(project, env, fastDeps(s));
    expect(r.alerted).toHaveLength(expected);
    expect(s.bodies).toHaveLength(expected);
  });

  it("events older than windowMinutes are not scanned", async () => {
    writeUserConfig({
      alerts: { enabled: true, windowMinutes: 5 },
      notify: { webhooks: [{ url: "http://127.0.0.1:9/hook" }] },
    });
    seed([neverEvent(60), neverEvent(59)]);
    const s = sink();
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(0);
  });
});

describe("kya-alerts dedupe", () => {
  it("alerts once, not again on a second run, not again when the incident refreshes", async () => {
    enable();
    seed([neverEvent(10), neverEvent(9)]);
    const s = sink();
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(1);
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(0);
    seed([neverEvent(8), neverEvent(7)]); // more events, same incident
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(0);
    expect(s.bodies).toHaveLength(1);
  });

  it("alerts again when severity rises (seeded lower entry for the same incident)", async () => {
    enable();
    seed([neverEvent(10), neverEvent(9)]);
    const inc = investigateTrail([neverEvent(10), neverEvent(9)]).incidents[0]!;
    const ref = incidentRef(inc.id);
    writeAlertsState(env, [
      { key: `${ref}:medium`, ref, severity: "medium", ts: minutesAgo(30), lastTs: inc.lastTs, title: "t", detectors: ["never-repeat"], delivered: 1, attempts: 1, status: "sent" },
    ]);
    const s = sink();
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(1);
    expect(readAlertsState(env).map((e) => e.key)).toEqual([`${ref}:medium`, `${ref}:high`]);
  });

  it("needsAlert: rise, new occurrence after the last one ended, and retry rules", () => {
    const base: AlertEntry = { key: "r:medium", ref: "r", severity: "medium", ts: NOW.toISOString(), lastTs: minutesAgo(10), title: "t", detectors: [], delivered: 1, attempts: 1, status: "sent" };
    const same = { ref: "r", severity: "medium" as const, firstTs: minutesAgo(20), lastTs: minutesAgo(5) };
    expect(needsAlert([], same, NOW.getTime())).toBe(true);
    expect(needsAlert([base], same, NOW.getTime())).toBe(false);
    expect(needsAlert([base], { ...same, severity: "high" }, NOW.getTime())).toBe(true);
    expect(needsAlert([{ ...base, severity: "high" }], { ...same, severity: "medium" }, NOW.getTime())).toBe(false);
    expect(needsAlert([base], { ...same, firstTs: minutesAgo(2) }, NOW.getTime())).toBe(true);
    const pending: AlertEntry = { ...base, delivered: 0, status: "pending", ts: NOW.toISOString() };
    expect(needsAlert([pending], same, NOW.getTime() + 10_000)).toBe(false); // sibling still sending
    expect(needsAlert([pending], same, NOW.getTime() + 61_000)).toBe(true); // cool-down passed
    expect(needsAlert([{ ...pending, attempts: 3 }], same, NOW.getTime() + 61_000)).toBe(false); // attempts used
  });

  it("a failed delivery is retried after the cool-down, at most 3 attempts in total", async () => {
    enable();
    seed([neverEvent(10), neverEvent(9)]);
    const s = sink(false);
    let t = NOW.getTime();
    const deps = { fetchImpl: s.fetchImpl, sleep: async () => undefined, now: () => new Date(t) };
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push((await runAlertScan(project, env, deps)).alerted.length);
      resetNotifyState();
      t += 61_000;
    }
    expect(runs).toEqual([1, 1, 1, 0, 0]);
    expect(readAlertsState(env)[0]).toMatchObject({ status: "pending", attempts: 3, delivered: 0 });
  });

  it("two scans at the same time send once (state lock)", async () => {
    enable();
    seed([neverEvent(10), neverEvent(9)]);
    const s = sink();
    const [a, b] = await Promise.all([runAlertScan(project, env, fastDeps(s)), runAlertScan(project, env, fastDeps(s))]);
    expect(a.alerted.length + b.alerted.length).toBe(1);
    expect(s.bodies).toHaveLength(1);
  });

  it("the state file keeps the last 500 entries", () => {
    const entries: AlertEntry[] = Array.from({ length: 620 }, (_, i) => ({
      key: `k${i}:high`, ref: `k${i}`, severity: "high" as const, ts: NOW.toISOString(), lastTs: "", title: "t", detectors: [], delivered: 1, attempts: 1, status: "sent" as const,
    }));
    writeAlertsState(env, entries);
    const back = readAlertsState(env);
    expect(back).toHaveLength(ALERTS_STATE_KEEP);
    expect(back[0]!.ref).toBe("k120");
    expect(back.at(-1)!.ref).toBe("k619");
  });

  it("a corrupt state file reads as empty and is replaced by the next write", () => {
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(alertsStatePath(env), "{not json");
    expect(readAlertsState(env)).toEqual([]);
  });
});

describe("kya-alerts trail source", () => {
  it("a project trail shipped in a cloned repo produces no alert", async () => {
    enable();
    const planted = [neverEvent(10), neverEvent(9), neverEvent(8)].map((e) => JSON.stringify(e)).join("\n");
    mkdirSync(join(project, ".kya"), { recursive: true });
    writeFileSync(legacyTrailPath(project), `${planted}\n`);
    const s = sink();
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(0);
    expect(s.bodies).toHaveLength(0);
    // the same rows in the user-level trail do alert
    seed([neverEvent(10), neverEvent(9)]);
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(1);
  });

  it("events with a bad or far-future timestamp are ignored; small clock skew is kept", async () => {
    enable();
    const future = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(
      globalTrailPath(env),
      [neverEvent(1, { ts: "not-a-date" }), neverEvent(1, { ts: "" }), neverEvent(1, { ts: future(10) }), neverEvent(1, { ts: future(600) })]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const s = sink();
    expect((await runAlertScan(project, env, fastDeps(s))).alerted).toHaveLength(0);
    expect(s.bodies).toHaveLength(0);
    expect(windowEvents([neverEvent(0, { ts: future(4) }), neverEvent(0, { ts: future(6) }), neverEvent(0, { ts: "x" }), neverEvent(500)], NOW, 120)).toHaveLength(1);
  });
});

describe("kya-alerts delivery rules", () => {
  it("alerts on, no webhook: recorded for the report, nothing sent", async () => {
    writeUserConfig({ alerts: { enabled: true } });
    seed([neverEvent(10), neverEvent(9)]);
    const s = sink();
    const r = await runAlertScan(project, env, fastDeps(s));
    expect(r.alerted).toHaveLength(1);
    expect(s.bodies).toHaveLength(0);
    expect(readAlertsState(env)[0]).toMatchObject({ status: "sent", delivered: 0 });
  });

  it("events filter: incident.opened webhooks get no verdicts, DENY webhooks get no incidents, no filter gets both", async () => {
    writeUserConfig({
      alerts: { enabled: true },
      notify: {
        webhooks: [
          { url: "http://127.0.0.1:9/inc", events: ["incident.opened"] },
          { url: "http://127.0.0.1:9/deny", events: ["DENY"] },
          { url: "http://127.0.0.1:9/all" },
        ],
      },
    });
    seed([neverEvent(10), neverEvent(9)]);
    const s = sink();
    await runAlertScan(project, env, fastDeps(s));
    expect(s.bodies.map((b) => b.url).sort()).toEqual(["http://127.0.0.1:9/all", "http://127.0.0.1:9/inc"]);
    const cfg = { notify: { webhooks: [{ url: "http://127.0.0.1:9/inc", events: ["incident.opened"] }] } };
    const v = sink();
    await notifyOnTrailEvent(neverEvent(1), cfg, {}, { fetchImpl: v.fetchImpl, sleep: async () => undefined });
    expect(v.bodies).toHaveLength(0);
    expect(resolveIncidentWebhooks({ notify: { webhooks: [{ url: "http://127.0.0.1:9/deny", events: ["DENY"] }] } })).toHaveLength(0);
  });

  it("each attempt lands in notify-log.jsonl under incident.opened, host only", async () => {
    enable();
    seed([neverEvent(10), neverEvent(9)]);
    await runAlertScan(project, env, fastDeps(sink()));
    const log = readNotifyLog(env);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ verdict: "incident.opened", target: "127.0.0.1:9", ok: true });
  });

  it("reuses the circuit breaker: after 5 failed deliveries the next one is dropped and logged", async () => {
    const s = sink(false);
    const target = [{ url: "http://127.0.0.1:9/hook", events: ["incident.opened"], template: "generic" as const }];
    const alert = buildTestIncidentAlert(NOW);
    const deps = { fetchImpl: s.fetchImpl, sleep: async () => undefined, nowMs: () => NOW.getTime() };
    for (let i = 0; i < 5; i++) await notifyIncident(alert, target, env, deps);
    const before = s.bodies.length;
    expect(await notifyIncident(alert, target, env, deps)).toBe(0);
    expect(s.bodies).toHaveLength(before);
    expect(readNotifyLog(env).at(-1)).toMatchObject({ verdict: "incident.opened", error: "circuit-open", attempt: 0 });
  });

  it("never throws when the trail is missing or the config is broken", async () => {
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(join(home, ".kya", "config.json"), "{broken");
    expect(await runAlertScan(project, { ...env, KYA_ALERTS: "on" }, fastDeps(sink()))).toEqual({ alerted: [], delivered: 0 });
  });
});

describe("kya-alerts payload privacy", () => {
  const FORBIDDEN = ["ARGSHASH-DEADBEEF", "TARGETPATH", "DIFFPREVIEW-LINE", "SESSION-SECRET-777", "private-folder", "/Users/alice", "alice"];

  function alertFor(events: TrailEvent[]) {
    const result = investigateTrail(events);
    const inc = result.incidents[0]!;
    return buildIncidentAlert(inc, events, result.briefs.get(inc.id));
  }

  it("carries title, severity, detectors, counts, times, top 3 summaries, a fix line and the advisory line", () => {
    const events = [neverEvent(10), neverEvent(9), neverEvent(8, { summary: "second" }), neverEvent(7, { summary: "third" }), neverEvent(6, { summary: "fourth" })];
    const a = alertFor(events);
    expect(a).toMatchObject({ severity: "high", detectorIds: ["never-repeat"], findingCount: 1, test: false, advisory: "Local KYA is advisory." });
    expect(a.title).toBe("KYA incident: Never-list tool attempted repeatedly");
    expect(a.counts).toEqual({ allow: 0, hold: 0, deny: 5 });
    expect(a.summaries).toHaveLength(3);
    expect(a.fix).toMatch(/^1\. Keep the never rule/);
    expect(a.firstTs).toBe(minutesAgo(10));
    expect(a.lastTs).toBe(minutesAgo(6));
  });

  it.each(NOTIFY_TEMPLATES)("template %s has no raw args, hashes, paths, session ids or home folders", (template) => {
    const a = alertFor([neverEvent(10), neverEvent(9)]);
    const body = serializeIncidentPayload(template, a);
    for (const f of FORBIDDEN) expect(body).not.toContain(f);
    expect(body).toContain("Local KYA is advisory.");
    expect(body).toContain("Never-list tool attempted repeatedly");
    expect(body).toContain("high");
  });

  it("generic payload names the event and the kind", () => {
    const body = JSON.parse(serializeIncidentPayload("generic", alertFor([neverEvent(10), neverEvent(9)])));
    expect(body).toMatchObject({ kind: "kya.incident.opened", event: "incident.opened", incident: { severity: "high", test: false } });
    expect(Object.keys(body.incident).sort()).toEqual(
      ["advisory", "counts", "detectorIds", "findingCount", "firstTs", "fix", "lastTs", "ref", "severity", "summaries", "test", "title", "tools"].sort(),
    );
  });

  it("a secret in a summary never reaches the body", () => {
    const aws = `${"AKIA"}${"IOSFODNN7EXAMPLE"}`;
    const a = alertFor([neverEvent(10, { summary: `key ${aws}` }), neverEvent(9, { summary: `key ${aws}` })]);
    for (const t of NOTIFY_TEMPLATES) expect(serializeIncidentPayload(t, a)).not.toContain(aws);
  });

  it("the test incident is marked as a test in every template", () => {
    for (const t of NOTIFY_TEMPLATES) expect(serializeIncidentPayload(t, buildTestIncidentAlert(NOW))).toMatch(/\bTEST\b/);
    expect(JSON.parse(serializeIncidentPayload("generic", buildTestIncidentAlert(NOW))).incident.test).toBe(true);
  });
});

function leafStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(leafStrings);
  if (v && typeof v === "object") return Object.values(v).flatMap(leafStrings);
  return [];
}

describe("kya-alerts inert untrusted text", () => {
  const INJECT = "<!channel> click <https://evil.example|here> and <@U123> & [x](https://evil.example) @bob";
  const evil = { ...buildTestIncidentAlert(NOW), title: "KYA incident: Never-list tool attempted repeatedly", summaries: [INJECT], tools: [INJECT], fix: INJECT };

  it("slack: < > & become entities in every text field", () => {
    const body = serializeIncidentPayload("slack", evil);
    expect(body).not.toContain("<!channel>");
    expect(body).not.toContain("<https");
    expect(body).not.toContain("<@U123>");
    expect(body).toContain("&lt;!channel&gt;");
    expect(body).toContain("&lt;https: //evil . example|here&gt;");
    expect(body).toContain("&amp;");
  });

  it("teams: no angle brackets, link syntax or raw URL", () => {
    const texts = leafStrings(JSON.parse(serializeIncidentPayload("teams", evil))).filter((t) => t.includes("channel") || t.includes("evil") || t.includes("bob"));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t).not.toMatch(/[<>|[\]]/);
      expect(t).not.toContain("https://evil");
      expect(t).not.toContain("](");
    }
  });

  it.each(["linear", "jira"] as const)("%s: link, mention and macro syntax is escaped and no URL stays whole", (template) => {
    const parsed = JSON.parse(serializeIncidentPayload(template, evil)) as Record<string, unknown>;
    const text = template === "linear" ? String(parsed["description"]) : String((parsed["fields"] as { description: string }).description);
    expect(text).not.toContain("https://evil");
    expect(text).not.toMatch(/(?<!\\)[<>\[\]@|]/);
    expect(text).toContain("\\<\\!channel\\>");
  });

  it.each(["slack", "teams", "linear", "jira"] as const)("%s: bare domains and URLs are not linkable", (template) => {
    const untrusted = ["www.evil.example", "evil.example/path", "https://evil.example/x", "see docs.example.com"];
    const alert = { ...buildTestIncidentAlert(NOW), firstTs: "", lastTs: "", summaries: untrusted, tools: ["evil.example"], fix: "see docs.example.com and www.evil.example" };
    const texts = leafStrings(JSON.parse(serializeIncidentPayload(template, alert)));
    const mine = texts.filter((t) => /evil|docs|example/.test(t));
    expect(mine.length).toBeGreaterThan(0);
    for (const t of mine) {
      expect(t).not.toMatch(/[a-z0-9]\.[a-z]{2,}/i);
      expect(t).not.toContain("://");
      expect(t).not.toMatch(/www\./i);
    }
    // the text is still readable
    expect(texts.join("\n")).toMatch(/evil \. example/);
  });

  it("generated times stay unbroken in slack, linear and jira", () => {
    const alert = buildTestIncidentAlert(NOW);
    for (const template of ["slack", "linear", "jira"] as const) {
      expect(serializeIncidentPayload(template, alert)).toContain(NOW.toISOString());
    }
  });

  it("the same strings that reach the alert from real events are inert in slack", () => {
    const events = [neverEvent(10, { summary: INJECT }), neverEvent(9, { summary: INJECT })];
    const result = investigateTrail(events);
    const inc = result.incidents[0]!;
    const body = serializeIncidentPayload("slack", buildIncidentAlert(inc, events, result.briefs.get(inc.id)));
    expect(body).not.toContain("<!channel>");
    expect(body).not.toContain("<https");
  });
});

describe("kya alerts command", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
  }

  it("on and off write only the user-level config and keep other keys", async () => {
    writeUserConfig({ alerts: { minSeverity: "medium" }, notify: { webhooks: [] } });
    const a = io();
    expect(await runAlerts({ io: a.io, env, sub: "on", flags: {} })).toBe(0);
    const cfg = JSON.parse(readFileSync(join(home, ".kya", "config.json"), "utf8"));
    expect(cfg).toMatchObject({ alerts: { enabled: true, minSeverity: "medium" }, notify: { webhooks: [] } });
    expect(await runAlerts({ io: a.io, env, sub: "off", flags: {} })).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".kya", "config.json"), "utf8")).alerts.enabled).toBe(false);
  });

  it("status --json lists the setting, the receivers (host only) and the last alerts", async () => {
    enable();
    seed([neverEvent(10), neverEvent(9)]);
    await runAlertScan(project, env, fastDeps(sink()));
    const a = io();
    expect(await runAlerts({ io: a.io, env, sub: "status", flags: { json: true } })).toBe(0);
    const json = JSON.parse(a.out.join("\n"));
    expect(json).toMatchObject({ enabled: true, minSeverity: "high", windowMinutes: 120, receivers: ["127.0.0.1:9"] });
    expect(json.recent).toHaveLength(1);
    expect(json.recent[0]).toMatchObject({ severity: "high", status: "sent" });
    expect(a.out.join("\n")).not.toContain("/hook");
  });

  it("test with no receiver fails with a hint; with a receiver it sends one marked test", async () => {
    const a = io();
    expect(await runAlerts({ io: a.io, env, sub: "test", flags: {} })).toBe(1);
    enable();
    const s = sink();
    const b = io();
    expect(await runAlerts({ io: b.io, env, sub: "test", flags: {}, deps: { fetchImpl: s.fetchImpl, sleep: async () => undefined } })).toBe(0);
    expect(kinds(s)[0]).toMatchObject({ event: "incident.opened", incident: { test: true } });
    expect(readAlertsState(env)).toEqual([]); // a test never counts as an alerted incident
  });

  it("test exits 1 when the receiver rejects", async () => {
    enable();
    const s = sink(false);
    const a = io();
    expect(await runAlerts({ io: a.io, env, sub: "test", flags: {}, deps: { fetchImpl: s.fetchImpl, sleep: async () => undefined } })).toBe(1);
  });
});
