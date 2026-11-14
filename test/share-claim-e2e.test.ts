/**
 * Feature kya-share-claim (F4): the report's "Share this report" button and the hint to run kya login. A claim
 * never links a computer: nothing identifying the install is sent, no token is kept, no key is traded.
 * Real-stack e2e: the built dist/cli.js (run `pnpm build` first) against a temp HOME, a temp KYA_HOME and a temp
 * project. The hosted side is a loopback recorder that records every request (headers and bodies) and answers
 * like the hosted API; the real hosted code is covered by ShareClaimE2eIT in the monorepo. KYA_SHARE_URL always
 * points at the recorder or at a dead port, never at production. Never touches the real home.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { join } from "node:path";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const posix = process.platform !== "win32";

interface Seen {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A hosted double: records everything, answers share creates. */
class Hosted {
  readonly seen: Seen[] = [];
  /** Origin of the url in the share answer. Default: this server. */
  answerOrigin: string | undefined;
  private server!: Server;
  base = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const path = req.url ?? "";
        this.seen.push({ path, headers: req.headers, body });
        res.setHeader("Content-Type", "application/json");
        if (path.startsWith("/broken")) {
          res.writeHead(500).end("{}");
          return;
        }
        if (req.method === "POST" && path === "/api/v1/share/reports") {
          const origin = this.answerOrigin ?? this.base;
          res.writeHead(201).end(JSON.stringify({ id: "rid123", url: `${origin}/r/rid123`, expiresAt: "2026-11-21T08:00:00Z" }));
          return;
        }
        res.writeHead(404).end("{}");
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  count(path: string): number {
    return this.seen.filter((s) => s.path === path).length;
  }
}

interface Fx {
  base: string;
  home: string;
  proj: string;
}

const dirs: string[] = [];
const fixtures: Fx[] = [];
let hosted: Hosted;

beforeEach(async () => {
  hosted = new Hosted();
  await hosted.start();
});

afterEach(async () => {
  // The report daemon that `kya start` leaves must not outlive the test.
  for (const fx of fixtures.splice(0)) kya(fx, ["stop"]);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await hosted.stop();
});

function fixture(opts: { events?: number } = {}): Fx {
  const base = mkdtempSync(join(tmpdir(), "kya-f4-"));
  dirs.push(base);
  const home = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(join(home, ".kya"), { recursive: true });
  const rows: string[] = [];
  const now = Date.now();
  for (let i = 0; i < (opts.events ?? 12); i++) {
    const denied = i % 4 === 0;
    rows.push(JSON.stringify({
      ts: new Date(now - i * 1000).toISOString(),
      sessionId: `f4-session-${i % 3}`,
      toolId: denied ? "Bash" : "Read",
      verdict: denied ? "DENY" : "ALLOW",
      reasonCode: denied ? "NEVER_EVENT" : "LOW_RISK_READ",
      mode: "hold",
      summary: "rm -rf /home/alice/secret-project",
      targetPath: "/home/alice/secret-project/.env",
    }));
  }
  writeFileSync(join(home, ".kya", "trail.jsonl"), `${rows.join("\n")}\n`);
  const fx = { base, home, proj };
  fixtures.push(fx);
  return fx;
}

function env(fx: Fx, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fx.home,
    KYA_HOME: fx.home,
    KYA_NO_BROWSER: "1",
    KYA_SKIP_NODE_CHECK: "1",
    KYA_OFFLINE: "1",
    KYA_TELEMETRY: "0",
    KYA_SEMANTIC: "off",
    KYA_ALERTS: "off",
    DO_NOT_TRACK: "1",
    KYA_SHARE_URL: hosted.base,
  };
  for (const k of ["CI", "KYA_YES", "KYA_API_KEY", "SHIELD_API_KEY", "KYA_BASE_URL"]) delete e[k];
  return { ...e, ...extra };
}

function kya(fx: Fx, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [cliJs, ...args], { cwd: fx.proj, encoding: "utf8", timeout: 60_000, env: env(fx, extra) });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

/** Async spawn: the hosted recorder lives in this process, so a blocking spawn would starve it. */
function kyaAsync(fx: Fx, args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string; all: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliJs, ...args], { cwd: fx.proj, env: env(fx, extra) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err, all: `${out}${err}` }));
  });
}

/** `kya start` and the loopback report URL (with its token) that it prints. */
function startReport(fx: Fx, extra: Record<string, string> = {}): { url: string; base: string; token: string } {
  const r = kya(fx, ["start", "--yes", "--no-gate"], extra);
  expect(r.code, r.all).toBe(0);
  const url = /report: (\S+)/.exec(r.out)?.[1];
  expect(url, r.all).toBeTruthy();
  const u = new URL(url!);
  return { url: url!, base: u.origin, token: u.searchParams.get("t")! };
}

