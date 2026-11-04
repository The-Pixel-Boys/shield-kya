/**
 * `kya export --format agent-flow` end to end, plus the OTLP map attributes on the real hook side channel
 * (`kya notify-flush`). Real CLI (dist/cli.js), a fake home under <root>/Users/zz-secret-user, a project outside it,
 * and a local OTLP sink on 127.0.0.1. Fake secrets are built at run time so the repo token scan does not match them.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { symlinkSync } from "node:fs";
import { chmodSync, existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportVerdictSpan, resolveOtlpExportConfig, type VerdictEvent } from "../src/otel/exporter.js";
import { readOptInConfig } from "../src/otel/map-attrs-optin.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const FAKE_USER = "zz-secret-user";
const FAKE_AWS = ["AK", "IA", "ZZQX", "7Q2W", "9E4R", "6T1Y"].join("");
const FAKE_GH = ["gh", "p_", "zzQ9w8E7r6T5y4U3i2O1p0A9s8D7f6G5h4J3"].join("");
const QUERY = ["to", "ken=", "zzq-query-secret"].join("");
/** Raw session ids. The export hashes them. OTLP kya.session_id sends the raw id today (unchanged here). */
const RAW_LIVE = "sess-raw-live-7f3a";
const RAW_LEGACY = "sess-raw-legacy-9c1d";
const ALLOWED_KEYS = new Set(["name", "agent", "sessionId", "tool", "verdict", "reasonCode", "targetClass", "deviceId", "mode"]);

let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kya-export-cli-")));
  home = join(root, "Users", FAKE_USER);
  cwd = join(root, "work", "proj-zz");
  mkdirSync(join(home, ".kya"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  try {
    chmodSync(join(root, "ro"), 0o700);
  } catch {
    /* no read-only dir in this test */
  }
  rmSync(root, { recursive: true, force: true });
});

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home, KYA_NO_BROWSER: "1", KYA_UPDATE_CHECK: "0", KYA_SESSION_ID: RAW_LIVE, ...extra };
}

