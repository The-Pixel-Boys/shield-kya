/**
 * OTLP map attributes (`kya.target.class`, `kya.device`): opt-in, default off.
 * The golden file was written from the exporter before the attributes existed, so the off path must match it byte for byte.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerdictTracePayload, exportVerdictSpan, resolveOtlpExportConfig, type VerdictEvent } from "../src/otel/exporter.js";
import { deviceId, installSalt } from "../src/device-id.js";
import { sessionHash } from "../src/map/build.js";
import { optInRefusal, readOptInConfig } from "../src/otel/map-attrs-optin.js";
import { CLI_VERSION } from "../src/version.js";

const GOLDEN = readFileSync(join(import.meta.dirname, "fixtures", "otlp", "verdict-span-golden.json"), "utf8");

/** The golden event has the map fields set, so a default-on toggle changes the bytes. */
const EVENT = {
  ts: "2026-10-09T12:00:00.000Z",
  sessionId: "sess-1",
  toolId: "Bash",
  verdict: "DENY",
  reasonCode: "NEVER_SECRET_READ",
  mode: "offline",
  host: "ide",
  tokensIn: 120,
  tokensOut: 45,
  targetClass: "secret:ssh-key",
  deviceId: "0123456789abcdef",
} as VerdictEvent;

/** Random ids and the package version are the only parts that change from run to run. */
function normalise(body: string): string {
  const p = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: { traceId: string; spanId: string }[] }[] }[] };
  const s = p.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  s.traceId = "0".repeat(32);
  s.spanId = "0".repeat(16);
  return JSON.stringify(p).split(JSON.stringify(CLI_VERSION)).join('"<version>"');
}

function attrsOf(body: string): Record<string, string> {
  const p = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: { attributes: { key: string; value: { stringValue?: string; intValue?: string } }[] }[] }[] }[] };
  const out: Record<string, string> = {};
  for (const a of p.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes) out[a.key] = a.value.stringValue ?? a.value.intValue ?? "";
  return out;
}

const servers: Server[] = [];
async function sink(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

const homes: string[] = [];
const tenv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const home = mkdtempSync(join(tmpdir(), "kya-otel-map-"));
  homes.push(home);
  return { KYA_HOME: home, ...extra };
};
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

/** The user-level config that turns the map attributes on for its own endpoint. */
const userOn = (endpoint: string) => ({ otlpExport: { endpoint, mapAttrs: true } });

