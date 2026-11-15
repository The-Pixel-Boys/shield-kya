/**
 * Feature kya-help-surface (spec F5, advanced surface). Real-stack e2e: the built dist/cli.js (run `pnpm build`
 * first) against a temp HOME, a temp KYA_HOME and a temp project. Never touches the real home. A report daemon that
 * `kya start` leaves is stopped in afterEach.
 *
 * Commands as written: kya --help, kya -h, kya help, kya, kya help --all, kya help <command>, kya <command> --help,
 * kya start, kya doctor, kya receipt, kya stop.
 *
 * One test (or group) per acceptance line of the spec:
 *   1 short help, 25 lines or fewer, six commands          2 help --all is the 0.34.0 text, help <command>
 *   3 no command removed (see help-examples-e2e.test.ts)   4 four group headings
 *   5 report tabs and the More control                     6 startup notices moved from start to doctor
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { connectableHosts } from "../src/commands/connect.js";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const posix = process.platform !== "win32";
const dirs: string[] = [];
const fixtures: Fx[] = [];

interface Fx {
  base: string;
  home: string;
  proj: string;
}

afterEach(() => {
  for (const fx of fixtures.splice(0)) kya(fx, ["stop"]);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): Fx {
  const base = mkdtempSync(join(tmpdir(), "kya-f5-"));
  dirs.push(base);
  const fx = { base, home: join(base, "home"), proj: join(base, "proj") };
  mkdirSync(join(fx.proj, ".git"), { recursive: true });
  mkdirSync(join(fx.home, ".claude"), { recursive: true });
  fixtures.push(fx);
  return fx;
}

function kya(fx: Fx, args: string[], extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fx.home,
    KYA_HOME: fx.home,
    TMPDIR: fx.base,
    KYA_NO_BROWSER: "1",
    KYA_SKIP_NODE_CHECK: "1",
    KYA_OFFLINE: "1",
    KYA_TELEMETRY: "0",
    KYA_UPDATE_CHECK: "0",
    DO_NOT_TRACK: "1",
    ...extra,
  };
  // The notices depend on these two switches, so a test sets them on purpose and the host's values never leak in.
  for (const k of ["CI", "KYA_YES", "KYA_API_KEY", "SHIELD_API_KEY", "KYA_BASE_URL", "KYA_SEMANTIC", "KYA_ALERTS", "KYA_SEARCH_SEMANTIC"]) {
    if (!(k in extra)) delete env[k];
  }
  const r = spawnSync(process.execPath, [cliJs, ...args], { cwd: fx.proj, encoding: "utf8", timeout: 60_000, env, input: "" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const lines = (s: string): string[] => s.replace(/\n$/, "").split("\n");
const SIX = ["kya start", "kya receipt", "kya connect <host>", "kya doctor", "kya stop", "kya uninstall"];
const NOT_FOR_NEWCOMERS = ["orr", "passport", "shrink", "invoke", "sandbox", "certify", "register-agent"];
const NOTICE_SEARCH = "Plain-language search is off";
const NOTICE_ALERTS = "Security alerts are off";

const golden = readFileSync(join(import.meta.dirname, "fixtures", "help-0.34.0.txt"), "utf8").replace("{{HOSTS}}", connectableHosts().join("|"));
const HEADINGS = ["Guard:", "Report:", "Team and hosted:", "Compliance and evidence:"];

/** Help text without the four group headings (and the blank line before each), split into its three parts. */
function parts(text: string): { before: string; entries: string[]; after: string } {
  const ls = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    if (HEADINGS.includes(ls[i]!)) {
      if (kept[kept.length - 1] === "") kept.pop();
      continue;
    }
    kept.push(ls[i]!);
  }
  const plain = kept.join("\n");
  const a = plain.indexOf("\nCommands:\n") + "\nCommands:\n".length;
  const b = plain.indexOf("\nOptions (shared):");
  const entries: string[] = [];
  for (const l of plain.slice(a, b).split("\n")) {
    if (/^ {2}\S/.test(l)) entries.push(l);
    else if (entries.length > 0 && l !== "") entries[entries.length - 1] += `\n${l}`;
  }
  return { before: plain.slice(0, a), entries, after: plain.slice(b) };
}

