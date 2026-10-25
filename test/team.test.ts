/**
 * `kya team init` / `kya team managed-settings`.
 * Unit: merge rules and refusals. Integration: the built CLI in a temp HOME + temp project, the output checked
 * against the documented settings schema. E2E (opt-in, KYA_CLAUDE_E2E=1 and `claude` on PATH): a clean-HOME
 * `claude -p` session of a second user (clean HOME, fresh clone of the lead's commit) loads the plugin at the pinned tag (no model call:
 * the API base URL is a dead loopback port), and the untrusted-folder case loads nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { managedSettings, marketplaceSource, mergeTeamSettings, releaseRef, runTeamInit } from "../src/commands/team.js";

const root = join(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
// A prerelease kya refuses team init (no public tag). In-process tests run as the matching stable version, so they
// also pass on a release-candidate commit; the built-CLI tests below use the real version and expect the refusal.
const isPre = version.includes("-");
const stable = version.split("-")[0]!;
vi.mock("../src/version.js", async (orig) => {
  const m = await orig<typeof import("../src/version.js")>();
  return { ...m, CLI_VERSION: m.CLI_VERSION.split("-")[0]! };
});
const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
const cliJs = join(root, "dist/cli.js");
const posix = process.platform !== "win32";
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "kya-team-")));
const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));

function project(content?: string): string {
  const dir = tmp();
  if (content !== undefined) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/settings.json"), content);
  }
  return dir;
}

/**
 * Documented shape (code.claude.com/docs/en/plugins/marketplace-reference, /plugins/org):
 * extraKnownMarketplaces.<name> = { source, autoUpdate? }, github source = { source, repo, ref?, path?, sparsePaths? }
 * with repo naming one repository; enabledPlugins = { "<plugin>@<marketplace>": boolean }.
 */
