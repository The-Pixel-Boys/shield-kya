/**
 * Feature kya-start (plan, consent, dry run, manifest) and kya-uninstall.
 * Real-stack e2e: the built dist/cli.js (run `pnpm build` first) against a temp HOME and a temp git
 * project. Never touches the real home. Spec: Shield KYA first-run spec, item F2 (consent and undo).
 *
 * Commands as written: kya start, --yes, --dry-run, KYA_YES, kya uninstall, --project.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  renameSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCli, type CliIo } from "../src/cli.js";
import { launcherScript } from "../src/commands/wire-hooks.js";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const posix = process.platform !== "win32";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fx {
  base: string;
  home: string;
  proj: string;
}

/** Temp home with Claude Code evidence (and a user settings file), plus a temp git project. */
function fixture(opts: { cursor?: boolean; grok?: boolean; kimi?: boolean; git?: boolean } = {}): Fx {
  const base = mkdtempSync(join(tmpdir(), "kya-consent-"));
  dirs.push(base);
  const home = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  // User content with a layout KYA would not produce (tab-less odd spacing, no trailing newline).
  writeFileSync(join(home, ".claude", "settings.json"), '{"model":  "opus",\n "hooks": {"PostToolUse": [{"matcher":"x"}]}}');
  writeFileSync(join(home, ".claude.json"), '{ "theme":"dark",\n  "mcpServers": {"mine": {"command": "x"}} }\n');
  if (opts.cursor) mkdirSync(join(home, ".cursor"));
  if (opts.grok) mkdirSync(join(home, ".grok"));
  if (opts.kimi) mkdirSync(join(home, ".kimi-code"));
  if (opts.git !== false) {
    mkdirSync(join(proj, ".git"));
    writeFileSync(join(proj, ".gitignore"), "node_modules/\ndist");
  }
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
    ...extra,
  };
  delete e.CI;
  delete e.KYA_YES;
  return { ...e, ...extra };
}

function kya(fx: Fx, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [cliJs, ...args], { cwd: fx.proj, encoding: "utf8", timeout: 60_000, env: env(fx, extra) });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

const START = ["start", "--no-open", "--no-gate"];

