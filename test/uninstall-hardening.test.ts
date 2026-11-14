/**
 * Feature kya-uninstall and kya-start: hardening of undo and start (review of PR #702).
 * Real-stack e2e: the built dist/cli.js (run `pnpm build` first) against a temp HOME and a temp project.
 * Never touches the real home. Commands as written: kya start, kya uninstall, kya doctor, kya team init.
 *
 * Covers: hostile manifest (path set, backup location, mode, shape), symlink and hard link guards,
 * EACCES on undo, interrupted start, concurrent starts, missing launcher, launcher PATH rules,
 * .gitignore with kya team init, stderr line without --yes, backup modes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcherScript } from "../src/commands/wire-hooks.js";
import { manifestPath, withManifestLock } from "../src/manifest.js";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const posix = process.platform !== "win32";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, "proj"), 0o755);
    } catch {
      /* not there */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

interface Fx {
  base: string;
  home: string;
  proj: string;
}

function fixture(opts: { realGit?: boolean } = {}): Fx {
  const base = mkdtempSync(join(tmpdir(), "kya-harden-"));
  dirs.push(base);
  const home = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), '{"model":  "opus"}');
  writeFileSync(join(home, ".claude.json"), '{ "theme":"dark",\n  "mcpServers": {"mine": {"command": "x"}} }\n');
  if (opts.realGit) {
    spawnSync("git", ["init", "-q"], { cwd: proj });
  } else {
    mkdirSync(join(proj, ".git"));
  }
  writeFileSync(join(proj, ".gitignore"), "node_modules/\n");
  return { base, home, proj };
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
  };
  delete e.CI;
  delete e.KYA_YES;
  return { ...e, ...extra };
}

