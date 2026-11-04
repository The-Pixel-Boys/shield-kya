/**
 * Repo policy (.kya/policy.json): parsing, fail-open loading, tighten-only evaluation, and the team rollout
 * e2e (init in clone A, commit, push, clone B picks up the policy and the plugin pin).
 * The e2e needs the built CLI (dist/cli.js); without it the e2e is skipped, as in team.test.ts.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PolicyEvaluateRequest } from "../src/client.js";
import { applyProjectPolicy, evaluateOffline } from "../src/offline-evaluate.js";
import { loadProjectPolicy, parseProjectPolicy, POLICY_MAX_BYTES, POLICY_SCAFFOLD } from "../src/project-policy.js";

const root = join(import.meta.dirname, "..");
const cliJs = join(root, "dist/cli.js");
const haveDist = existsSync(cliJs);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const isPre = version.includes("-");
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "kya-policy-")));

const SAFE = "org.sample.safe.read"; // sample ALLOW
const NEVER = "org.sample.never.event"; // sample DENY (never-list)
const req = (toolId: string): PolicyEvaluateRequest => ({ toolId, argsHash: "h" }) as PolicyEvaluateRequest;
const policyDir = (text: string) => {
  const dir = tmp();
  mkdirSync(join(dir, ".kya"));
  writeFileSync(join(dir, ".kya/policy.json"), text);
  return dir;
};

describe("project policy: parsing", () => {
  it("accepts version 1 with optional deny and requireApprove lists", () => {
    const r = parseProjectPolicy(JSON.stringify({ version: 1, deny: [" a.b "], requireApprove: ["c"] }));
    expect([...r.policy!.deny]).toEqual(["a.b"]);
    expect([...r.policy!.requireApprove]).toEqual(["c"]);
    expect(parseProjectPolicy(JSON.stringify({ version: 1 })).policy).toBeDefined();
  });

  it.each([
    ["not JSON", "{"],
    ["top level array", "[]"],
    ["wrong version", JSON.stringify({ version: 2 })],
    ["unknown key allow (cannot relax)", JSON.stringify({ version: 1, allow: [SAFE] })],
    ["deny not an array", JSON.stringify({ version: 1, deny: "x" })],
    ["non-string entry", JSON.stringify({ version: 1, deny: [1] })],
    ["empty entry", JSON.stringify({ version: 1, deny: ["  "] })],
    ["entry over 200 characters", JSON.stringify({ version: 1, deny: ["x".repeat(201)] })],
  ])("rejects %s", (_name, text) => {
    expect(parseProjectPolicy(text).policy).toBeUndefined();
    expect(parseProjectPolicy(text).error).toBeTruthy();
  });
});

describe("project policy: loading fails open", () => {
  it("a missing file is no policy and no warning", () => {
    const warn = vi.fn();
    expect(loadProjectPolicy(tmp(), warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a valid file loads", () => {
    const warn = vi.fn();
    const p = loadProjectPolicy(policyDir(JSON.stringify({ version: 1, requireApprove: [SAFE] })), warn);
    expect(p?.requireApprove.has(SAFE)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("malformed JSON is ignored with one warning", () => {
    const warn = vi.fn();
    expect(loadProjectPolicy(policyDir("{ not json"), warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/not valid JSON \(.*\); the base rules apply/);
  });

  it("a symlinked policy file is ignored", () => {
    const dir = tmp();
    const real = join(tmp(), "p.json");
    writeFileSync(real, JSON.stringify({ version: 1, deny: [SAFE] }));
    mkdirSync(join(dir, ".kya"));
    symlinkSync(real, join(dir, ".kya/policy.json"));
    const warn = vi.fn();
    expect(loadProjectPolicy(dir, warn)).toBeUndefined();
    expect(warn.mock.calls[0]![0]).toMatch(/symlink/);
  });

  it("an oversize file is ignored", () => {
    const warn = vi.fn();
    expect(loadProjectPolicy(policyDir("x".repeat(POLICY_MAX_BYTES + 1)), warn)).toBeUndefined();
    expect(warn.mock.calls[0]![0]).toMatch(/larger than/);
  });

  it("the scaffold is a valid empty policy", () => {
    expect(parseProjectPolicy(POLICY_SCAFFOLD).policy?.deny.size).toBe(0);
  });
});

describe("project policy: tighten only", () => {
  const deny = new Set([SAFE]);
  const requireApprove = new Set([SAFE, NEVER]);
  const policy = { deny, requireApprove };

  it("deny turns an ALLOW into DENY with its own reason", () => {
    const r = evaluateOffline(req(SAFE), "ide", undefined, { deny, requireApprove: new Set() });
    expect(r.verdict).toBe("DENY");
    expect(r.reasonCode).toBe("POLICY_DENY");
  });

  it("requireApprove turns an ALLOW into REQUIRE_APPROVE", () => {
    const r = evaluateOffline(req(SAFE), "ide", undefined, { deny: new Set(), requireApprove: new Set([SAFE]) });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("POLICY_REQUIRE_APPROVE");
  });

  it("never-list stays DENY with its own reason, even when the policy lists it", () => {
    const r = evaluateOffline(req(NEVER), "ide", undefined, policy);
    expect(r.verdict).toBe("DENY");
    expect(r.reasonCode).toBe("NEVER_EVENT");
  });

  it("no policy, or a tool the policy does not name, keeps the base verdict", () => {
    expect(evaluateOffline(req(SAFE)).verdict).toBe("ALLOW");
    expect(applyProjectPolicy({ verdict: "ALLOW", reasonCode: "ALLOW" }, "other.tool", policy).verdict).toBe("ALLOW");
  });
});

describe.skipIf(isPre || !haveDist)("project policy: team rollout e2e (built CLI, bare remote, two clones)", () => {
  const env = (home: string) => ({
    PATH: process.env.PATH ?? "",
    HOME: home,
    KYA_TELEMETRY: "0",
    GIT_AUTHOR_NAME: "lead",
    GIT_AUTHOR_EMAIL: "lead@example.test",
    GIT_COMMITTER_NAME: "lead",
    GIT_COMMITTER_EMAIL: "lead@example.test",
  });
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: env(tmp()), stdio: "pipe" }).toString();
  const kya = (args: string[], cwd: string, home: string) =>
    spawnSync(process.execPath, [cliJs, ...args], { cwd, encoding: "utf8", env: env(home) });
  const evalTool = (cwd: string, home: string, toolId: string) => {
    const r = kya(["eval-tool", "--offline", "--tool-id", toolId, "--json"], cwd, home);
    return { status: r.status, stderr: r.stderr, out: r.stdout ? JSON.parse(r.stdout) : undefined };
  };

  it("init in clone A, commit, push; clone B gets the pinned plugin and the policy; tampering cannot relax", () => {
    const home = tmp();
    const remote = join(tmp(), "shield.git");
    execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });

    const a = tmp();
    git(["init", "-b", "main"], a);
    git(["remote", "add", "origin", remote], a);
    const init = kya(["team", "init"], a, home);
    expect(init.status, init.stderr).toBe(0);
    const pol = join(a, ".kya/policy.json");
    expect(JSON.parse(readFileSync(pol, "utf8"))).toEqual({ version: 1, deny: [], requireApprove: [] });
    writeFileSync(pol, JSON.stringify({ version: 1, deny: [], requireApprove: [SAFE] }));
    git(["add", ".claude/settings.json", ".kya/policy.json"], a);
    git(["commit", "-m", "chore: enable the kya Claude Code plugin"], a);
    git(["push", "-u", "origin", "main"], a);

    const b = tmp();
    git(["clone", remote, b], tmp());
    const sett = JSON.parse(readFileSync(join(b, ".claude/settings.json"), "utf8"));
    const ref = `v${version}`;
    expect(sett.extraKnownMarketplaces["shield-kya"].source).toEqual({ source: "github", repo: "The-Pixel-Boys/shield-kya", ref });
    expect(sett.enabledPlugins["kya@shield-kya"]).toBe(true);

    const dry = kya(["team", "init", "--dry-run"], b, home);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/already enables kya@shield-kya/);

    // Clone B runs the gate: the committed rule changes the verdict of the project's own copy.
    // Exit 4 is REQUIRE_APPROVE (verdictExitCode); the verdict in the JSON is what counts.
    const fromPolicy = evalTool(b, home, SAFE);
    expect(fromPolicy.status).toBe(4);
    expect(fromPolicy.out.verdict).toBe("REQUIRE_APPROVE");
    expect(fromPolicy.out.reasonCode).toBe("POLICY_REQUIRE_APPROVE");

    // Denied path: a tampered policy that lists a never-list tool and tries to add an allow key.
    writeFileSync(join(b, ".kya/policy.json"), JSON.stringify({ version: 1, requireApprove: [NEVER], allow: [NEVER] }));
    const tampered = evalTool(b, home, NEVER);
    expect(tampered.status).toBe(1);
    expect(tampered.out.verdict).toBe("DENY");
    expect(tampered.out.reasonCode).toBe("NEVER_EVENT");
    expect(tampered.stderr).toMatch(/unknown key "allow"/);

    // Denied path: malformed JSON fails open with a note; the base verdict applies.
    writeFileSync(join(b, ".kya/policy.json"), "{ broken");
    const broken = evalTool(b, home, SAFE);
    expect(broken.status).toBe(0);
    expect(broken.out.verdict).toBe("ALLOW");
    expect(broken.stderr).toMatch(/ignoring .kya\/policy.json: not valid JSON/);
  }, 60_000); // spawns four CLI processes and two git clones; the 5 s default is too tight on a busy host
});