async function post(rep: { base: string; token: string }, path: string, headers: Record<string, string> = {}, token = rep.token) {
  const res = await fetch(`${rep.base}${path}?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe.skipIf(!posix)("share and claim (real CLI, temp HOME and KYA_HOME, hosted recorder)", () => {
  it("the live report header has a Share this report button, with a place for the result", async () => {
    const fx = fixture();
    const rep = startReport(fx);
    const html = await (await fetch(rep.url)).text();
    expect(html).toContain('id="share-report-btn"');
    expect(html).toContain(">Share this report</button>");
    expect(html).toContain('id="share-report-result"');
    // The button sits in the page header, before the first zone.
    expect(html.indexOf('id="share-report-btn"')).toBeLessThan(html.indexOf('<section class="zone" id="overview"'));
  });

  it("the static report file has no share button (no server to answer it)", () => {
    const fx = fixture();
    const r = kya(fx, ["receipt"]);
    expect(r.code, r.all).toBe(0);
    const html = readFileSync(join(fx.proj, ".kya", "receipts", "last-3d.html"), "utf8");
    expect(html).not.toContain("share-report-btn");
  });

  it("the button's endpoint shares the redacted summary and returns only the public URL", async () => {
    const fx = fixture();
    const rep = startReport(fx);
    const res = await post(rep, "/action/share");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, url: `${hosted.base}/r/rid123`, expiresAt: "2026-11-21T08:00:00Z" });

    // What left the machine: counts and labels only. No command, path, session id or project.
    const create = hosted.seen.find((s) => s.path === "/api/v1/share/reports")!;
    expect(create.body).not.toContain("secret-project");
    expect(create.body).not.toContain("alice");
    expect(create.body).not.toContain("f4-session");
    expect(create.body).not.toContain(".env");
    const payload = JSON.parse(create.body) as { stats: { total: number } };
    expect(payload.stats.total).toBe(12);
  });

  it("a share carries no capability and nothing that identifies the install: no header, no token file, no key trade", async () => {
    const fx = fixture();
    const rep = startReport(fx);
    await post(rep, "/action/share");
    await post(rep, "/action/share");

    for (const s of hosted.seen) {
      expect(Object.keys(s.headers).filter((h) => /link|device|install|token/i.test(h))).toEqual([]);
    }
    expect(hosted.seen.map((s) => s.path)).toEqual(["/api/v1/share/reports", "/api/v1/share/reports"]);
    expect(existsSync(join(fx.home, ".kya", "share-link-token"))).toBe(false);
    expect(existsSync(join(fx.home, ".kya", "hosted-credentials.json"))).toBe(false);
    // The earlier poll endpoint is gone.
    expect((await post(rep, "/action/share-link")).status).toBe(404);
  });

  it("the result block points to the public page to claim and to kya login, and builds no link from the server's answer", async () => {
    const fx = fixture();
    const rep = startReport(fx);
    const html = await (await fetch(rep.url)).text();
    expect(html).toContain("Open the page to claim it, keep it and get a weekly summary");
    expect(html).toContain("To connect this computer to your account, run kya login.");
    expect(html).toContain("a.href = d.url");
    // Only an http(s) link is shown or opened.
    expect(html).toContain("if (!/^https?:/.test(String(d.url)))");
    expect(html).not.toContain("claimUrl");
    expect(html).not.toContain("#c=");
    // Every inline script of the live page still parses (a bad escape in a template string would break them all).
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new vm.Script(src)).not.toThrow();
  });

  it("a share answer whose link is on another origin is an error, not a link", async () => {
    const fx = fixture();
    const rep = startReport(fx);
    hosted.answerOrigin = "https://evil.example";
    const res = await post(rep, "/action/share");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(String(res.json.error)).toContain("not on the server that was asked");
    expect(res.json.url).toBeUndefined();
    hosted.answerOrigin = "javascript:alert(1)//";
    const res2 = await post(rep, "/action/share");
    expect(res2.json.ok).toBe(false);
  });

  it("with no network the button's endpoint reports an error and the page keeps working", async () => {
    const fx = fixture();
    const rep = startReport(fx, { KYA_SHARE_URL: "http://127.0.0.1:1" });
    const res = await post(rep, "/action/share");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(String(res.json.error)).toContain("share failed");
    const page = await fetch(rep.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="share-report-btn"');
  });

  it("a hosted error (HTTP 500 from the share endpoint) is shown as an error, not as a link", async () => {
    const fx = fixture();
    const rep = startReport(fx, { KYA_SHARE_URL: `${hosted.base}/broken` });
    const res = await post(rep, "/action/share");
    expect(res.json.ok).toBe(false);
    expect(res.json.url).toBeUndefined();
  });

  it("the share endpoint needs the page token and a loopback client", async () => {
    const fx = fixture();
    const rep = startReport(fx);
    expect((await post(rep, "/action/share", {}, "wrong")).status).toBe(401);
    expect((await post(rep, "/action/share", { "X-Forwarded-For": "203.0.113.9" })).status).toBe(403);
    expect(hosted.seen).toEqual([]);
  });

  it("kya receipt --share prints the public link, the claim and connect hint, and no capability", async () => {
    const fx = fixture();
    const r = await kyaAsync(fx, ["receipt", "--share"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain(`Shared report: ${hosted.base}/r/rid123 (expires 2026-11-21)`);
    expect(r.out).toContain("To connect this computer to your account, run kya login.");
    expect(r.out).not.toContain("#c=");
    expect(r.out).not.toContain("do not send it");
    expect(existsSync(join(fx.home, ".kya", "share-link-token"))).toBe(false);
    expect(Object.keys(hosted.seen[0]!.headers).filter((h) => /link|device|install/i.test(h))).toEqual([]);
  });

  it("kya receipt --share --json prints only url and expiry", async () => {
    const fx = fixture();
    const r = await kyaAsync(fx, ["receipt", "--share", "--json"]);
    expect(r.code, r.all).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ url: `${hosted.base}/r/rid123`, expiresAt: "2026-11-21T08:00:00Z" });
  });

  it("kya receipt --share refuses a link on another origin", async () => {
    const fx = fixture();
    hosted.answerOrigin = "https://evil.example";
    const r = await kyaAsync(fx, ["receipt", "--share"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not on the server that was asked");
    expect(r.out).not.toContain("evil.example");
  });
});