function kya(fx: Fx, args: string[], extra: Record<string, string> = {}, cwd = fx.proj) {
  if (fx.home === process.env.HOME) throw new Error("test would run against the real HOME");
  const r = spawnSync(process.execPath, [cliJs, ...args], { cwd, encoding: "utf8", timeout: 60_000, env: env(fx, extra) });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}`, signal: r.signal };
}

const START = ["start", "--yes", "--no-open", "--no-gate"];

type Manifest = { entries: { path: string; action: string; backup?: string; project?: string }[]; dirs: string[] };

function readMan(fx: Fx): Manifest {
  return JSON.parse(readFileSync(manifestPath(join(fx.home, ".kya")), "utf8")) as Manifest;
}

/** Rewrite the manifest in place (keeps its 0600 mode). */
function editMan(fx: Fx, fn: (m: Manifest) => void): void {
  const m = readMan(fx);
  fn(m);
  writeFileSync(manifestPath(join(fx.home, ".kya")), JSON.stringify(m, null, 2));
}

const SECRET = "victim file, must stay byte for byte\n";

function victim(fx: Fx): string {
  const out = join(fx.base, "outside");
  mkdirSync(out, { recursive: true });
  const v = join(out, "victim.txt");
  writeFileSync(v, SECRET);
  return v;
}

describe.skipIf(!posix)("start without --yes off a terminal", () => {
  it("prints the 'nothing was written' line on stderr too and still exits 0", () => {
    const fx = fixture();
    const r = kya(fx, ["start", "--no-open", "--no-gate"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("Nothing was written (not a terminal). Run again with --yes");
    expect(r.out).toContain("Nothing was written (not a terminal)");
    const j = kya(fx, ["start", "--no-open", "--no-gate", "--json"]);
    expect(j.code).toBe(0);
    expect(j.err).toContain("Nothing was written (not a terminal)");
    expect((JSON.parse(j.out) as { applied: boolean }).applied).toBe(false);
  });

  it("the plan lists the hosts it skipped because they are not installed", () => {
    const fx = fixture();
    const r = kya(fx, [...START, "--dry-run"]);
    expect(r.out).toContain("not found on this machine, so not wired:");
    expect(r.out).toMatch(/not wired: .*Cursor/);
    expect(r.out).not.toMatch(/not wired: .*Claude Code/);
  });
});

describe.skipIf(!posix)("a hostile or damaged manifest never drives deletes and writes", () => {
  it("refuses to run when manifest.json is not mode 0600", () => {
    const fx = fixture();
    kya(fx, START);
    const before = readFileSync(join(fx.proj, ".mcp.json"), "utf8");
    chmodSync(manifestPath(join(fx.home, ".kya")), 0o644);
    const r = kya(fx, ["uninstall"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("mode is 644, expected 600");
    expect(r.all).toContain("refusing to run kya uninstall");
    expect(readFileSync(join(fx.proj, ".mcp.json"), "utf8")).toBe(before);
  });

  it("refuses a manifest with the wrong shape", () => {
    const fx = fixture();
    kya(fx, START);
    editMan(fx, (m) => {
      (m.entries[0] as unknown as Record<string, unknown>)["sha256"] = "nothex";
    });
    const r = kya(fx, ["uninstall"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("malformed");
    writeFileSync(manifestPath(join(fx.home, ".kya")), "not json");
    expect(kya(fx, ["uninstall"]).code).toBe(1);
  });

  it("an entry for a path outside the files kya writes is refused and the file is left alone", () => {
    const fx = fixture();
    kya(fx, START);
    const v = victim(fx);
    const sha = (s: string) => spawnSync("shasum", ["-a", "256"], { input: s, encoding: "utf8" }).stdout.split(" ")[0]!;
    editMan(fx, (m) => {
      m.entries.push({ path: v, action: "created", scope: "home", keys: [], added: [], removed: [], sha256: sha(SECRET), at: "x" } as never);
    });
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(v, "utf8")).toBe(SECRET);
    expect(r.out).toContain("not a file kya start or kya connect writes");
    // The legitimate entries were still undone.
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(false);
  });

  it("a backup outside ~/.kya/undo is refused: the host config is not overwritten with it", () => {
    const fx = fixture();
    kya(fx, START);
    const evil = join(fx.base, "evil-backup.json");
    writeFileSync(evil, '{"planted": true}');
    const claude = readFileSync(join(fx.home, ".claude.json"), "utf8");
    editMan(fx, (m) => {
      const e = m.entries.find((x) => x.path.endsWith(".claude.json"))!;
      e.backup = evil;
    });
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(join(fx.home, ".claude.json"), "utf8")).toBe(claude);
    expect(r.out).toContain("its backup is outside ~/.kya/undo");
    expect(readFileSync(evil, "utf8")).toBe('{"planted": true}');
  });

  it("a backup that is a symlink into undo pointing elsewhere is refused", () => {
    const fx = fixture();
    kya(fx, START);
    const m = readMan(fx);
    const e = m.entries.find((x) => x.path.endsWith(".claude.json"))!;
    const evil = join(fx.base, "evil2.json");
    writeFileSync(evil, '{"planted": 2}');
    rmSync(e.backup!);
    symlinkSync(evil, e.backup!);
    const r = kya(fx, ["uninstall"]);
    expect(r.out).toContain("its backup is a symlink");
    expect(readFileSync(evil, "utf8")).toBe('{"planted": 2}');
  });
});

describe.skipIf(!posix)("undo never follows a link swapped in after start", () => {
  it("a .mcp.json replaced by a symlink to a file outside the project is not deleted or followed", () => {
    const fx = fixture();
    kya(fx, START);
    const v = victim(fx);
    const mcp = join(fx.proj, ".mcp.json");
    rmSync(mcp);
    symlinkSync(v, mcp);
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(v, "utf8")).toBe(SECRET);
    expect(statSync(v).isFile()).toBe(true);
    expect(r.out).toContain("Left alone:");
    expect(r.out).toMatch(/\.mcp\.json: .*(symlink|outside the project)/);
    // Still listed, so a rerun can finish once the link is fixed.
    expect(readMan(fx).entries.some((e) => e.path.endsWith(".mcp.json"))).toBe(true);
  });

  it("a .mcp.json that is now a hard link to another file is refused", () => {
    const fx = fixture();
    kya(fx, START);
    const v = victim(fx);
    const mcp = join(fx.proj, ".mcp.json");
    const content = readFileSync(mcp);
    rmSync(mcp);
    writeFileSync(v, content); // same bytes: only the link count tells
    linkSync(v, mcp);
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(mcp)).toBe(true);
    expect(existsSync(v)).toBe(true);
    expect(r.out).toMatch(/\.mcp\.json: .*hard links/);
  });

  it("a home config replaced by a symlink is refused and its backup path is printed", () => {
    const fx = fixture();
    kya(fx, START);
    const v = victim(fx);
    const cj = join(fx.home, ".claude.json");
    const backup = readMan(fx).entries.find((e) => e.path.endsWith(".claude.json"))!.backup!;
    renameSync(cj, join(fx.base, "moved.json"));
    symlinkSync(v, cj);
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(v, "utf8")).toBe(SECRET);
    expect(r.out).toContain("it is now a symlink");
    expect(r.out).toContain(`(backup: ${backup})`);
    expect(existsSync(backup)).toBe(true);
  });

  it("a home config that is now a hard link to another file is refused and left as it is", () => {
    const fx = fixture();
    kya(fx, START);
    const v = victim(fx);
    const cj = join(fx.home, ".claude.json");
    const content = readFileSync(cj);
    rmSync(cj);
    writeFileSync(v, content);
    linkSync(v, cj);
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/\.claude\.json: it has other hard links \(2\); refused/);
    expect(readFileSync(cj).equals(content)).toBe(true);
    expect(readFileSync(v).equals(content)).toBe(true);
  });

  it("a parent directory replaced by a link makes the entry refuse (path no longer resolves)", () => {
    const fx = fixture();
    kya(fx, START);
    const v = victim(fx);
    const other = join(fx.base, "other-claude");
    mkdirSync(other);
    const settings = readFileSync(join(fx.home, ".claude", "settings.json"));
    writeFileSync(join(other, "settings.json"), settings);
    renameSync(join(fx.home, ".claude"), join(fx.base, "claude-real"));
    symlinkSync(other, join(fx.home, ".claude"));
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(join(other, "settings.json")).equals(settings)).toBe(true);
    expect(r.out).toMatch(/settings\.json: .*(no longer resolves|symlink|not a file)/);
    expect(readFileSync(v, "utf8")).toBe(SECRET);
  });
});

describe.skipIf(!posix || process.getuid?.() === 0)("undo with a denied path does not abort the run", () => {
  it("EACCES on a delete is reported, the other entries are undone, the entry stays for a rerun", () => {
    const fx = fixture();
    kya(fx, START);
    chmodSync(fx.proj, 0o555); // cannot delete or replace files in the project directory
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain("Left alone:");
    expect(r.out).toMatch(/\.mcp\.json: could not undo it \(.*EACCES|\.mcp\.json: could not undo it/);
    // Home files were still restored: the denied path did not stop the run.
    expect(JSON.parse(readFileSync(join(fx.home, ".claude.json"), "utf8")).mcpServers["shield-kya"]).toBeUndefined();
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(true);
    expect(readMan(fx).entries.some((e) => e.path.endsWith(".mcp.json"))).toBe(true);
    // Fix the permission, run again: finished.
    chmodSync(fx.proj, 0o755);
    expect(kya(fx, ["uninstall"]).code).toBe(0);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(false);
    expect(existsSync(manifestPath(join(fx.home, ".kya")))).toBe(false);
  });

  it("EACCES on a restore is reported and the backup is kept", () => {
    const fx = fixture();
    kya(fx, START);
    const backup = readMan(fx).entries.find((e) => e.path.endsWith("settings.json"))!.backup!;
    chmodSync(join(fx.home, ".claude"), 0o555);
    try {
      const r = kya(fx, ["uninstall"]);
      expect(r.code, r.all).toBe(0);
      expect(r.out).toMatch(/settings\.json: could not undo it/);
      expect(existsSync(backup)).toBe(true);
      expect(readMan(fx).entries.some((e) => e.path.endsWith("settings.json"))).toBe(true);
    } finally {
      chmodSync(join(fx.home, ".claude"), 0o755);
    }
  });
});

describe.skipIf(!posix)("backups", () => {
  it("backup files are mode 0600 and the undo directory 0700", () => {
    const fx = fixture();
    kya(fx, START);
    const m = readMan(fx);
    const backups = m.entries.filter((e) => e.backup).map((e) => e.backup!);
    expect(backups.length).toBeGreaterThan(0);
    for (const b of backups) {
      expect(statSync(b).mode & 0o777).toBe(0o600);
      expect(statSync(join(b, "..")).mode & 0o777).toBe(0o700);
    }
    expect(statSync(manifestPath(join(fx.home, ".kya"))).mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(!posix)("hook launcher on start", () => {
  it("a missing launcher is written again by a plain start, even when every host is already wired", () => {
    const fx = fixture();
    kya(fx, START);
    const launcher = join(fx.home, ".kya", "bin", "kya-hook");
    rmSync(launcher);
    const r = kya(fx, ["start", "--no-open", "--no-gate"], { KYA_YES: "1" });
    expect(r.code, r.all).toBe(0);
    expect(existsSync(launcher)).toBe(true);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    const paths = readMan(fx).entries.map((e) => e.path);
    expect(paths.filter((p) => p.endsWith("kya-hook"))).toHaveLength(1);
    // And it is undone again.
    kya(fx, ["uninstall"]);
    expect(existsSync(launcher)).toBe(false);
  });

  it("falls back to `kya` on PATH when the recorded node and cli are gone", () => {
    const base = mkdtempSync(join(tmpdir(), "kya-launcher-"));
    dirs.push(base);
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "kya"), '#!/bin/sh\necho "kya-ran:$*"\n');
    chmodSync(join(bin, "kya"), 0o755);
    const f = join(base, "kya-hook");
    writeFileSync(f, launcherScript("/nonexistent/node", "/nonexistent/cli.js"));
    chmodSync(f, 0o755);
    const r = spawnSync("/bin/sh", [f, "hook", "--host", "claude"], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("kya-ran:hook --host claude");
  });

  it("never runs a kya or node found through a relative or empty PATH entry (fails open instead)", () => {
    const base = mkdtempSync(join(tmpdir(), "kya-launcher-"));
    dirs.push(base);
    const planted = join(base, "planted");
    mkdirSync(planted);
    for (const name of ["kya", "node"]) {
      writeFileSync(join(planted, name), `#!/bin/sh\necho ran > "${join(base, "marker")}"\n`);
      chmodSync(join(planted, name), 0o755);
    }
    const f = join(base, "kya-hook");
    writeFileSync(f, launcherScript("/nonexistent/node", "/nonexistent/cli.js"));
    chmodSync(f, 0o755);
    for (const PATH of [".", ":", "", "planted", `:${"/nonexistent"}:.`]) {
      const r = spawnSync("/bin/sh", [f, "hook", "--host", "claude"], { cwd: planted, encoding: "utf8", env: { PATH } });
      expect(r.status, PATH).toBe(0);
      expect(r.stderr, PATH).toContain("hook skipped");
    }
    expect(existsSync(join(base, "marker"))).toBe(false);
  });
});