function assertDocumentedShape(s: Record<string, any>) {
  const m = s.extraKnownMarketplaces[marketplace.name];
  expect(Object.keys(m).every((k) => ["source", "autoUpdate"].includes(k))).toBe(true);
  expect(Object.keys(m.source).every((k) => ["source", "repo", "ref", "path", "sparsePaths"].includes(k))).toBe(true);
  expect(m.source.source).toBe("github");
  expect(m.source.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
  expect(m.source.ref).toBe(`v${stable}`); // a release tag, never a branch
  for (const [id, on] of Object.entries(s.enabledPlugins)) {
    expect(typeof on).toBe("boolean");
    expect(id).toMatch(/^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/);
  }
  const [plugin, market] = "kya@shield-kya".split("@");
  expect(s.enabledPlugins["kya@shield-kya"]).toBe(true);
  expect(market).toBe(marketplace.name);
  expect(marketplace.plugins.map((p: any) => p.name)).toContain(plugin);
}

describe("team init: merge", () => {
  it("pins the public release tag v<package.json version>, never a branch", () => {
    expect(releaseRef()).toBe(`v${stable}`);
    expect(managedSettings().extraKnownMarketplaces).toEqual({
      "shield-kya": { source: { source: "github", repo: "The-Pixel-Boys/shield-kya", ref: `v${stable}` } },
    });
  });

  it("creates .claude/settings.json in an empty project", () => {
    const dir = project();
    const r = runTeamInit({ cwd: dir, env: {} });
    expect(r.written).toBe(true);
    expect(settingsOf(dir)).toEqual(managedSettings());
    assertDocumentedShape(settingsOf(dir));
  });

  it("keeps every existing key and the file's indent", () => {
    const before = { permissions: { allow: ["Bash(ls)"] }, enabledPlugins: { "x@y": false }, extraKnownMarketplaces: { y: { source: { source: "github", repo: "o/y" } } }, env: { A: "1" } };
    const dir = project(JSON.stringify(before, null, 4) + "\n");
    runTeamInit({ cwd: dir, env: {} });
    const text = readFileSync(join(dir, ".claude/settings.json"), "utf8");
    expect(text).toMatch(/^\{\n {4}"permissions"/);
    const after = JSON.parse(text);
    expect(after.permissions).toEqual(before.permissions);
    expect(after.env).toEqual(before.env);
    expect(after.enabledPlugins).toEqual({ "x@y": false, "kya@shield-kya": true });
    expect(after.extraKnownMarketplaces.y).toEqual(before.extraKnownMarketplaces.y);
    assertDocumentedShape(after);
  });

  it("says so when the existing layout gets normalized, and not otherwise", () => {
    const compact = project('{"permissions":{"allow":["Bash(ls)"]}}');
    expect(runTeamInit({ cwd: compact, env: {}, dryRun: true }).reformatted).toBe(true);
    const canonical = project(JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2) + "\n");
    const r = runTeamInit({ cwd: canonical, env: {} });
    expect(r.reformatted).toBe(false);
    expect(readFileSync(join(canonical, ".claude/settings.json"), "utf8").startsWith('{\n  "permissions": {\n    "allow": [\n      "Bash(ls)"\n    ]\n  },')).toBe(true);
  });

  it("is idempotent: a second run changes nothing and does not rewrite", () => {
    const dir = project();
    runTeamInit({ cwd: dir, env: {} });
    const first = readFileSync(join(dir, ".claude/settings.json"), "utf8");
    const r = runTeamInit({ cwd: dir, env: {} });
    expect(r.changes).toEqual([]);
    expect(r.written).toBe(false);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(first);
  });

  it("moves an old ref to the current tag and keeps other entry fields (upgrade path)", () => {
    const s: Record<string, any> = {
      extraKnownMarketplaces: { "shield-kya": { source: { source: "github", repo: "The-Pixel-Boys/shield-kya", ref: "v0.0.1" }, autoUpdate: false } },
    };
    const changes = mergeTeamSettings(s);
    expect(changes.join("\n")).toContain(`"v0.0.1" -> "v${stable}"`);
    expect(s.extraKnownMarketplaces["shield-kya"]).toEqual({ source: { source: "github", repo: "The-Pixel-Boys/shield-kya", ref: `v${stable}` }, autoUpdate: false });
  });

  it.each([
    ["invalid JSON", "{ nope"],
    ["a non-object", "[]"],
    ["a non-object extraKnownMarketplaces", JSON.stringify({ extraKnownMarketplaces: [] })],
    ["a non-object enabledPlugins", JSON.stringify({ enabledPlugins: "x" })],
    ["shield-kya pointing at another repo", JSON.stringify({ extraKnownMarketplaces: { "shield-kya": { source: { source: "github", repo: "evil/fork" } } } })],
    ["an explicit kya@shield-kya: false", JSON.stringify({ enabledPlugins: { "kya@shield-kya": false } })],
    ["the additionalMarketplaces alias (ours would shadow it)", JSON.stringify({ additionalMarketplaces: { y: { source: { source: "github", repo: "o/y" } } } })],
  ])("refuses %s without writing", (_label, content) => {
    const dir = project(content);
    expect(() => runTeamInit({ cwd: dir, env: {} })).toThrow(/nothing was written|by hand/);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(content);
  });

  it("--dry-run writes nothing and shows the change", () => {
    const dir = project();
    const r = runTeamInit({ cwd: dir, env: {}, dryRun: true });
    expect(r.written).toBe(false);
    expect(r.changes.length).toBe(2);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it.skipIf(!posix)("refuses a symlinked .claude dir and a symlinked settings.json", () => {
    const target = tmp();
    const a = tmp();
    symlinkSync(target, join(a, ".claude"));
    expect(() => runTeamInit({ cwd: a, env: {} })).toThrow(/symlink/);
    const b = tmp();
    mkdirSync(join(b, ".claude"));
    writeFileSync(join(target, "s.json"), "{}");
    symlinkSync(join(target, "s.json"), join(b, ".claude/settings.json"));
    expect(() => runTeamInit({ cwd: b, env: {} })).toThrow(/symlink/);
    expect(readFileSync(join(target, "s.json"), "utf8")).toBe("{}");
    expect(readdirSync(target)).toEqual(["s.json"]);
  });

  it("refuses a .claude that is a file and a settings.json that is a directory", () => {
    const a = tmp();
    writeFileSync(join(a, ".claude"), "x");
    expect(() => runTeamInit({ cwd: a, env: {} })).toThrow(/not a regular directory/);
    expect(readFileSync(join(a, ".claude"), "utf8")).toBe("x");
    const b = tmp();
    mkdirSync(join(b, ".claude/settings.json"), { recursive: true });
    expect(() => runTeamInit({ cwd: b, env: {} })).toThrow(/not a regular file/);
  });

  it.skipIf(!posix)("a repo-planted symlink at the old temp name cannot redirect the write", () => {
    const dir = project("{}");
    const victim = join(tmp(), "victim");
    writeFileSync(victim, "precious");
    symlinkSync(victim, join(dir, `.claude/settings.json.kya-tmp-${process.pid}`));
    runTeamInit({ cwd: dir, env: {} });
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(lstatSync(join(dir, ".claude/settings.json")).isFile()).toBe(true);
    assertDocumentedShape(settingsOf(dir));
  });

  it("warns when the existing pin is newer than this kya (downgrade)", () => {
    const s: Record<string, any> = { extraKnownMarketplaces: { "shield-kya": { source: { source: "github", repo: "The-Pixel-Boys/shield-kya", ref: "v999.0.0" } } } };
    expect(mergeTeamSettings(s).join("\n")).toMatch(/! downgrade: the file pins v999\.0\.0/);
    const t: Record<string, any> = { extraKnownMarketplaces: { "shield-kya": { source: { source: "github", repo: "The-Pixel-Boys/shield-kya", ref: "v0.0.1" } } } };
    expect(mergeTeamSettings(t).join("\n")).not.toMatch(/downgrade/);
  });

  it("compares prerelease and stable pins by SemVer precedence, both ways", () => {
    const pin = (ref: string): Record<string, any> => ({ extraKnownMarketplaces: { "shield-kya": { source: { source: "github", repo: "The-Pixel-Boys/shield-kya", ref } } } });
    // A stable kya and an older or prerelease pin of the same version: an upgrade, no warning.
    expect(mergeTeamSettings(pin("v0.32.6-rc.1"), "0.32.6").join("\n")).not.toMatch(/downgrade/);
    expect(mergeTeamSettings(pin("v0.32.5"), "0.32.6").join("\n")).not.toMatch(/downgrade/);
    // A stable kya and a newer stable or prerelease pin: downgrade.
    expect(mergeTeamSettings(pin("v0.33.0"), "0.32.6").join("\n")).toMatch(/! downgrade: the file pins v0\.33\.0,/);
    expect(mergeTeamSettings(pin("v0.32.7-rc.1"), "0.32.6").join("\n")).toMatch(/! downgrade: the file pins v0\.32\.7-rc\.1,/);
    expect(mergeTeamSettings(pin("v0.33.0-rc.1"), "0.32.6").join("\n")).toMatch(/! downgrade: the file pins v0\.33\.0-rc\.1,/);
    // Not a release tag: never a downgrade.
    expect(mergeTeamSettings(pin("main"), "0.32.6").join("\n")).not.toMatch(/downgrade/);
  });

  it("refuses a prerelease kya: shield-kya has no public tag for it, so nothing is written", () => {
    const msg = /prerelease kya has no public tag; use a stable kya/;
    expect(() => marketplaceSource("0.32.6-rc.1")).toThrow(msg);
    expect(() => managedSettings("0.32.6-rc.1")).toThrow(msg);
    expect(() => mergeTeamSettings({}, "0.32.6-rc.1")).toThrow(msg);
    const dir = project("{}");
    const before = readFileSync(join(dir, ".claude/settings.json"), "utf8");
    expect(() => runTeamInit({ cwd: dir, env: {}, version: "0.32.6-rc.1" })).toThrow(msg);
    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(before);
    const fresh = tmp();
    expect(() => runTeamInit({ cwd: fresh, env: {}, version: "0.32.6-rc.1" })).toThrow(msg);
    expect(existsSync(join(fresh, ".claude"))).toBe(false);
    // A stable version still pins its tag.
    expect(marketplaceSource("0.32.6").ref).toBe("v0.32.6");
  });

  it("refuses when the project .claude is the user-level Claude dir (CLAUDE_CONFIG_DIR)", () => {
    const dir = project();
    expect(() => runTeamInit({ cwd: dir, env: { CLAUDE_CONFIG_DIR: join(dir, ".claude") } })).toThrow(/user-level/);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it.skipIf(!posix || process.getuid?.() === 0)("a read-only project fails with an error and leaves no file", async () => {
    const dir = project();
    chmodSync(dir, 0o555);
    const errors: string[] = [];
    const code = await runCli(["team", "init"], { log: () => {}, error: (m) => errors.push(m), exit: () => {} }, {}, dir);
    chmodSync(dir, 0o755);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/EACCES|permission/i);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });
});

describe("team: CLI wiring", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m), exit: () => {} } };
  };

  it("managed-settings prints the same pinned document", async () => {
    const t = io();
    expect(await runCli(["team", "managed-settings"], t.io, {}, tmp())).toBe(0);
    const doc = JSON.parse(t.out.join("\n"));
    expect(doc).toEqual(managedSettings());
    assertDocumentedShape(doc);
    expect(doc).not.toHaveProperty("strictKnownMarketplaces");
    expect(doc).not.toHaveProperty("allowManagedHooksOnly");
  });

  it("init prints what it wrote and the trust prompt note; --dry-run x does not swallow the flag", async () => {
    const dir = project();
    const t = io();
    expect(await runCli(["team", "init", "--dry-run", "x"], t.io, {}, dir)).toBe(0);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(t.out.join("\n")).toMatch(/Would write/);
    const w = io();
    expect(await runCli(["team", "init"], w.io, {}, dir)).toBe(0);
    const text = w.out.join("\n");
    expect(text).toMatch(/Wrote .*settings\.json/);
    expect(text).toMatch(/folder trust prompt once/);
    expect(text).toMatch(/fails open/);
    expect(text).toContain(`git ls-remote https://github.com/The-Pixel-Boys/shield-kya refs/tags/v${stable}`);
    expect(text).toMatch(/plugin skipped, not an error/);
  });

  it("kya --dry-run team init (switch before the subcommand) is a dry run and writes nothing", async () => {
    const dir = project();
    const t = io();
    expect(await runCli(["--dry-run", "team", "init"], t.io, {}, dir)).toBe(0);
    expect(t.out.join("\n")).toMatch(/Would write/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("unknown subcommand is a usage error", async () => {
    const t = io();
    expect(await runCli(["team"], t.io, {}, tmp())).toBe(2);
  });
});

describe("team: docs", () => {
  const doc = (rel: string) => readFileSync(join(root, rel), "utf8");
  it("every documented shield-kya github source carries a tag ref (no floating pin)", () => {
    for (const f of ["docs/team-rollout.md", "docs/hosts/claude-plugin.md"]) {
      const sources = [...doc(f).matchAll(/\{[^{}]*"repo": "The-Pixel-Boys\/shield-kya"[^{}]*\}/g)].map((m) => m[0]);
      expect(sources.length, f).toBeGreaterThan(0);
      for (const s of sources) expect(s, f).toMatch(/"ref": "vX\.Y\.Z"/);
    }
  });

  it("team-rollout.md is public-safe and linked from the plugin guide", () => {
    const text = doc("docs/team-rollout.md");
    expect(text).not.toMatch(/\/Users\/|pip install|[\u2013\u2014]/);
    expect(text).toMatch(/fails open/);
    expect(text).toMatch(/Hosted enforcement is a separate product/);
    expect(doc("docs/hosts/claude-plugin.md")).toContain("(../team-rollout.md)");
  });
});

describe("integration: the built CLI in a temp HOME and project", () => {
  const haveDist = existsSync(cliJs);
  const run = (args: string[], cwd: string, home: string) =>
    spawnSync(process.execPath, [cliJs, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, KYA_TELEMETRY: "0" } });

  it.skipIf(!haveDist)("writes only the project file; HOME stays untouched", () => {
    const home = tmp();
    const dir = project();
    const r = run(["team", "init"], dir, home);
    if (isPre) {
      // This commit is a prerelease: the real CLI refuses and writes nothing.
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/prerelease kya has no public tag; use a stable kya/);
      expect(readdirSync(dir)).toEqual([]);
      expect(readdirSync(home)).toEqual([]);
      return;
    }
    expect(r.status, r.stderr).toBe(0);
    assertDocumentedShape(settingsOf(dir));
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(dir)).toEqual([".claude"]);
    expect(readdirSync(join(dir, ".claude"))).toEqual(["settings.json"]);
  });

  it.skipIf(!haveDist)("team managed-settings with the real package version: refuses a prerelease, pins a stable tag", () => {
    const r = run(["team", "managed-settings"], tmp(), tmp());
    if (isPre) {
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/prerelease kya has no public tag; use a stable kya/);
      expect(r.stdout).not.toMatch(/extraKnownMarketplaces/);
      return;
    }
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).extraKnownMarketplaces["shield-kya"].source.ref).toBe(`v${version}`);
  });

  it.skipIf(!haveDist)("run from HOME itself: refuses, ~/.claude untouched", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude/settings.json"), "{}");
    const r = run(["team", "init"], home, home);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/user-level/);
    expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe("{}");
  });

  it.skipIf(!haveDist || !posix)("HOME behind a symlink with no ~/.claude yet: run from HOME still refuses", () => {
    const realHome = tmp();
    const link = join(tmp(), "home-link");
    symlinkSync(realHome, link);
    const r = run(["team", "init"], realHome, link);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/user-level/);
    expect(readdirSync(realHome)).toEqual([]);
  });
});