describe("OTLP map attributes (otlpExport.mapAttrs, feature kya-otlp-map-attrs)", () => {
  it("toggle off: the payload is byte-identical to the golden file from before the change", () => {
    expect(normalise(JSON.stringify(buildVerdictTracePayload(EVENT)))).toBe(GOLDEN);
  });

  it("toggle off: the POST body at a real sink is byte-identical to the golden file", async () => {
    const s = await sink();
    const env = tenv({ KYA_OTLP_EXPORT_ENDPOINT: s.url });
    await exportVerdictSpan(EVENT, resolveOtlpExportConfig(env, {}), env);
    expect(s.bodies).toHaveLength(1);
    expect(normalise(s.bodies[0]!)).toBe(GOLDEN);
  });

  it("toggle on by the user-level config and its own endpoint: kya.target.class and kya.device come after the old attributes", async () => {
    const s = await sink();
    const env = tenv();
    const user = userOn(s.url);
    const cfg = resolveOtlpExportConfig(env, user, user);
    expect(cfg?.mapAttrs).toBe(true);
    await exportVerdictSpan(EVENT, cfg, env);
    const keys = Object.keys(attrsOf(s.bodies[0]!));
    expect(keys.slice(-2)).toEqual(["kya.target.class", "kya.device"]);
    expect(attrsOf(s.bodies[0]!)["kya.target.class"]).toBe("secret:ssh-key");
    expect(attrsOf(s.bodies[0]!)["kya.device"]).toBe("0123456789abcdef");
  });

  it("repo-controlled sources cannot turn it on: env toggle, project mapAttrs, env endpoint, project endpoint", () => {
    const ep = "http://127.0.0.1:4318";
    // Env toggle (a repo's .claude/settings.json) is not read at all.
    expect(resolveOtlpExportConfig({ KYA_OTLP_EXPORT_ENDPOINT: ep, KYA_OTLP_MAP_ATTRS: "on" }, {}, {})?.mapAttrs).toBeUndefined();
    // Project config mapAttrs (merged over the user file) is not read.
    const project = { otlpExport: { endpoint: ep, mapAttrs: true } };
    expect(resolveOtlpExportConfig({}, project, {})?.mapAttrs).toBeUndefined();
    // User opt-in, but the env endpoint wins: the receiver is not the user's.
    expect(resolveOtlpExportConfig({ KYA_OTLP_EXPORT_ENDPOINT: "https://collector.attacker.example" }, userOn(ep), userOn(ep))?.mapAttrs).toBeUndefined();
    // Any env endpoint turns it off, even one equal to the user's own: the rule is "endpoint from the user file".
    expect(resolveOtlpExportConfig({ KYA_OTLP_EXPORT_ENDPOINT: ep }, userOn(ep), userOn(ep))?.mapAttrs).toBeUndefined();
    // User opt-in, but the project config overrides the endpoint.
    const merged = { otlpExport: { endpoint: "https://collector.attacker.example" } };
    expect(resolveOtlpExportConfig({}, merged, userOn(ep))?.mapAttrs).toBeUndefined();
    // A non-boolean user value stays off.
    expect(resolveOtlpExportConfig({}, { otlpExport: { endpoint: ep, mapAttrs: "yes" } }, { otlpExport: { endpoint: ep, mapAttrs: "yes" } })?.mapAttrs).toBeUndefined();
  });

  it("toggle on with a full trail row as the event: no argsHash, path, summary or preview leaves", () => {
    const row = { ...EVENT, argsHash: "feedbeefcafe0001", targetPath: "/Users/zz-user/.ssh/id_rsa", summary: "cat /Users/zz-user/.ssh/id_rsa", diffPreview: "zz-preview" };
    const body = JSON.stringify(buildVerdictTracePayload(row, { mapAttrs: true }));
    for (const bad of ["feedbeefcafe0001", "zz-user", "zz-preview", "argsHash", "targetPath"]) expect(body).not.toContain(bad);
  });

  it("toggle on: a project class goes out as the family only, never the folder name", () => {
    const body = JSON.stringify(buildVerdictTracePayload({ ...EVENT, targetClass: "project:acme-merger/src/**" }, { mapAttrs: true }));
    expect(attrsOf(body)["kya.target.class"]).toBe("project");
    expect(body).not.toContain("acme-merger");
  });

  it("toggle on: a class longer than 128 characters is dropped", () => {
    const body = JSON.stringify(buildVerdictTracePayload({ ...EVENT, targetClass: `${"a".repeat(100)}:${"b".repeat(40)}` }, { mapAttrs: true }));
    expect(body).not.toContain("kya.target.class");
  });

  it("toggle on: a bad device id or a class with the wrong shape is dropped, not sent", () => {
    const body = JSON.stringify(buildVerdictTracePayload({ ...EVENT, deviceId: "HOSTNAME-1", targetClass: "/etc/passwd" }, { mapAttrs: true }));
    expect(body).not.toContain("kya.device");
    expect(body).not.toContain("kya.target.class");
    expect(body).not.toContain("HOSTNAME-1");
    expect(body).not.toContain("/etc/passwd");
  });

  it("toggle on: kya.session_id is the map session hash; the raw id is in no part of the payload", async () => {
    const raw = "raw-host-session-7f3a9c2e";
    const ev = { ...EVENT, sessionId: raw, product: "claude" } as VerdictEvent;
    expect(JSON.stringify(ev)).toContain(raw);
    const s = await sink();
    const env = tenv();
    await exportVerdictSpan(ev, resolveOtlpExportConfig(env, userOn(s.url), userOn(s.url)), env);
    expect(s.bodies[0]).not.toContain(raw);
    expect(attrsOf(s.bodies[0]!)["kya.session_id"]).toBe(sessionHash(installSalt(env)!, "claude", raw));
    // A direct build with map attributes and no hash drops the attribute rather than send the raw id.
    expect(JSON.stringify(buildVerdictTracePayload(ev, { mapAttrs: true }))).not.toContain(raw);
    // Off: the raw id, as before.
    expect(attrsOf(JSON.stringify(buildVerdictTracePayload(ev)))["kya.session_id"]).toBe(raw);
  });

  it("toggle on, row without deviceId: the span gets this install's device id (16 hex)", async () => {
    const s = await sink();
    const env = tenv();
    const { deviceId: _drop, ...noDevice } = EVENT;
    await exportVerdictSpan(noDevice, resolveOtlpExportConfig(env, userOn(s.url), userOn(s.url)), env);
    const dev = attrsOf(s.bodies[0]!)["kya.device"];
    expect(dev).toMatch(/^[0-9a-f]{16}$/);
    expect(dev).toBe(deviceId(env));
  });
});