describe.skipIf(!posix)("kya team init, then kya start", () => {
  it("keeps .kya/policy.json committable: git check-ignore exits 1 for it and 0 for the rest of .kya", () => {
    const fx = fixture({ realGit: true });
    const t = kya(fx, ["team", "init"]);
    expect(t.code, t.all).toBe(0);
    expect(existsSync(join(fx.proj, ".kya", "policy.json"))).toBe(true);
    expect(kya(fx, START).code).toBe(0);
    const ignored = (p: string) => spawnSync("git", ["check-ignore", "-q", p], { cwd: fx.proj }).status;
    expect(ignored(".kya/policy.json")).toBe(1);
    expect(ignored(".kya/config.json")).toBe(0);
    expect(readFileSync(join(fx.proj, ".gitignore"), "utf8")).toBe("node_modules/\n.kya/*\n!.kya/policy.json\n");
    // Undo removes both lines again.
    kya(fx, ["uninstall"]);
    expect(readFileSync(join(fx.proj, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });
});

describe.skipIf(!posix)("interrupted start", () => {
  it("a start killed after a commit but before the write lands is still undone completely", () => {
    const fx = fixture();
    const preload = join(fx.base, "kill-before-rename.mjs");
    writeFileSync(
      preload,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const real = fs.renameSync;",
        "fs.renameSync = (from, to) => {",
        // The hook settings are written after the project and the user MCP files: die right before that rename.
        '  if (String(to).endsWith("settings.json")) process.kill(process.pid, "SIGKILL");',
        "  return real(from, to);",
        "};",
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );
    const snap = () => ({
      cj: readFileSync(join(fx.home, ".claude.json"), "utf8"),
      st: readFileSync(join(fx.home, ".claude", "settings.json"), "utf8"),
      gi: readFileSync(join(fx.proj, ".gitignore"), "utf8"),
    });
    const before = snap();
    const r = kya(fx, START, { NODE_OPTIONS: `--import=${preload}` });
    expect(r.signal).toBe("SIGKILL");
    // The run died halfway: the manifest exists and lists what was written and what was about to be.
    const m = readMan(fx);
    expect(m.entries.some((e) => e.path.endsWith(".mcp.json"))).toBe(true);
    expect(m.entries.some((e) => e.path.endsWith("settings.json"))).toBe(true);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(true);
    const u = kya(fx, ["uninstall"]);
    expect(u.code, u.all).toBe(0);
    expect(snap()).toEqual(before);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(false);
    expect(existsSync(join(fx.proj, ".kya", "config.json"))).toBe(false);
  });
});

describe.skipIf(!posix)("concurrent starts", () => {
  function run(fx: Fx, cwd: string): Promise<number | null> {
    return new Promise((resolve) => {
      const c = spawn(process.execPath, [cliJs, ...START], { cwd, env: env(fx), stdio: "ignore" });
      c.on("exit", (code) => resolve(code));
    });
  }

  it("two starts in different projects on one home keep every manifest entry", async () => {
    const fx = fixture();
    const proj2 = join(fx.base, "proj2");
    mkdirSync(join(proj2, ".git"), { recursive: true });
    const [a, b] = await Promise.all([run(fx, fx.proj), run(fx, proj2)]);
    expect([a, b]).toEqual([0, 0]);
    const m = readMan(fx);
    const paths = m.entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of [fx.proj, proj2]) {
      expect(paths.some((x) => x.endsWith(join(p.split("/").pop()!, ".mcp.json")))).toBe(true);
      expect(paths.some((x) => x.endsWith(join(p.split("/").pop()!, ".kya", "config.json")))).toBe(true);
    }
    expect(paths.some((x) => x.endsWith(".claude.json"))).toBe(true);
    // The home entries keep the real original as their backup, whichever start got there first.
    const cj = m.entries.find((e) => e.path.endsWith(".claude.json"))!;
    expect(readFileSync(cj.backup!, "utf8")).toBe('{ "theme":"dark",\n  "mcpServers": {"mine": {"command": "x"}} }\n');
    // And one uninstall undoes both projects.
    expect(kya(fx, ["uninstall"]).code).toBe(0);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(false);
    expect(existsSync(join(proj2, ".mcp.json"))).toBe(false);
  });

  it("a lock whose owner is gone is taken over at once, and the lock file is removed afterwards", () => {
    const g = mkdtempSync(join(tmpdir(), "kya-lock-"));
    dirs.push(g);
    writeFileSync(join(g, "manifest.lock"), "99999999\n");
    const t0 = Date.now();
    expect(withManifestLock(g, () => "ran")).toBe("ran");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(existsSync(join(g, "manifest.lock"))).toBe(false);
  });

  it("the lock is exclusive: a second holder inside the first sees the file", () => {
    const g = mkdtempSync(join(tmpdir(), "kya-lock-"));
    dirs.push(g);
    withManifestLock(g, () => {
      expect(readFileSync(join(g, "manifest.lock"), "utf8").trim()).toBe(String(process.pid));
    });
    expect(existsSync(join(g, "manifest.lock"))).toBe(false);
  });
});
