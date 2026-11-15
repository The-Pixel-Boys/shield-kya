/**
 * Features kya-start (guard proof) and kya-receipt (Blocked first, Certify in its own tab).
 * Real-stack e2e: the built dist/cli.js (run `pnpm build` first) against a temp HOME, a temp KYA_HOME and a
 * temp project. Never touches the real home. Spec: Shield KYA first-run spec, item F1 (guard first).
 *
 * Commands as written: kya start, --dry-run, --yes, kya receipt, kya hook, kya stop.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMISE } from "../src/guard-demo.js";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const posix = process.platform !== "win32";
const GUARDED = "Blocked: rm -rf ~, read .env, curl | sh. Your agent is now guarded.";
const dirs: string[] = [];
const fixtures: Fx[] = [];

interface Fx {
  base: string;
  /** HOME and KYA_HOME: one temp dir, as in the other kya start e2e tests. */
  home: string;
  proj: string;
  tmp: string;
}

afterEach(() => {
  // A report daemon started by `kya start` must not outlive the test.
  for (const fx of fixtures.splice(0)) kya(fx, ["stop"]);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(opts: { hookHost?: boolean } = {}): Fx {
  const base = mkdtempSync(join(tmpdir(), "kya-f1-"));
  dirs.push(base);
  const home = join(base, "home");
  const proj = join(base, "proj");
  const tmp = join(base, "tmp");
  mkdirSync(proj, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (opts.hookHost !== false) mkdirSync(join(home, ".claude"));
  mkdirSync(join(proj, ".git"));
  const fx = { base, home, proj, tmp };
  fixtures.push(fx);
  return fx;
}

function env(fx: Fx, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fx.home,
    KYA_HOME: fx.home,
    TMPDIR: fx.tmp,
    KYA_NO_BROWSER: "1",
    KYA_SKIP_NODE_CHECK: "1",
    KYA_OFFLINE: "1",
    KYA_TELEMETRY: "0",
    KYA_SEMANTIC: "off",
    KYA_ALERTS: "off",
    DO_NOT_TRACK: "1",
  };
  for (const k of ["CI", "KYA_YES", "KYA_API_KEY", "SHIELD_API_KEY", "KYA_BASE_URL"]) delete e[k];
  return { ...e, ...extra };
}

function kya(fx: Fx, args: string[], extra: Record<string, string> = {}, input?: string) {
  console.error(`# kya ${args.join(" ")}  HOME=${fx.home} KYA_HOME=${fx.home}`);
  const r = spawnSync(process.execPath, [cliJs, ...args], { cwd: fx.proj, encoding: "utf8", timeout: 60_000, env: env(fx, extra), ...(input !== undefined ? { input } : {}) });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

const START = ["start", "--no-open", "--no-gate"];

function trailRows(fx: Fx): Record<string, unknown>[] {
  const p = join(fx.home, ".kya", "trail.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function report(fx: Fx, extra: Record<string, string> = {}): { md: string; html: string } {
  const r = kya(fx, ["receipt"], extra);
  expect(r.code, r.all).toBe(0);
  const dir = join(fx.proj, ".kya", "receipts");
  return { md: readFileSync(join(dir, "last-3d.md"), "utf8"), html: readFileSync(join(dir, "last-3d.html"), "utf8") };
}

/** The part of the HTML page between two zone ids (the zones are the report's tabs). */
function zones(html: string, from: string, to: string): string {
  const a = html.indexOf(`<section class="zone" id="${from}"`);
  const b = html.indexOf(`<section class="zone" id="${to}"`);
  expect(a, `zone ${from}`).toBeGreaterThan(-1);
  expect(b, `zone ${to}`).toBeGreaterThan(a);
  return html.slice(a, b);
}

/** A real hook call, as a host sends it. Exit 2 means blocked. */
function hookCall(fx: Fx, toolName: string, toolInput: Record<string, unknown>): number | null {
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "f1-real", cwd: fx.proj, tool_name: toolName, tool_input: toolInput });
  return kya(fx, ["hook", "--host", "claude"], {}, payload).code;
}

describe.skipIf(!posix)("guard first: kya start proof (real CLI, temp HOME and KYA_HOME)", () => {
  it("a fresh start in an empty project opens with the promise and ends with the three demo blocks", () => {
    const fx = fixture();
    const r = kya(fx, [...START, "--yes"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out.split("\n")[0]).toBe(PROMISE);
    const lines = r.out.split("\n").filter(Boolean);
    expect(lines.at(-2)).toBe("Guard demo (3 built-in calls, not saved to your trail):");
    expect(lines.at(-1)).toBe(GUARDED);
  });

  it("the demo calls never reach the real trail, and the throw-away KYA_HOME is deleted", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const rows = trailRows(fx);
    expect(rows.map((x) => x.toolId)).toEqual(["kya.start"]);
    expect(rows.some((x) => x.outcome === "blocked" || x.verdict === "DENY")).toBe(false);
    expect(readdirSync(fx.tmp).filter((n) => n.startsWith("kya-proof-"))).toEqual([]);
  });

  it("with no hook host on the machine it still shows the blocks but does not claim the agent is guarded", () => {
    const fx = fixture({ hookHost: false });
    const r = kya(fx, [...START, "--yes"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain("Blocked: rm -rf ~, read .env, curl | sh.");
    expect(r.out).toContain("no agent is guarded yet");
    expect(r.out).not.toContain("Your agent is now guarded");
  });

  it("--dry-run prints no proof and no claim of guarding, and writes nothing", () => {
    const fx = fixture();
    const r = kya(fx, [...START, "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out.split("\n")[0]).toBe(PROMISE);
    expect(r.out).toContain("Dry run: nothing was written.");
    expect(r.out).not.toContain("Blocked:");
    expect(r.out).not.toContain("guarded");
    expect(r.out).not.toContain("Guard demo");
    expect(existsSync(join(fx.home, ".kya"))).toBe(false);
  });

  it("without consent (not a terminal, no --yes) it prints no proof and writes nothing", () => {
    const fx = fixture();
    const r = kya(fx, START);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("Nothing was written");
    expect(r.all).not.toContain("Blocked:");
    expect(r.all).not.toContain("guarded");
    expect(existsSync(join(fx.home, ".kya"))).toBe(false);
  });

  it("--json carries the proof as data", () => {
    const fx = fixture();
    const r = kya(fx, [...START, "--yes", "--json"]);
    expect(r.code, r.all).toBe(0);
    const j = JSON.parse(r.out) as { proof?: { demo: boolean; results: { label: string; blocked: boolean }[]; guardedHosts: string[] } };
    expect(j.proof?.demo).toBe(true);
    expect(j.proof?.results).toEqual([
      { label: "rm -rf ~", blocked: true },
      { label: "read .env", blocked: true },
      { label: "curl | sh", blocked: true },
    ]);
    expect(j.proof?.guardedHosts).toEqual(["claude"]);
  });
});

describe.skipIf(!posix)("guard first: the report (real CLI, temp HOME and KYA_HOME)", () => {
  it("fresh start: last-3d.md begins with the promise and a Blocked demo section and shows no gap count above the fold", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const { md } = report(fx);
    const lines = md.split("\n");
    expect(lines[0]).toBe(`# ${PROMISE}`);
    expect(lines.indexOf("## Blocked (demo)")).toBeGreaterThan(-1);
    expect(lines.indexOf("## Blocked (demo)")).toBeLessThan(6);
    expect(md).toContain("`rm -rf ~` - Deletes your home folder (demo)");
    expect(md).toContain("`read .env` - Reads a secret file (demo)");
    expect(md).toContain("`curl | sh` - Runs a script from the network (demo)");
    const fold = md.slice(0, md.indexOf("## Certify") === -1 ? md.length : md.indexOf("## Certify"));
    expect(fold).not.toMatch(/\bgap\b/i);
    expect(fold).not.toMatch(/insufficient/i);
    expect(fold).not.toContain("SAFE-04");
    expect(fold).not.toContain("Planes");
    expect(fold).not.toContain("8090");
    // Certify is still in the report, after everything else.
    expect(md.indexOf("## Certify")).toBeGreaterThan(md.indexOf("## Blocked (demo)"));
  });

  it("fresh start: the overview opens on Blocked (labelled demo); Certify is its own tab with no count in the nav", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const { html } = report(fx);
    const overview = zones(html, "overview", "activity");
    expect(overview).toContain('aria-label="Blocked"');
    expect(overview).toMatch(/<span class="pill">demo<\/span>/);
    expect(overview.indexOf('aria-label="Blocked"')).toBeLessThan(overview.indexOf('class="hero-tiles"'));
    expect(overview).not.toContain('aria-label="Certify"');
    expect(overview).not.toMatch(/\bgap\b/i);
    expect(overview).not.toContain("SAFE-04");
    expect(overview).not.toContain("Planes");
    const nav = html.slice(html.indexOf('<nav class="sidebar-nav"'), html.indexOf("</nav>"));
    const certifyLink = nav.slice(nav.indexOf('id="tab-certify"'), nav.indexOf("</a>", nav.indexOf('id="tab-certify"')));
    expect(certifyLink).not.toContain("nav-count");
    const certify = zones(html, "certify", "orr");
    expect(certify).toContain('aria-label="Certify"');
    expect(html).toContain(`<h1>${PROMISE}</h1>`);
  });

  it("real blocked calls replace the demo: the real hook blocks, the report counts and lists them", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    expect(hookCall(fx, "Bash", { command: "rm -rf ~" })).toBe(2);
    expect(hookCall(fx, "Read", { file_path: join(fx.proj, ".env") })).toBe(2);
    expect(hookCall(fx, "Read", { file_path: join(fx.proj, "README.md") })).toBe(0);
    const { md, html } = report(fx);
    expect(md).toContain("## Blocked\n");
    expect(md).not.toContain("## Blocked (demo)");
    expect(md).toContain("2 calls blocked in this window. Last 2:");
    const overview = zones(html, "overview", "activity");
    expect(overview).toContain('<span class="blk-num bad">2</span>');
    expect(overview).not.toMatch(/<span class="pill">demo<\/span>/);
    expect(overview).toContain(">Read<");
  });

  it("only the five most recent blocked calls are listed, newest first", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const trail = join(fx.home, ".kya", "trail.jsonl");
    for (let i = 0; i < 7; i++) {
      const ts = new Date(Date.now() - (7 - i) * 60_000).toISOString();
      appendFileSync(trail, `${JSON.stringify({ ts, sessionId: "f1", toolId: "Bash", verdict: "DENY", outcome: "blocked", reasonCode: "NEVER_EVENT", mode: "offline", neverEvent: true, summary: `blocked call number ${i + 1}` })}\n`);
    }
    const { md } = report(fx);
    expect(md).toContain("7 calls blocked in this window. Last 5:");
    const section = md.slice(md.indexOf("## Blocked"), md.indexOf("\n## ", md.indexOf("## Blocked") + 5));
    const order = [...section.matchAll(/blocked call number (\d)/g)].map((m) => Number(m[1]));
    expect(order).toEqual([7, 6, 5, 4, 3]);
  });

  it("the control-plane address is hidden without a plane and shown once a plane is configured", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    // kya start wrote the placeholder base URL into .kya/config.json: it is not a plane.
    expect(readFileSync(join(fx.proj, ".kya", "config.json"), "utf8")).toContain("127.0.0.1:8090");
    const none = report(fx);
    expect(none.html).not.toContain('class="identity"');
    expect(none.html).not.toContain("127.0.0.1:8090");
    expect(none.md).not.toContain("127.0.0.1:8090");
    const withPlane = report(fx, { KYA_API_KEY: "plane-key" });
    expect(withPlane.html).toContain('class="identity"');
    expect(withPlane.html).toContain("127.0.0.1:8090");
    expect(withPlane.md).toContain("127.0.0.1:8090");
  });

  it("a plain start (report server on) writes the same Blocked-first report", () => {
    const fx = fixture();
    const r = kya(fx, ["start", "--no-gate", "--yes"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain(GUARDED);
    const md = readFileSync(join(fx.proj, ".kya", "receipts", "last-3d.md"), "utf8");
    expect(md.split("\n")[0]).toBe(`# ${PROMISE}`);
    expect(md.indexOf("## Blocked (demo)")).toBeLessThan(md.indexOf("## Analytics") === -1 ? md.length : md.indexOf("## Analytics"));
  });
});