describe.skipIf(!posix)("short help (spec items 1 and 3)", () => {
  it("kya --help, kya -h, kya help and bare kya print the same short help: 25 lines or fewer, six commands only", () => {
    const fx = fixture();
    const outs = [["--help"], ["-h"], ["help"], []].map((a) => {
      const r = kya(fx, a);
      expect(r.code, `kya ${a.join(" ")}`).toBe(0);
      return r.out;
    });
    for (const o of outs) expect(o).toBe(outs[0]);
    const text = outs[0]!;
    expect(lines(text).length).toBeLessThanOrEqual(25);
    for (const c of SIX) expect(text).toContain(c);
    expect(text).toContain("Guard this machine and open the report");
    for (const c of NOT_FOR_NEWCOMERS) expect(text, c).not.toContain(c);
    expect(text).toContain("kya help --all");
  });
});

describe.skipIf(!posix)("full help (spec items 2 and 4)", () => {
  it("kya help --all and kya --help --all are the 0.34.0 text, apart from the four group headings", () => {
    const fx = fixture();
    const all = kya(fx, ["help", "--all"]);
    expect(all.code).toBe(0);
    expect(kya(fx, ["--help", "--all"]).out).toBe(all.out);
    const got = parts(all.out);
    const want = parts(golden);
    expect(want.entries).toHaveLength(41);
    expect(got.before).toBe(want.before);
    expect(got.after).toBe(want.after);
    // Grouping moves entries, so the check is on each entry's exact text, not on their order.
    expect([...got.entries].sort()).toEqual([...want.entries].sort());
  });

  it("the four headings come in order and every command sits in its group", () => {
    const fx = fixture();
    const text = kya(fx, ["help", "--all"]).out;
    const at = HEADINGS.map((h) => text.indexOf(`\n${h}\n`));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    const group = (cmd: string): string => {
      const i = text.search(new RegExp(`^ {2}${cmd}\\s`, "m"));
      expect(i, cmd).toBeGreaterThan(-1);
      return HEADINGS[at.filter((h) => h < i).length - 1]!;
    };
    expect(group("start")).toBe("Guard:");
    expect(group("hook")).toBe("Guard:");
    expect(group("doctor")).toBe("Guard:");
    expect(group("receipt")).toBe("Report:");
    expect(group("discover")).toBe("Report:");
    expect(group("login")).toBe("Team and hosted:");
    expect(group("passport")).toBe("Team and hosted:");
    expect(group("certify")).toBe("Compliance and evidence:");
    expect(group("orr")).toBe("Compliance and evidence:");
  });

  it("kya help <command> and kya <command> --help print that command's section only", () => {
    const fx = fixture();
    const want = parts(golden).entries;
    const start = want.find((e) => e.startsWith("  start "))!;
    const a = kya(fx, ["help", "start"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain(start);
    expect(a.out).not.toContain("  stop  ");
    expect(kya(fx, ["start", "--help"]).out).toBe(a.out);
    // A command with two words, and one with two entries.
    expect(kya(fx, ["help", "orr"]).out).toContain(want.find((e) => e.startsWith("  orr run"))!);
    const team = kya(fx, ["help", "team"]).out;
    expect(team).toContain("team init");
    expect(team).toContain("team managed-settings");
  });

  it("kya help <unknown> exits 2 and points at kya help --all", () => {
    const r = kya(fixture(), ["help", "nonesuch"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("kya help --all");
  });

  it("an unknown command exits 2 and points at kya help --all", () => {
    const r = kya(fixture(), ["nonesuch"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown command: nonesuch");
    expect(r.err).toContain("kya help --all");
    expect(lines(r.out).length).toBeLessThanOrEqual(25);
  });
});

describe.skipIf(!posix)("startup notices (spec item 6)", () => {
  it("kya start prints neither notice, and kya doctor prints both", () => {
    const fx = fixture();
    const start = kya(fx, ["start", "--yes", "--no-open", "--no-gate"]);
    expect(start.code, start.err).toBe(0);
    for (const n of [NOTICE_SEARCH, NOTICE_ALERTS]) {
      expect(start.out, n).not.toContain(n);
      expect(start.err, n).not.toContain(n);
    }
    const doctor = kya(fx, ["doctor"]);
    expect(doctor.code).toBe(0);
    expect(doctor.out).toContain(`${NOTICE_SEARCH} (exact words only). Turn it on: KYA_SEMANTIC=on kya start`);
    expect(doctor.out).toContain(`${NOTICE_ALERTS}. Turn them on: KYA_ALERTS=on kya start`);
  });

  it("kya doctor stays quiet about a feature that is switched off on purpose, and --json keeps its shape", () => {
    const fx = fixture();
    const off = kya(fx, ["doctor"], { KYA_SEMANTIC: "off", KYA_ALERTS: "off" });
    expect(off.out).not.toContain(NOTICE_SEARCH);
    expect(off.out).not.toContain(NOTICE_ALERTS);
    const json = kya(fx, ["doctor", "--json"]);
    expect(json.code).toBe(0);
    expect(Object.keys(JSON.parse(json.out) as object).sort()).toEqual(["hook", "iocs"]);
  });
});

describe.skipIf(!posix)("report tabs (spec item 5)", () => {
  function reportHtml(): string {
    const fx = fixture();
    const r = kya(fx, ["receipt"]);
    expect(r.code, r.err).toBe(0);
    return readFileSync(join(fx.proj, ".kya", "receipts", "last-3d.html"), "utf8");
  }

  it("the nav shows Blocked, Activity and Connected tools, and keeps the rest behind a More control", () => {
    const html = reportHtml();
    const nav = html.slice(html.indexOf('<nav class="sidebar-nav"'), html.indexOf("</nav>"));
    const more = nav.indexOf('<details class="nav-more" id="nav-more">');
    expect(more).toBeGreaterThan(-1);
    expect(nav.slice(more)).toContain("<summary");
    expect(nav.slice(more)).toContain(">More</summary>");
    const outside = nav.slice(0, more);
    expect(outside).toMatch(/id="tab-overview"[\s\S]*Blocked/);
    for (const href of ["#overview", "#activity", "#connected"]) expect(outside).toContain(`href="${href}"`);
    for (const label of ["Certify", "ORR", "Gateway", "System", "Changes"]) expect(outside, label).not.toContain(label);
    const inside = nav.slice(more);
    for (const href of ["#certify", "#orr", "#gateway-home", "#system", "#changes"]) expect(inside).toContain(`href="${href}"`);
    // Every tab is still a zone of the page, so a link to #certify keeps working.
    for (const id of ["overview", "activity", "connected", "certify", "orr", "system"]) expect(html).toContain(`id="${id}"`);
  });

  it("the More state is remembered in localStorage, and the page works when localStorage throws", () => {
    const html = reportHtml();
    const script = html.split("<script>").slice(1).map((s) => s.slice(0, s.indexOf("</script>"))).find((s) => s.includes("kya-nav-more"));
    expect(script, "More script").toBeDefined();
    const run = (storage: Record<string, unknown>, hash: string) => {
      const more = { open: false, listeners: {} as Record<string, () => void>, addEventListener(e: string, f: () => void) { this.listeners[e] = f; }, querySelector: (sel: string) => (sel.includes("#certify") ? {} : null) };
      const win = { listeners: {} as Record<string, () => void>, addEventListener(e: string, f: () => void) { this.listeners[e] = f; } };
      runInNewContext(script!, { document: { getElementById: () => more }, window: win, location: { hash }, localStorage: storage });
      return { more, win };
    };
    const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    expect(run(throwing, "").more.open).toBe(false);
    const toggled = run(throwing, "");
    expect(() => { toggled.more.open = true; toggled.more.listeners["toggle"]!(); }).not.toThrow();
    // Remembered open, remembered closed, and a link into the menu opens it.
    expect(run({ getItem: () => "open", setItem() {} }, "").more.open).toBe(true);
    expect(run({ getItem: () => "closed", setItem() {} }, "").more.open).toBe(false);
    expect(run({ getItem: () => null, setItem() {} }, "#certify").more.open).toBe(true);
    const saved: string[] = [];
    const r = run({ getItem: () => null, setItem: (_k: string, v: string) => saved.push(v) }, "");
    r.more.open = true;
    r.more.listeners["toggle"]!();
    expect(saved).toEqual(["open"]);
  });
});