/** path -> sha256 for every file under dir (skips .git internals). */
function hashTree(dir: string, root = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    if (name === ".git" && dir === root) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) hashTree(p, root, out);
    else out[relative(root, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}

function snapshot(fx: Fx): { home: Record<string, string>; proj: Record<string, string> } {
  return { home: hashTree(fx.home), proj: hashTree(fx.proj) };
}

function manifestOf(fx: Fx): { entries: { path: string; action: string; keys: string[]; backup?: string; scope: string }[] } {
  return JSON.parse(readFileSync(join(fx.home, ".kya", "manifest.json"), "utf8"));
}

describe.skipIf(!posix)("kya start: plan, consent, dry run (real CLI, temp HOME)", () => {
  it("--dry-run prints the plan with every file, created or merged, and the exact keys, and writes nothing", () => {
    const fx = fixture();
    const before = snapshot(fx);
    const r = kya(fx, [...START, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("KYA start will make these changes:");
    expect(r.out).toMatch(/create\s+\.mcp\.json/);
    expect(r.out).toContain("+ mcpServers.shield-kya");
    expect(r.out).toMatch(/merge\s+~\/\.claude\.json/);
    expect(r.out).toMatch(/merge\s+~\/\.claude\/settings\.json/);
    expect(r.out).toContain("+ hooks.PreToolUse[+] hook --host claude");
    expect(r.out).toMatch(/create\s+~\/\.kya\/bin\/kya-hook/);
    expect(r.out).toMatch(/append\s+\.gitignore/);
    expect(r.out).toContain("+ .kya/*");
    expect(r.out).toContain("+ !.kya/policy.json");
    expect(r.out).toContain("Undo everything with: kya uninstall");
    expect(r.out).toContain("Dry run: nothing was written.");
    // Hash the home dir and the project before and after: not one byte or file changed.
    expect(snapshot(fx)).toEqual(before);
    expect(existsSync(join(fx.home, ".kya"))).toBe(false);
    expect(existsSync(join(fx.proj, ".kya"))).toBe(false);
  });

  it("--dry-run --json prints the plan as data and writes nothing", () => {
    const fx = fixture();
    const before = snapshot(fx);
    const r = kya(fx, [...START, "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { applied: boolean; dryRun: boolean; plan: { items: { action: string; keys: string[] }[] } };
    expect(j.applied).toBe(false);
    expect(j.dryRun).toBe(true);
    expect(j.plan.items.some((i) => i.action === "merge" && i.keys.includes("mcpServers.shield-kya"))).toBe(true);
    expect(snapshot(fx)).toEqual(before);
  });

  it("bare --dry-run (gateway on, report on) lists the gateway files and keys and changes nothing", () => {
    const fx = fixture();
    writeFileSync(join(fx.home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "npx", args: ["gh-mcp"] } } }));
    const before = snapshot(fx);
    const r = kya(fx, ["start", "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/create\s+~\/\.kya\/gateways\.json/);
    expect(r.out).toContain("servers: 1 imported (github)");
    expect(r.out).toContain("- mcpServers.github (moved to the gateway; original backed up)");
    expect(r.out).toContain("mcpServers.shield-kya-gate (gateway entry)");
    expect(r.out).toContain("starts the local report server in the background");
    expect(snapshot(fx)).toEqual(before);
  });

  it("bare start off a terminal (gateway on, report on) writes nothing and starts nothing", () => {
    const fx = fixture();
    writeFileSync(join(fx.home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "npx", args: ["gh-mcp"] } } }));
    const before = snapshot(fx);
    const r = kya(fx, ["start"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("Nothing was written (not a terminal)");
    expect(snapshot(fx)).toEqual(before);
  });

  it("off a terminal without --yes it prints the plan, writes nothing and exits 0", () => {
    const fx = fixture();
    const before = snapshot(fx);
    const r = kya(fx, START);
    expect(r.code).toBe(0);
    expect(r.out).toContain("KYA start will make these changes:");
    expect(r.all).toContain("Nothing was written (not a terminal)");
    expect(snapshot(fx)).toEqual(before);
  });

  it("in CI (CI=1) without --yes it also writes nothing and exits 0", () => {
    const fx = fixture();
    const before = snapshot(fx);
    const r = kya(fx, START, { CI: "1" });
    expect(r.code).toBe(0);
    expect(snapshot(fx)).toEqual(before);
  });

  it("--json without --yes does not apply and says so", () => {
    const fx = fixture();
    const before = snapshot(fx);
    const r = kya(fx, [...START, "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { applied: boolean }).applied).toBe(false);
    expect(snapshot(fx)).toEqual(before);
  });

  it("--yes applies the plan", () => {
    const fx = fixture();
    const r = kya(fx, [...START, "--yes"]);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(true);
    expect(existsSync(join(fx.proj, ".kya", "config.json"))).toBe(true);
    const claude = JSON.parse(readFileSync(join(fx.home, ".claude.json"), "utf8")) as { theme: string; mcpServers: Record<string, unknown> };
    expect(claude.theme).toBe("dark");
    expect(claude.mcpServers["mine"]).toBeDefined();
    expect(claude.mcpServers["shield-kya"]).toBeDefined();
    const settings = JSON.parse(readFileSync(join(fx.home, ".claude", "settings.json"), "utf8")) as { hooks: { PostToolUse: unknown[]; PreToolUse: { hooks: { command: string }[] }[] } };
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain(join(".kya", "bin", "kya-hook"));
  });

  it("KYA_YES=1 applies the plan", () => {
    const fx = fixture();
    const r = kya(fx, START, { KYA_YES: "1" });
    expect(r.code, r.all).toBe(0);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(true);
    expect(manifestOf(fx).entries.length).toBeGreaterThan(0);
  });

  it("writes less: no .cursor/mcp.json without Cursor, no generic mcp.json, no .env.example, tools.sample.json or orr-report", () => {
    const fx = fixture();
    expect(kya(fx, [...START, "--yes"]).code).toBe(0);
    for (const p of [join(".cursor", "mcp.json"), "mcp.json", ".env.example", join(".kya", "tools.sample.json"), "orr-report"]) {
      expect(existsSync(join(fx.proj, p)), p).toBe(false);
    }
    expect(existsSync(join(fx.home, ".cursor"))).toBe(false);
  });

  it("with Cursor installed it writes .cursor/mcp.json and the user-level Cursor config", () => {
    const fx = fixture({ cursor: true });
    expect(kya(fx, [...START, "--yes"]).code).toBe(0);
    expect(existsSync(join(fx.proj, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(fx.home, ".cursor", "mcp.json"))).toBe(true);
  });

  it("with no host on the machine it writes only .kya/config.json (and .gitignore)", () => {
    const fx = fixture();
    rmSync(join(fx.home, ".claude"), { recursive: true });
    rmSync(join(fx.home, ".claude.json"));
    expect(kya(fx, [...START, "--yes"]).code).toBe(0);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(false);
    expect(existsSync(join(fx.proj, ".kya", "config.json"))).toBe(true);
    expect(existsSync(join(fx.home, ".kya", "bin"))).toBe(false);
  });

  it("git status after start shows no untracked path except those listed in the plan", () => {
    const fx = fixture({ cursor: true });
    const plan = kya(fx, [...START, "--dry-run"]).out;
    expect(kya(fx, [...START, "--yes"]).code).toBe(0);
    const created = readdirSync(fx.proj).filter((n) => n !== ".git");
    for (const name of created) {
      if (name === ".gitignore") continue; // tracked-style edit, listed as append
      if (name === ".kya") continue; // ignored by the appended .kya/ line, listed in the plan
      expect(plan, `${name} is not in the plan`).toContain(name);
    }
    const ignore = readFileSync(join(fx.proj, ".gitignore"), "utf8");
    expect(ignore).toBe("node_modules/\ndist\n.kya/*\n!.kya/policy.json\n");
  });

  it(".gitignore: .kya/ is appended once, never twice, and not outside a git repo", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    kya(fx, [...START, "--yes", "--force"]);
    const lines = readFileSync(join(fx.proj, ".gitignore"), "utf8").split("\n").filter((l) => l === ".kya/*");
    expect(lines).toHaveLength(1);

    const nogit = fixture({ git: false });
    kya(nogit, [...START, "--yes"]);
    expect(existsSync(join(nogit.proj, ".gitignore"))).toBe(false);

    // Any of these already hides the folder: left as the user wrote it.
    for (const line of [".kya", "/.kya", ".kya/", "/.kya/", ".kya/*", "/.kya/*", ".kya/**"]) {
      const has = fixture();
      writeFileSync(join(has.proj, ".gitignore"), `${line}\n`);
      kya(has, [...START, "--yes"]);
      expect(readFileSync(join(has.proj, ".gitignore"), "utf8"), line).toBe(`${line}\n`);
    }
  });

  it("start twice is idempotent: nothing to write the second time, manifest not duplicated", () => {
    const fx = fixture();
    expect(kya(fx, [...START, "--yes"]).code).toBe(0);
    const m1 = readFileSync(join(fx.home, ".kya", "manifest.json"), "utf8");
    const second = kya(fx, [...START, "--yes"]);
    expect(second.out).toContain("no config file changes");
    expect(readFileSync(join(fx.home, ".kya", "manifest.json"), "utf8")).toBe(m1);
    const paths = manifestOf(fx).entries.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    // A second non-interactive run without --yes still works: nothing to consent to.
    expect(kya(fx, START).code).toBe(0);
  });

  it("the manifest records path, action, keys and a backup path for merged files", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const m = manifestOf(fx);
    const claudeJson = m.entries.find((e) => e.path.endsWith(".claude.json"))!;
    expect(claudeJson.action).toBe("merged");
    expect(claudeJson.keys).toContain("mcpServers.shield-kya");
    expect(readFileSync(claudeJson.backup!, "utf8")).toBe('{ "theme":"dark",\n  "mcpServers": {"mine": {"command": "x"}} }\n');
    expect(m.entries.find((e) => e.path.endsWith(".mcp.json"))!.action).toBe("created");
    expect(m.entries.find((e) => e.path.endsWith("kya-hook"))!.action).toBe("created");
    expect(statSync(join(fx.home, ".kya", "manifest.json")).mode & 0o077).toBe(0);
  });
});

describe.skipIf(!posix)("kya uninstall (real CLI, temp HOME)", () => {
  it("start --yes then uninstall restores every touched file byte for byte", () => {
    const fx = fixture({ cursor: true, grok: true, kimi: true });
    writeFileSync(join(fx.home, ".grok", "config.toml"), '# my grok\nmodel = "g"\n');
    writeFileSync(join(fx.home, ".kimi-code", "config.toml"), 'theme = "x"\n\n[other]\na = 1');
    writeFileSync(join(fx.home, ".cursor", "mcp.json"), '{"mcpServers":{"c":{"url":"u"}}}');
    // Only files KYA's state dirs aside: record the tree except KYA-owned state.
    const tracked = (fx2: Fx) => {
      const s = snapshot(fx2);
      const pick = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith(".kya/") && !k.startsWith(`.kya${"/"}`)));
      return { home: pick(s.home), proj: pick(s.proj) };
    };
    const before = tracked(fx);
    expect(kya(fx, [...START, "--yes"]).code).toBe(0);
    expect(tracked(fx)).not.toEqual(before);
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain("restored byte for byte");
    expect(tracked(fx)).toEqual(before);
    expect(existsSync(join(fx.home, ".kya", "manifest.json"))).toBe(false);
    expect(existsSync(join(fx.home, ".kya", "bin"))).toBe(false);
    expect(existsSync(join(fx.home, ".grok", "hooks"))).toBe(false);
  });

  it("uninstall --dry-run changes nothing", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const before = snapshot(fx);
    const r = kya(fx, ["uninstall", "--dry-run"]);
    expect(r.out).toContain("dry run");
    expect(snapshot(fx)).toEqual(before);
  });

  it("leaves a created file the user changed, and says so", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const p = join(fx.proj, ".mcp.json");
    const mine = JSON.parse(readFileSync(p, "utf8")) as { mcpServers: Record<string, unknown> };
    mine.mcpServers["my-own"] = { command: "y" };
    writeFileSync(p, JSON.stringify(mine));
    const r = kya(fx, ["uninstall"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Left alone:");
    expect(r.out).toContain(".mcp.json: KYA created it, but it changed since");
    expect(JSON.parse(readFileSync(p, "utf8")).mcpServers["my-own"]).toBeDefined();
  });

  it("removes only KYA's keys from a merged file the host or user edited since", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const p = join(fx.home, ".claude.json");
    const doc = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    doc["newSetting"] = 42; // Claude Code rewrites this file all the time
    writeFileSync(p, JSON.stringify(doc, null, 2));
    const sp = join(fx.home, ".claude", "settings.json");
    const s = JSON.parse(readFileSync(sp, "utf8")) as { hooks: { PreToolUse: unknown[] } };
    s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] });
    writeFileSync(sp, JSON.stringify(s, null, 2));
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain("only KYA's entries were removed");
    const after = JSON.parse(readFileSync(p, "utf8")) as { theme: string; newSetting: number; mcpServers: Record<string, unknown> };
    expect(after.newSetting).toBe(42);
    expect(after.theme).toBe("dark");
    expect(after.mcpServers["mine"]).toBeDefined();
    expect(after.mcpServers["shield-kya"]).toBeUndefined();
    const afterS = JSON.parse(readFileSync(sp, "utf8")) as { model: string; hooks: { PostToolUse: unknown[]; PreToolUse: { hooks: { command: string }[] }[] } };
    expect(afterS.hooks.PreToolUse).toHaveLength(1);
    expect(afterS.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("echo mine");
    expect(afterS.hooks.PostToolUse).toHaveLength(1);
  });

  it("removes only KYA's TOML tables and hook blocks from a merged TOML the user edited since", () => {
    const fx = fixture({ grok: true, kimi: true });
    writeFileSync(join(fx.home, ".grok", "config.toml"), 'model = "g"\n');
    writeFileSync(join(fx.home, ".kimi-code", "config.toml"), 'theme = "x"\n');
    kya(fx, [...START, "--yes"]);
    for (const f of [join(fx.home, ".grok", "config.toml"), join(fx.home, ".kimi-code", "config.toml")]) {
      writeFileSync(f, `${readFileSync(f, "utf8")}\n[mine]\nkeep = true\n`);
    }
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    const grok = readFileSync(join(fx.home, ".grok", "config.toml"), "utf8");
    expect(grok).toContain('model = "g"');
    expect(grok).toContain("keep = true");
    expect(grok).not.toContain("shield-kya");
    const kimi = readFileSync(join(fx.home, ".kimi-code", "config.toml"), "utf8");
    expect(kimi).toContain('theme = "x"');
    expect(kimi).toContain("keep = true");
    expect(kimi).not.toContain("hook --host kimi");
    expect(kimi).not.toContain("[[hooks]]");
  });

  it("removes the .gitignore line KYA added from a .gitignore the user changed since", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const p = join(fx.proj, ".gitignore");
    writeFileSync(p, `${readFileSync(p, "utf8")}build/\n`);
    kya(fx, ["uninstall"]);
    expect(readFileSync(p, "utf8")).toBe("node_modules/\ndist\nbuild/\n");
    expect(readFileSync(p, "utf8")).not.toContain(".kya");
  });

  it("--project undoes only this directory and keeps the home entries in the manifest", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const homeBefore = hashTree(fx.home);
    const r = kya(fx, ["uninstall", "--project"]);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(false);
    expect(readFileSync(join(fx.proj, ".gitignore"), "utf8")).toBe("node_modules/\ndist");
    // Home files KYA wired are untouched.
    expect(JSON.parse(readFileSync(join(fx.home, ".claude.json"), "utf8")).mcpServers["shield-kya"]).toBeDefined();
    const m = manifestOf(fx);
    expect(m.entries.every((e) => e.scope === "home")).toBe(true);
    expect(m.entries.length).toBeGreaterThan(0);
    // Only the backup of the project's .gitignore went away; every other home file is still there.
    const homeAfter = Object.keys(hashTree(fx.home)).sort();
    expect(Object.keys(homeBefore).sort().filter((k) => !homeAfter.includes(k))).toEqual([expect.stringMatching(/\.gitignore$/)]);
    // A full uninstall then finishes the job.
    kya(fx, ["uninstall"]);
    expect(JSON.parse(readFileSync(join(fx.home, ".claude.json"), "utf8")).mcpServers["shield-kya"]).toBeUndefined();
  });

  it("a second KYA write after the file was edited never restores the old backup (no lost edits)", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const p = join(fx.home, ".claude.json");
    const doc = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    doc["editedBetween"] = "keep me";
    writeFileSync(p, JSON.stringify(doc, null, 2));
    const mcp = join(fx.proj, ".mcp.json");
    const mine = JSON.parse(readFileSync(mcp, "utf8")) as { mcpServers: Record<string, unknown> };
    mine.mcpServers["my-own"] = { command: "y" };
    writeFileSync(mcp, JSON.stringify(mine));
    // A later KYA write to the same files (the doctor hint tells users to run this).
    expect(kya(fx, [...START, "--yes", "--force"]).code).toBe(0);
    const r = kya(fx, ["uninstall"]);
    expect(r.code, r.all).toBe(0);
    const after = JSON.parse(readFileSync(p, "utf8")) as { editedBetween: string; theme: string; mcpServers: Record<string, unknown> };
    expect(after.editedBetween).toBe("keep me");
    expect(after.theme).toBe("dark");
    expect(after.mcpServers["mine"]).toBeDefined();
    expect(after.mcpServers["shield-kya"]).toBeUndefined();
    // The created .mcp.json the user extended is left in place, not deleted.
    expect(JSON.parse(readFileSync(mcp, "utf8")).mcpServers["my-own"]).toBeDefined();
    expect(r.out).toContain("Left alone:");
  });

  it("with no manifest it says there is nothing to undo and exits 0", () => {
    const fx = fixture();
    const before = snapshot(fx);
    const r = kya(fx, ["uninstall"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing to undo");
    expect(snapshot(fx)).toEqual(before);
  });

  it("kya connect is recorded too, so uninstall undoes it", () => {
    const fx = fixture();
    const before = snapshot(fx);
    expect(kya(fx, ["connect", "claude", "--hooks"]).code).toBe(0);
    expect(snapshot(fx)).not.toEqual(before);
    expect(kya(fx, ["uninstall"]).code).toBe(0);
    const after = snapshot(fx);
    expect(after.home[".claude.json"]).toBe(before.home[".claude.json"]);
    expect(after.home[join(".claude", "settings.json")]).toBe(before.home[join(".claude", "settings.json")]);
  });
});