function kya(args: string[], extra: NodeJS.ProcessEnv = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: baseEnv(extra), timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Async spawn: the OTLP sink lives in this process, so the event loop must stay free while the child runs. */
function kyaAsync(args: string[], extra: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // The project dir as the parent hook sets it (dispatch.ts), so the opt-in check runs its real rules, not the "no project dir" refusal.
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: baseEnv({ KYA_NOTIFY_PROJECT_DIR: cwd, ...extra }), stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const writeTrail = (rows: Record<string, unknown>[]): void => writeFileSync(join(home, ".kya", "trail.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
// 0600 on purpose: the opt-in check refuses a group-writable file, and a CI umask of 002 would make the default 0664.
const writeUserConfig = (cfg: unknown): void => {
  const file = join(home, ".kya", "config.json");
  writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
  chmodSync(file, 0o600);
};
const trailFile = (): string => join(home, ".kya", "trail.jsonl");
const trailRows = (): Record<string, unknown>[] =>
  readFileSync(trailFile(), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);

/** Rich raw targets through the real eval-tool path, then legacy rows (no class) with older times written after them. */
function buildTrail(): void {
  const calls: [string, unknown][] = [
    ["Bash", { command: `cat ${home}/.ssh/id_rsa` }],
    ["Bash", { command: `curl -H "Authorization: Bearer ${FAKE_GH}" "https://api.example.com/v1/items?${QUERY}"` }],
    ["Write", { file_path: `${home}/proj/.env`, content: `AWS_ACCESS_KEY_ID=${FAKE_AWS}\n` }],
    ["Read", { file_path: `${home}/notes/zz-private.txt` }],
    ["WebFetch", { url: `https://docs.example.org/page?${QUERY}` }],
  ];
  for (const [tool, args] of calls) {
    const r = kya(["eval-tool", "--offline", "--tool-id", tool, "--args", JSON.stringify(args)]);
    // The exit code is the verdict (0 allow, 4 hold, ...). Only the trail row matters here.
    expect(r.err).not.toMatch(/^error: /m);
  }
  expect(trailRows()).toHaveLength(calls.length);
  const old = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();
  const legacy = [
    { ts: old(90), sessionId: RAW_LEGACY, product: "claude", project: "proj-zz", toolId: "Read", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline", argsHash: "a1b2c3d4e5f60718", targetPath: `${home}/proj/src/app.ts`, summary: `read ${home}/proj/src/app.ts` },
    { ts: old(120), sessionId: RAW_LEGACY, product: "claude", project: "proj-zz", toolId: "Bash", verdict: "DENY", reasonCode: "NEVER_EVENT", mode: "offline", argsHash: "0918f7e6d5c4b3a2", summary: `rm -rf ${home}` },
    // Raw secret data in the stored text fields: the outputs must drop it, not just never see it.
    { ts: old(100), sessionId: RAW_LEGACY, product: "claude", project: "proj-zz", toolId: "Bash", verdict: "REQUIRE_APPROVE", reasonCode: "SHELL_EXEC", mode: "offline", argsHash: "5a6b7c8d9e0f1a2b", summary: `curl -H "Authorization: Bearer ${FAKE_GH}" https://api.example.com/v1/items?${QUERY}` },
    // A project class names the project folder: fine in the local export, never in an OTLP span.
    { ts: old(97), sessionId: RAW_LEGACY, product: "claude", project: "proj-zz", toolId: "Edit", verdict: "DENY", reasonCode: "POLICY_DENY", mode: "offline", argsHash: "77aa88bb99cc00dd", targetClass: "project:proj-zz/src/**" },
    { ts: old(95), sessionId: RAW_LEGACY, product: "claude", project: "proj-zz", toolId: "Write", verdict: "DENY", reasonCode: "NEVER_SECRET_WRITE", mode: "offline", argsHash: "c0ffee0011223344", targetPath: `${home}/proj/.env`, diffPreview: `+AWS_ACCESS_KEY_ID=${FAKE_AWS}` },
  ];
  appendFileSync(trailFile(), `${legacy.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

interface Line { time: number; type: string; payload: Record<string, unknown> }
const parse = (out: string): Line[] => out.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Line);

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

type Attr = { key: string; value: { stringValue?: string } };
const spanAttrs = (body: string): Record<string, string> => {
  const p = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: { attributes: Attr[] }[] }[] }[] };
  return Object.fromEntries(p.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.map((a) => [a.key, a.value.stringValue ?? ""]));
};

describe("kya export --format agent-flow (real CLI)", { timeout: 120_000 }, () => {
  it("happy path: every line parses, has the agent-flow shape, times start at 0 and never go back, payload keys are the allowed set", () => {
    buildTrail();
    const r = kya(["export", "--format", "agent-flow"]);
    expect(r.code, r.err).toBe(0);
    const lines = parse(r.out);
    expect(lines.length).toBe(2 + 10 * 2); // two sessions spawn, ten rows give a start and an end each
    expect(r.out).not.toContain(RAW_LIVE);
    expect(r.out).not.toContain(RAW_LEGACY);
    expect(lines[0]!.time).toBe(0);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      expect(Object.keys(l)).toEqual(["time", "type", "payload"]);
      expect(typeof l.time).toBe("number");
      if (i > 0) expect(l.time).toBeGreaterThanOrEqual(lines[i - 1]!.time);
      expect(["agent_spawn", "tool_call_start", "tool_call_end"]).toContain(l.type);
      for (const k of Object.keys(l.payload)) expect(ALLOWED_KEYS.has(k), k).toBe(true);
    }
    // The legacy rows are the oldest, though they come last in the file.
    expect(lines[0]!.type).toBe("agent_spawn");
    expect(lines[1]!.payload.tool).toBe("Bash");
    expect(lines[1]!.payload.verdict).toBe("DENY");
    const calls = lines.filter((l) => l.type === "tool_call_start");
    expect(calls.every((c) => typeof c.payload.targetClass === "string" && c.payload.targetClass !== "")).toBe(true);
    expect(lines.filter((l) => l.type === "agent_spawn")).toHaveLength(2);
  });

  it("determinism: two runs give the same bytes, and --out writes the same bytes as stdout", () => {
    buildTrail();
    const a = kya(["export", "--format", "agent-flow"]);
    const b = kya(["export", "--format", "agent-flow", "--days", "3"]);
    expect(a.code).toBe(0);
    expect(a.out).not.toBe("");
    expect(b.out).toBe(a.out);
    const r = kya(["export", "--format", "agent-flow", "--out", "flow.jsonl"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("");
    expect(readFileSync(join(cwd, "flow.jsonl"), "utf8")).toBe(a.out);
    expect(statSync(join(cwd, "flow.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("--out refuses to replace a file without --force (exit 2); --force replaces it with mode 0600", () => {
    buildTrail();
    const target = join(cwd, "old.jsonl");
    writeFileSync(target, "keep me\n", { mode: 0o644 });
    const r = kya(["export", "--format", "agent-flow", "--out", "old.jsonl"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("exists. Pass --force to replace it.");
    expect(readFileSync(target, "utf8")).toBe("keep me\n");
    const f = kya(["export", "--format", "agent-flow", "--out", "old.jsonl", "--force"]);
    expect(f.code, f.err).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(kya(["export", "--format", "agent-flow"]).out);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("--out without --force never replaces or follows a symlink at the target (exclusive create)", () => {
    buildTrail();
    const outDir = join(root, "outdir");
    mkdirSync(outDir);
    const victim = join(root, "victim.txt");
    symlinkSync(victim, join(outDir, "dangling.jsonl"));
    const d = kya(["export", "--format", "agent-flow", "--out", join(outDir, "dangling.jsonl")]);
    expect(d.code).toBe(2);
    expect(d.err).toContain("exists. Pass --force to replace it.");
    expect(existsSync(victim)).toBe(false);
    writeFileSync(victim, "victim\n");
    symlinkSync(victim, join(outDir, "live.jsonl"));
    const l = kya(["export", "--format", "agent-flow", "--out", join(outDir, "live.jsonl")]);
    expect(l.code).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe("victim\n");
    const n = kya(["export", "--format", "agent-flow", "--out", join(outDir, "new.jsonl")]);
    expect(n.code, n.err).toBe(0);
    expect(statSync(join(outDir, "new.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("U+2028 and U+2029 in a tool name: the row is not hidden, each output line is escaped, and a long tool name is hashed", () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    const odd = `mcp__evil\u2028tool\u2029x`;
    writeTrail([
      { ts, sessionId: RAW_LIVE, product: "claude", toolId: odd, verdict: "DENY", reasonCode: "POLICY_DENY", mode: "offline" },
      { ts, sessionId: RAW_LIVE, product: "claude", toolId: `mcp__${"t".repeat(5000)}`, verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" },
    ]);
    const r = kya(["export", "--format", "agent-flow"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toMatch(/[\u2028\u2029]/);
    const lines = parse(r.out);
    expect(lines).toHaveLength(1 + 2 * 2);
    expect(lines[1]!.payload.tool).toBe(odd);
    // A tool name over 200 characters is replaced by its hash, never cut (a cut can keep a secret-shaped prefix).
    expect(lines[3]!.payload.tool).toBe(`tool:${createHash("sha256").update(`mcp__${"t".repeat(5000)}`, "utf8").digest("hex").slice(0, 16)}`);
    const map = kya(["map", "--json"]);
    expect((JSON.parse(map.out) as { view: { rowsSkipped: number; rowsRead: number } }).view).toMatchObject({ rowsRead: 2, rowsSkipped: 0 });
  });

  it("--session keeps one session only (the raw id given, a hashed id printed)", () => {
    buildTrail();
    const r = kya(["export", "--format", "agent-flow", "--session", RAW_LEGACY]);
    expect(r.code).toBe(0);
    const lines = parse(r.out);
    expect(lines).toHaveLength(1 + 5 * 2);
    expect(new Set(lines.map((l) => l.payload.sessionId)).size).toBe(1);
    expect(r.out).not.toContain(RAW_LEGACY);
  });

  it("denied: unknown --format, missing --format, bad --days, unwritable --out", () => {
    buildTrail();
    for (const args of [["export", "--format", "jaeger"], ["export"], ["export", "--format"]]) {
      const r = kya(args);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err).toContain("--format must be one of: agent-flow");
    }
    for (const d of ["0", "-1", "abc", "1.5"]) {
      const r = kya(["export", "--format", "agent-flow", "--days", d]);
      expect(r.code, d).toBe(2);
      expect(r.err).toContain("--days must be a positive whole number");
    }
    const ro = join(root, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    const r = kya(["export", "--format", "agent-flow", "--out", join(ro, "flow.jsonl")]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/^error: /);
    expect(existsSync(join(ro, "flow.jsonl"))).toBe(false);
  });

  it("empty: no trail file, or no row in the window, gives no output, exit 0 and a note on stderr", () => {
    const none = kya(["export", "--format", "agent-flow", "--out", "flow.jsonl"]);
    expect(none.code).toBe(0);
    expect(none.out).toBe("");
    expect(none.err).toContain("No events in the last 3 days.");
    expect(existsSync(join(cwd, "flow.jsonl"))).toBe(false);
    writeFileSync(trailFile(), `${JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", sessionId: "s", toolId: "Read", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" })}\n`);
    const old = kya(["export", "--format", "agent-flow"]);
    expect(old.code).toBe(0);
    expect(old.out).toBe("");
  });
});

describe("privacy: agent-flow export and OTLP map attributes carry classes only (real CLI)", { timeout: 180_000 }, () => {
  it("no fake home, secret, query string, argsHash, salt, cwd or host name in any output; deviceId equals kya map --json", async () => {
    buildTrail();
    const rows = trailRows();
    const argsHashes = rows.map((r) => r.argsHash).filter((h): h is string => typeof h === "string" && h !== "");
    expect(argsHashes.length).toBeGreaterThanOrEqual(5);
    const rawTrail = readFileSync(trailFile(), "utf8");
    // The fixture is rich: the trail itself holds each raw value the outputs must drop.
    for (const raw of [FAKE_USER, FAKE_AWS, FAKE_GH, QUERY, ...argsHashes]) expect(rawTrail.includes(raw), `trail lacks ${raw.slice(0, 6)}`).toBe(true);

    const flow = kya(["export", "--format", "agent-flow"]);
    expect(flow.code, flow.err).toBe(0);

    // Real hook side channel: the endpoint from the config under $HOME. That file is not the passwd home, so no map attributes.
    const real = await sink();
    writeUserConfig({ otlpExport: { endpoint: real.url, mapAttrs: true } });
    for (const row of rows) {
      const code = await kyaAsync(["notify-flush"], { KYA_NOTIFY_EVENT: JSON.stringify(row) });
      expect(code).toBe(0);
    }
    expect(real.bodies).toHaveLength(rows.length);
    for (const b of real.bodies) expect(Object.keys(spanAttrs(b))).not.toContain("kya.device");
    // Map attributes on: the same rows through the exporter, with the validated opt-in file from the passwd-home seam.
    const s = await sink();
    writeUserConfig({ otlpExport: { endpoint: s.url, mapAttrs: true } });
    const optIn = readOptInConfig(cwd, { passwdHome: () => home });
    const cfg = resolveOtlpExportConfig({ KYA_HOME: home }, optIn, optIn);
    expect(cfg?.mapAttrs).toBe(true);
    for (const row of rows) await exportVerdictSpan(row as unknown as VerdictEvent, cfg, { KYA_HOME: home });
    expect(s.bodies).toHaveLength(rows.length);

    const salt = readFileSync(join(home, ".kya", "device-salt"), "utf8").trim();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    const banned = [FAKE_USER, FAKE_AWS, FAKE_GH, QUERY, "zzq-query-secret", "?to", salt, cwd, root, ...argsHashes];
    const host = hostname();
    if (host.length >= 4) banned.push(host);
    const all = [flow.out, flow.err, ...real.bodies, ...s.bodies].join("\n");
    for (const b of banned) expect(all.includes(b), `output holds ${b.slice(0, 12)}`).toBe(false);
    for (const k of ["argsHash", "targetPath", "summary", "diffPreview", "args", "cwd"]) expect(all).not.toContain(`"${k}"`);

    const map = kya(["map", "--json"]);
    expect(map.code).toBe(0);
    const graph = JSON.parse(map.out) as { nodes: { id: string; kind: string; sessionHash?: string | null }[] };
    const devices = graph.nodes.filter((n) => n.kind === "device" && n.id !== "device:local").map((n) => n.id.slice("device:".length));
    expect(devices).toHaveLength(1);
    const dev = devices[0]!;
    expect(dev).toMatch(/^[0-9a-f]{16}$/);
    const lines = parse(flow.out);
    const flowDevices = new Set(lines.map((l) => l.payload.deviceId).filter((d) => d !== undefined));
    expect([...flowDevices]).toEqual([dev]);
    for (const b of s.bodies) expect(spanAttrs(b)["kya.device"]).toBe(dev);
    // Each span is one row in order (sequential spawns). A row with a stored class sends it; a legacy row sends none.
    const sentClasses = s.bodies.map((b) => spanAttrs(b)["kya.target.class"]);
    expect(sentClasses).toEqual(rows.map((r) => (typeof r.targetClass === "string" && r.targetClass.startsWith("project:") ? "project" : r.targetClass)));
    expect(sentClasses).toContain("project");
    // Opt-in on: kya.session_id is the export's session hash, and no raw host session id is in any span.
    expect(rawTrail.includes(RAW_LIVE) && rawTrail.includes(RAW_LEGACY)).toBe(true);
    for (const b of s.bodies) for (const raw of [RAW_LIVE, RAW_LEGACY]) expect(b).not.toContain(raw);
    const sentSessions = new Set(s.bodies.map((b) => spanAttrs(b)["kya.session_id"]));
    expect(sentSessions).toEqual(new Set(parse(flow.out).map((l) => l.payload.sessionId)));
    for (const id of sentSessions) expect(id).toMatch(/^[0-9a-f]{16}$/);
    // Opt-in off (real hook side channel): the raw id as before.
    expect(real.bodies.some((b) => spanAttrs(b)["kya.session_id"] === RAW_LIVE)).toBe(true);
    for (const b of s.bodies) expect(b).not.toContain("proj-zz");
    expect(sentClasses.filter((c) => c !== undefined).length).toBeGreaterThanOrEqual(5);
    const mapSessions = new Set(graph.nodes.filter((n) => n.kind === "agent").map((n) => n.sessionHash));
    expect(new Set(lines.map((l) => l.payload.sessionId))).toEqual(mapSessions);
  });

  it("repo-controlled sources cannot turn otlpExport.mapAttrs on (real notify-flush, fake sink)", async () => {
    buildTrail();
    const row = JSON.stringify(trailRows()[0]!);
    const repoSink = await sink();
    const optIn = JSON.stringify({ otlpExport: { endpoint: repoSink.url, mapAttrs: true } });
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    // 1. Env from a repo's .claude/settings.json: endpoint plus the old toggle name.
    expect(await kyaAsync(["notify-flush"], { KYA_NOTIFY_EVENT: row, KYA_OTLP_EXPORT_ENDPOINT: repoSink.url, KYA_OTLP_MAP_ATTRS: "on" })).toBe(0);
    // 2. A committed project .kya/config.json with endpoint and mapAttrs.
    writeFileSync(join(cwd, ".kya", "config.json"), optIn);
    expect(await kyaAsync(["notify-flush"], { KYA_NOTIFY_EVENT: row })).toBe(0);
    // 3. KYA_HOME=. makes that project file the "global" config.
    expect(await kyaAsync(["notify-flush"], { KYA_NOTIFY_EVENT: row, KYA_HOME: "." })).toBe(0);
    // 4. HOME=. (KYA_HOME empty, so the home comes from $HOME).
    expect(await kyaAsync(["notify-flush"], { KYA_NOTIFY_EVENT: row, KYA_HOME: "", HOME: "." })).toBe(0);
    // 5. KYA_HOME and HOME both an absolute repo-controlled dir with a valid-looking config.
    const planted = join(root, "planted");
    mkdirSync(join(planted, ".kya"), { recursive: true });
    writeFileSync(join(planted, ".kya", "config.json"), optIn, { mode: 0o600 });
    rmSync(join(cwd, ".kya", "config.json"));
    expect(await kyaAsync(["notify-flush"], { KYA_NOTIFY_EVENT: row, KYA_HOME: planted, HOME: planted })).toBe(0);
    expect(repoSink.bodies).toHaveLength(5);
    for (const b of repoSink.bodies) {
      const keys = Object.keys(spanAttrs(b));
      expect(keys).not.toContain("kya.device");
      expect(keys).not.toContain("kya.target.class");
    }
  });

  it("toggle off on the real hook side channel: no map attribute in the span", async () => {
    buildTrail();
    const s = await sink();
    const row = trailRows()[0]!;
    expect(await kyaAsync(["notify-flush"], { KYA_NOTIFY_EVENT: JSON.stringify(row), KYA_OTLP_EXPORT_ENDPOINT: s.url })).toBe(0);
    expect(s.bodies).toHaveLength(1);
    const keys = Object.keys(spanAttrs(s.bodies[0]!));
    expect(keys).not.toContain("kya.target.class");
    expect(keys).not.toContain("kya.device");
    expect(keys.slice(0, 6)).toEqual(["gen_ai.tool.name", "kya.verdict", "kya.reason_code", "kya.mode", "kya.host", "kya.session_id"]);
  });
});