const haveClaude = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
// Skipped on a prerelease commit: the built CLI refuses team init there (no public tag to pin).
describe.skipIf(isPre || !(haveClaude && process.env.KYA_CLAUDE_E2E === "1" && existsSync(cliJs)))("e2e: claude loads the plugin from the generated project settings", () => {
  /**
   * The public repo may not carry the tag yet, so the marketplace is served from a local git repo that has the
   * tag v<version> while its default branch has moved on; the generated github source is swapped for a git source
   * with the same ref. Proves Claude Code honors the ref and loads the relative-path plugin from that checkout.
   */
  function fixture(trusted: boolean) {
    const base = tmp();
    const homeA = join(base, "home-a"); // team lead: runs kya team init and commits
    const home = join(base, "home-b"); // teammate: clean HOME, fresh clone, runs claude
    const mk = join(base, "mk");
    const lead = join(base, "lead");
    for (const d of [homeA, home, mk, lead]) mkdirSync(d);
    cpSync(join(root, ".claude-plugin"), join(mk, ".claude-plugin"), { recursive: true });
    cpSync(join(root, "plugins"), join(mk, "plugins"), { recursive: true });
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: mk, encoding: "utf8" });
    expect(spawnSync("claude", ["plugin", "validate", mk], { encoding: "utf8" }).status).toBe(0);
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "release");
    git("tag", `v${stable}`);
    git("checkout", "-qb", "moved-on");
    writeFileSync(join(mk, "drift"), "x");
    git("add", "drift");
    git("commit", "-qm", "drift");
    const r = spawnSync(process.execPath, [cliJs, "team", "init"], { cwd: lead, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: homeA } });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(homeA)).toEqual([]);
    const s = settingsOf(lead);
    s.extraKnownMarketplaces["shield-kya"].source = { source: "git", url: `file://${mk}`, ref: s.extraKnownMarketplaces["shield-kya"].source.ref };
    writeFileSync(join(lead, ".claude/settings.json"), JSON.stringify(s, null, 2));
    const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
    g(lead, "init", "-q");
    g(lead, "add", ".claude/settings.json");
    g(lead, "commit", "-qm", "chore: enable the kya Claude Code plugin");
    const proj = join(base, "clone");
    expect(g(base, "clone", "-q", lead, proj).status).toBe(0);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [proj]: { hasTrustDialogAccepted: trusted } } }));
    return { home, proj };
  }

  /** Start `claude -p`, return the init event's plugins, then stop. The API is a dead port: no model call. */
  function initPlugins(home: string, proj: string): Promise<{ name: string; source: string; path: string }[]> {
    return new Promise((resolve, reject) => {
      const child = spawn("claude", ["-p", "hi", "--output-format", "stream-json", "--verbose", "--max-turns", "1"], {
        cwd: proj,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          ANTHROPIC_API_KEY: "sk-ant-e2e-invalid",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
          CLAUDE_CODE_SYNC_PLUGIN_INSTALL: "1",
        },
      });
      let buf = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("no init event")); }, 150_000);
      child.stdout.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        for (const line of buf.split("\n")) {
          if (!line.includes('"subtype":"init"')) continue;
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(JSON.parse(line).plugins ?? []);
          return;
        }
      });
      child.on("error", reject);
    });
  }

  it("trusted folder: kya@shield-kya loads from the tagged checkout; the installed hook denies the never-list", async () => {
    const { home, proj } = fixture(true);
    const plugins = await initPlugins(home, proj);
    const kya = plugins.find((p) => p.source === "kya@shield-kya");
    expect(kya, JSON.stringify(plugins)).toBeDefined();
    const checkout = join(home, ".claude/plugins/marketplaces/shield-kya");
    expect(spawnSync("git", ["describe", "--tags"], { cwd: checkout, encoding: "utf8" }).stdout.trim()).toBe(`v${stable}`);
    expect(existsSync(join(checkout, "drift"))).toBe(false);
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(false); // nothing written to user settings

    // SessionStart bootstrap installed kya into the plugin data dir; run the PreToolUse command the way hooks.json does.
    const cli = join(home, ".claude/plugins/data/kya-shield-kya/node_modules/@shield-agent/kya/dist/cli.js");
    expect(existsSync(cli)).toBe(true);
    const deny = spawnSync(process.execPath, [cli, "hook", "--host", "claude"], {
      input: JSON.stringify({ session_id: "s-team", hook_event_name: "PreToolUse", tool_name: "mcp__postgres__drop_table", tool_input: {}, tool_use_id: "toolu_team1" }),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home },
    });
    expect(deny.status).toBe(2);
  }, 200_000);

  it("untrusted folder: the marketplace is ignored and the plugin does not load", async () => {
    const { home, proj } = fixture(false);
    const plugins = await initPlugins(home, proj);
    expect(plugins.find((p) => p.source === "kya@shield-kya")).toBeUndefined();
    expect(existsSync(join(home, ".claude/plugins/marketplaces/shield-kya"))).toBe(false);
  }, 200_000);
});