describe.skipIf(!posix)("hook launcher and kya doctor (real CLI, temp HOME)", () => {
  it("the launcher runs kya hook with the recorded node and cli", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const launcher = join(fx.home, ".kya", "bin", "kya-hook");
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    const r = spawnSync(launcher, ["hook", "--host", "claude"], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/x" }, session_id: "s", cwd: fx.proj }),
      encoding: "utf8",
      timeout: 30_000,
      env: env(fx),
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("the launcher fails open with one stderr line when node and kya are missing", () => {
    const base = mkdtempSync(join(tmpdir(), "kya-launcher-"));
    dirs.push(base);
    const f = join(base, "kya-hook");
    writeFileSync(f, launcherScript("/nonexistent/node", "/nonexistent/cli.js"));
    chmodSync(f, 0o755);
    const r = spawnSync("/bin/sh", [f, "hook", "--host", "claude"], { input: "{}", encoding: "utf8", env: { PATH: "" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("hook skipped");
  });

  it("the launcher falls back to node on PATH when the recorded node is gone", () => {
    const base = mkdtempSync(join(tmpdir(), "kya-launcher-"));
    dirs.push(base);
    const f = join(base, "kya-hook");
    writeFileSync(join(base, "cli.js"), 'process.stdout.write("ran:" + process.argv.slice(2).join(" "));');
    writeFileSync(f, launcherScript("/nonexistent/node", join(base, "cli.js")));
    chmodSync(f, 0o755);
    const r = spawnSync("/bin/sh", [f, "hook", "--host", "claude"], {
      encoding: "utf8",
      env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin` },
    });
    expect(r.stdout).toBe("ran:hook --host claude");
  });

  it("doctor says the launcher is ok, then flags a dead path", () => {
    const fx = fixture();
    kya(fx, [...START, "--yes"]);
    const ok = kya(fx, ["doctor"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("hook launcher: ok");
    const launcher = join(fx.home, ".kya", "bin", "kya-hook");
    writeFileSync(launcher, launcherScript("/nonexistent/node", "/nonexistent/cli.js"));
    // No node or kya on PATH for the doctor run (node itself is started by absolute path).
    const dead = kya(fx, ["doctor"], { PATH: "/nonexistent" });
    expect(dead.code).toBe(0);
    expect(dead.out).toContain("hook launcher: DEAD");
    expect(dead.out).toContain("fails open");
    const json = JSON.parse(kya(fx, ["doctor", "--json"], { PATH: "/nonexistent" }).out) as { hook: { launcher: string; problems: string[] } };
    expect(json.hook.launcher).toBe("dead");
    expect(json.hook.problems.length).toBeGreaterThan(0);
  });

  it("doctor flags an old-style hook command whose node path no longer exists", () => {
    const fx = fixture();
    writeFileSync(
      join(fx.home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: '"/gone/nvm/node" "/gone/cli.js" hook --host claude' }] }] } }),
    );
    const r = kya(fx, ["doctor"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("path /gone/nvm/node does not exist");
    expect(r.out).toContain("fails open");
  });
});

/** In-process: the terminal question. io.isTty and io.ask are the seams the CLI exposes. */
describe.skipIf(!posix)("kya start on a terminal asks Apply? [Y/n] once (in-process CLI)", () => {
  function run(fx: Fx, answer: string, args: string[] = START) {
    const logs: string[] = [];
    const asked: string[] = [];
    const io: CliIo = {
      log: (m) => logs.push(m),
      error: (m) => logs.push(m),
      exit: () => undefined,
      isTty: true,
      ask: async (q) => {
        asked.push(q);
        return q.startsWith("Apply?") ? answer : "n";
      },
    };
    return runCli(args, io, env(fx), fx.proj).then((code) => ({ code, logs: logs.join("\n"), asked }));
  }

  it("Enter applies", async () => {
    const fx = fixture();
    const r = await run(fx, "");
    expect(r.code).toBe(0);
    expect(r.asked.filter((q) => q.startsWith("Apply?"))).toHaveLength(1);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(true);
  });

  it("y applies", async () => {
    const fx = fixture();
    expect((await run(fx, "y")).code).toBe(0);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(true);
  });

  it("n writes nothing and exits 0", async () => {
    const fx = fixture();
    const before = snapshot(fx);
    const r = await run(fx, "n");
    expect(r.code).toBe(0);
    expect(r.logs).toContain("Nothing was changed.");
    expect(snapshot(fx)).toEqual(before);
  });

  it("--yes skips the question", async () => {
    const fx = fixture();
    const r = await run(fx, "n", [...START, "--yes"]);
    expect(r.asked.filter((q) => q.startsWith("Apply?"))).toHaveLength(0);
    expect(existsSync(join(fx.proj, ".mcp.json"))).toBe(true);
  });

  it("--dry-run does not ask and writes nothing", async () => {
    const fx = fixture();
    const before = snapshot(fx);
    const r = await run(fx, "y", [...START, "--dry-run"]);
    expect(r.asked).toHaveLength(0);
    expect(snapshot(fx)).toEqual(before);
  });
});

describe.skipIf(!posix)("kya start with the report server on (default path, real git repo)", () => {
  it("creates no orr-report/ and leaves git status with only the planned paths; kya stop cleans up", async () => {
    const fx = fixture({ git: false });
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: fx.proj, encoding: "utf8" });
    expect(git("init", "-q").status).toBe(0);
    writeFileSync(join(fx.proj, ".gitignore"), "node_modules/\n");
    git("add", ".gitignore");
    expect(git("commit", "-qm", "x").status).toBe(0);
    try {
      const plan = kya(fx, ["start", "--no-gate", "--dry-run"]).out;
      const r = kya(fx, ["start", "--yes", "--no-gate"]);
      expect(r.code, r.all).toBe(0);
      expect(r.out).toContain("report: http://127.0.0.1:");
      // The report server runs its ORR refresh 1.5 s after it listens: wait past it.
      await new Promise((res) => setTimeout(res, 3500));
      expect(existsSync(join(fx.proj, "orr-report"))).toBe(false);
      const status = git("status", "--porcelain", "-uall").stdout.split("\n").filter(Boolean);
      const untracked = status.filter((l) => l.startsWith("??")).map((l) => l.slice(3));
      expect(untracked).toEqual([".mcp.json"]);
      expect(plan).toContain(".mcp.json");
      expect(status).toContain(" M .gitignore");
      // An existing board is still refreshed: the switch only stops the first creation.
      expect(readFileSync(join(fx.proj, ".gitignore"), "utf8")).toBe("node_modules/\n.kya/*\n!.kya/policy.json\n");
    } finally {
      kya(fx, ["stop"]);
    }
  }, 60_000);
});