describe("map-attribute opt-in file: passwd home only, with owner, mode, project-dir and symlink checks", () => {
  const ep = "http://127.0.0.1:4318";
  const body = JSON.stringify({ otlpExport: { endpoint: ep, mapAttrs: true } });
  function passwdHome(): { home: string; file: string; project: string } {
    const root = mkdtempSync(join(tmpdir(), "kya-optin-"));
    homes.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, ".kya"), { recursive: true });
    const file = join(home, ".kya", "config.json");
    writeFileSync(file, body, { mode: 0o600 });
    const project = join(root, "proj");
    mkdirSync(project);
    return { home, file, project };
  }

  it("positive: a 0600 file owned by this user in the passwd home turns it on, with that file's endpoint", () => {
    const h = passwdHome();
    const cfg = readOptInConfig(h.project, { passwdHome: () => h.home });
    const r = resolveOtlpExportConfig({}, cfg, cfg);
    expect(r?.mapAttrs).toBe(true);
    expect(r?.endpoint).toBe(ep);
  });

  it("the default path ignores HOME and KYA_HOME: a valid config there is not read", () => {
    const h = passwdHome();
    const saved = { HOME: process.env.HOME, KYA_HOME: process.env.KYA_HOME };
    process.env.HOME = h.home;
    process.env.KYA_HOME = h.home;
    try {
      const cfg = readOptInConfig(h.project);
      expect((cfg as { otlpExport?: { endpoint?: string } } | undefined)?.otlpExport?.endpoint).not.toBe(ep);
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
      if (saved.KYA_HOME === undefined) delete process.env.KYA_HOME;
      else process.env.KYA_HOME = saved.KYA_HOME;
    }
  });

  it("refuses a file under the cwd or the project dir", () => {
    const h = passwdHome();
    expect(optInRefusal(h.file, h.home, h.home)).toBe("under the project dir");
    expect(readOptInConfig(join(h.home, ".kya"), { passwdHome: () => h.home })).toBeUndefined();
  });

  it("refuses a group- or world-writable file (0666, 0620)", () => {
    const h = passwdHome();
    chmodSync(h.file, 0o666);
    expect(optInRefusal(h.file, h.home, h.project)).toBe("group or world writable");
    chmodSync(h.file, 0o620);
    expect(readOptInConfig(h.project, { passwdHome: () => h.home })).toBeUndefined();
  });

  it("refuses a file owned by another user (stubbed stat)", () => {
    const h = passwdHome();
    const real = statSync(h.file);
    const other = (p: string): Stats => (p.endsWith("config.json") ? ({ ...real, uid: real.uid + 1, isFile: () => true } as unknown as Stats) : statSync(p));
    expect(optInRefusal(h.file, h.home, h.project, { stat: other })).toBe("owned by another user");
    expect(readOptInConfig(h.project, { passwdHome: () => h.home, stat: other })).toBeUndefined();
  });

  it("refuses a symlink that resolves outside the passwd home; accepts one inside it", () => {
    const h = passwdHome();
    const outside = join(h.project, "..", "elsewhere.json");
    writeFileSync(outside, body, { mode: 0o600 });
    rmSync(h.file);
    symlinkSync(outside, h.file);
    expect(optInRefusal(h.file, h.home, h.project)).toBe("symlink outside the home");
    rmSync(h.file);
    const inside = join(h.home, "kya-config.json");
    writeFileSync(inside, body, { mode: 0o600 });
    symlinkSync(inside, h.file);
    expect(optInRefusal(h.file, h.home, h.project)).toBeUndefined();
  });

  it("Windows: no owner or mode check, but the project-dir check still runs", () => {
    const h = passwdHome();
    chmodSync(h.file, 0o666);
    expect(optInRefusal(h.file, h.home, h.project, { platform: "win32" })).toBeUndefined();
    expect(optInRefusal(h.file, h.home, h.home, { platform: "win32" })).toBe("under the project dir");
  });
});
