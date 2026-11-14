/**
 * Feature kya-team-init-guard (`kya team init --guard`): the built CLI (dist/cli.js, run `pnpm build` first, as for the other
 * e2e tests) in a temp HOME, a temp KYA_HOME and a temp project. Never the real home.
 * Covers: --dry-run prints the diff and the badge and writes nothing (tree compared byte for byte), the write, a second run
 * that changes nothing, keys that stay, the manifest record, `kya uninstall --project` that restores the bytes, and the refusals.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GUARD_BADGE, unifiedDiff } from "../src/commands/team.js";

const root = join(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const isPre = version.includes("-");
const cliJs = join(root, "dist/cli.js");
const haveDist = existsSync(cliJs);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "kya-team-guard-")));
  dirs.push(d);
  return d;
};

interface Fx { readonly home: string; readonly proj: string }
function fixture(settings?: string): Fx {
  const home = tmp();
  const proj = tmp();
  if (settings !== undefined) {
    mkdirSync(join(proj, ".claude"));
    writeFileSync(join(proj, ".claude/settings.json"), settings);
  }
  return { home, proj };
}
function kya(fx: Fx, args: string[]) {
  const r = spawnSync(process.execPath, [cliJs, ...args], {
    cwd: fx.proj, encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home, KYA_TELEMETRY: "0" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Every path under dir with its sha256 (directories as "dir"), so two trees compare byte for byte. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (lstatSync(p).isDirectory()) { out[rel] = "dir"; walk(p); }
      else out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}
const settingsOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.proj, ".claude/settings.json"), "utf8"));
const manifestOf = (fx: Fx) => JSON.parse(readFileSync(join(fx.home, ".kya/manifest.json"), "utf8"));

const EXISTING = `${JSON.stringify({
  permissions: { allow: ["Bash(ls)"] },
  env: { A: "1" },
  enabledPlugins: { "x@y": true },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
}, null, 2)}\n`;

describe.skipIf(!haveDist || isPre)("kya-team-init-guard: kya team init --guard (built CLI)", () => {
  it("--guard --dry-run prints the diff and the badge and writes nothing (project and home trees equal)", () => {
    const fx = fixture(EXISTING);
    const before = { p: tree(fx.proj), h: tree(fx.home) };
    const r = kya(fx, ["team", "init", "--guard", "--dry-run"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Would write");
    expect(r.out).toContain("--- a/.claude/settings.json");
    expect(r.out).toContain("+++ b/.claude/settings.json");
    expect(r.out).toContain('+    "kya-guard@shield-kya": true');
    expect(r.out).toContain(`"ref": "v${version}"`);
    expect(r.out).toContain(GUARD_BADGE);
    expect(GUARD_BADGE).toMatch(/^\[!\[agent-guarded\]\(https:\/\/img\.shields\.io\/[^)]*agent--guarded[^)]*\)\]\(https:\/\/shield-agent\.com\/replays\)$/);
    expect({ p: tree(fx.proj), h: tree(fx.home) }).toEqual(before);
  });

  it("--guard --dry-run in an empty project writes nothing, not even a .claude folder, and diffs against /dev/null", () => {
    const fx = fixture();
    const r = kya(fx, ["team", "init", "--guard", "--dry-run"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("--- /dev/null");
    expect(tree(fx.proj)).toEqual({});
    expect(tree(fx.home)).toEqual({});
  });

  it("--guard writes the marketplace pin and kya-guard only, keeps every other key, adds no kya plugin and no policy file", () => {
    const fx = fixture(EXISTING);
    const r = kya(fx, ["team", "init", "--guard"]);
    expect(r.code, r.err).toBe(0);
    const s = settingsOf(fx);
    expect(s.extraKnownMarketplaces["shield-kya"]).toEqual({ source: { source: "github", repo: "The-Pixel-Boys/shield-kya", ref: `v${version}` } });
    expect(s.enabledPlugins).toEqual({ "x@y": true, "kya-guard@shield-kya": true });
    expect(s.enabledPlugins["kya@shield-kya"]).toBeUndefined();
    expect(s.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(s.env).toEqual({ A: "1" });
    expect(s.hooks).toEqual(JSON.parse(EXISTING).hooks);
    expect(existsSync(join(fx.proj, ".kya"))).toBe(false);
  });

  it("a second --guard run changes nothing: project tree and manifest stay byte for byte", () => {
    const fx = fixture(EXISTING);
    expect(kya(fx, ["team", "init", "--guard"]).code).toBe(0);
    const before = { p: tree(fx.proj), h: tree(fx.home) };
    const r = kya(fx, ["team", "init", "--guard"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("nothing to do");
    expect({ p: tree(fx.proj), h: tree(fx.home) }).toEqual(before);
  });

  it("records the write in ~/.kya/manifest.json (project scope, merged, with a backup of the original bytes)", () => {
    const fx = fixture(EXISTING);
    expect(kya(fx, ["team", "init", "--guard"]).code).toBe(0);
    const m = manifestOf(fx);
    expect(m.entries).toHaveLength(1);
    const e = m.entries[0];
    expect(e.path).toBe(join(fx.proj, ".claude/settings.json"));
    expect(e).toMatchObject({ action: "merged", scope: "project", project: fx.proj });
    expect(readFileSync(e.backup, "utf8")).toBe(EXISTING);
    expect(JSON.stringify(e.added)).toContain("kya-guard@shield-kya");
  });

  it("kya uninstall --project restores settings.json byte for byte and the project tree is as before", () => {
    const fx = fixture(EXISTING);
    const before = tree(fx.proj);
    expect(kya(fx, ["team", "init", "--guard"]).code).toBe(0);
    expect(tree(fx.proj)).not.toEqual(before);
    const u = kya(fx, ["uninstall", "--project"]);
    expect(u.code, u.err).toBe(0);
    expect(u.out).toContain("restored byte for byte");
    expect(tree(fx.proj)).toEqual(before);
    expect(readFileSync(join(fx.proj, ".claude/settings.json"), "utf8")).toBe(EXISTING);
  });

  it("kya uninstall --project removes a settings file and a .claude folder that --guard created", () => {
    const fx = fixture();
    expect(kya(fx, ["team", "init", "--guard"]).code).toBe(0);
    expect(existsSync(join(fx.proj, ".claude/settings.json"))).toBe(true);
    const u = kya(fx, ["uninstall", "--project"]);
    expect(u.code, u.err).toBe(0);
    expect(tree(fx.proj)).toEqual({});
  });

  it("uninstall --project after somebody edited the file keeps their edit and removes only the guard keys", () => {
    const fx = fixture(EXISTING);
    expect(kya(fx, ["team", "init", "--guard"]).code).toBe(0);
    const s = settingsOf(fx);
    s.env.B = "2";
    writeFileSync(join(fx.proj, ".claude/settings.json"), `${JSON.stringify(s, null, 2)}\n`);
    const u = kya(fx, ["uninstall", "--project"]);
    expect(u.code, u.err).toBe(0);
    const after = settingsOf(fx);
    expect(after.env).toEqual({ A: "1", B: "2" });
    expect(after.enabledPlugins).toEqual({ "x@y": true });
    expect(after.extraKnownMarketplaces).toBeUndefined();
  });

  it("moves an older pin to this kya's tag and the uninstall puts the old file back", () => {
    const old = `${JSON.stringify({ extraKnownMarketplaces: { "shield-kya": { source: { source: "github", repo: "The-Pixel-Boys/shield-kya", ref: "v0.1.0" } } } }, null, 2)}\n`;
    const fx = fixture(old);
    const r = kya(fx, ["team", "init", "--guard"]);
    expect(r.code, r.err).toBe(0);
    expect(settingsOf(fx).extraKnownMarketplaces["shield-kya"].source.ref).toBe(`v${version}`);
    expect(r.out).toContain('-        "ref": "v0.1.0"');
    expect(kya(fx, ["uninstall", "--project"]).code).toBe(0);
    expect(readFileSync(join(fx.proj, ".claude/settings.json"), "utf8")).toBe(old);
  });

  it("--guard --json carries the diff, the badge and the guard flag", () => {
    const fx = fixture(EXISTING);
    const r = kya(fx, ["team", "init", "--guard", "--dry-run", "--json"]);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ guard: true, dryRun: true, written: false, badge: GUARD_BADGE });
    expect(j.diff).toContain("+++ b/.claude/settings.json");
  });

  describe("refusals: exit 1 and nothing written (project and home trees equal)", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["the full kya plugin is on", JSON.stringify({ enabledPlugins: { "kya@shield-kya": true } }), /kya and kya-guard together write two rows/],
      ["kya-guard was turned off by hand", JSON.stringify({ enabledPlugins: { "kya-guard@shield-kya": false } }), /is false \(someone turned it off\)/],
      ["settings.json is not valid JSON", "{ nope", /not valid JSON/],
      ["shield-kya points to another source", JSON.stringify({ extraKnownMarketplaces: { "shield-kya": { source: { source: "github", repo: "evil/x" } } } }), /already points somewhere else/],
    ];
    for (const [name, content, msg] of cases) {
      it(name, () => {
        const fx = fixture(content);
        const before = { p: tree(fx.proj), h: tree(fx.home) };
        const r = kya(fx, ["team", "init", "--guard"]);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(msg);
        expect({ p: tree(fx.proj), h: tree(fx.home) }).toEqual(before);
      });
    }

    it("run from the user-level Claude directory is refused (never writes the real home)", () => {
      const fx = fixture();
      mkdirSync(join(fx.home, ".claude"));
      const r = spawnSync(process.execPath, [cliJs, "team", "init", "--guard"], {
        cwd: fx.home, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home, KYA_TELEMETRY: "0" },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/user-level Claude Code directory/);
      expect(readdirSync(join(fx.home, ".claude"))).toEqual([]);
    });
  });

  it("plain `team init` (no --guard) still enables kya@shield-kya, writes no manifest and says nothing of a badge", () => {
    const fx = fixture();
    const r = kya(fx, ["team", "init"]);
    expect(r.code, r.err).toBe(0);
    expect(settingsOf(fx).enabledPlugins).toEqual({ "kya@shield-kya": true });
    expect(existsSync(join(fx.home, ".kya"))).toBe(false);
    expect(r.out).not.toContain("agent-guarded");
  });
});

describe.skipIf(!haveDist || !isPre)("kya-team-init-guard: a prerelease kya refuses --guard (no public tag to pin)", () => {
  it("exit 1, nothing written", () => {
    const fx = fixture();
    const r = kya(fx, ["team", "init", "--guard"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/prerelease kya has no public tag/);
    expect(tree(fx.proj)).toEqual({});
  });
});

describe("kya-team-init-guard: unifiedDiff", () => {
  it("is empty for equal texts and shows one changed line with context", () => {
    expect(unifiedDiff("f", "a\nb\n", "a\nb\n")).toBe("");
    expect(unifiedDiff("f", "a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n")).toBe(["--- a/f", "+++ b/f", "@@ -1,5 +1,5 @@", " a", " b", "-c", "+X", " d", " e"].join("\n"));
  });
  it("diffs a new file against /dev/null", () => {
    expect(unifiedDiff("f", "", "a\n")).toBe(["--- /dev/null", "+++ b/f", "@@ -1,0 +1,1 @@", "+a"].join("\n"));
  });
});
