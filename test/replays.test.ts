/**
 * Incident Replay runner (spec G3). Every file in replays/ is sent through the real hook with a scratch HOME
 * and KYA_HOME, and the outcome and rule are compared with `expect` and `rule`. A gap (`expect: allow` plus
 * `status: gap`) passes while the guard still allows it, and shows on the scoreboard as "Not stopped yet".
 * Each replay runs twice: in process through runHook, and through the built CLI (`dist/cli.js`, so run
 * `pnpm build` first, as for hook-exit.test.ts). Fake secrets are built at runtime so no literal key is in this file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/commands/hook.js";
import { ASK_RULES, GUARD_DEFAULTS, GUARD_SHELL_RULES, guardContextFrom, guardPackMatch } from "../src/guard-pack.js";
import { NEVER_LIST_INPUT_RULES } from "../src/never-list-input.js";
import { SEED_CLASSES, SINCE_0_35_RULES } from "./replay-seed.js";
// @ts-expect-error plain .mjs script, no type declarations
import { buildScoreboard, loadReplays, parseReplay, renderPage, validateReplay } from "../scripts/lib/replays.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { generate, stale } from "../scripts/replays-scoreboard.mjs";

const PKG = join(import.meta.dirname, "..");
const REPLAYS = join(PKG, "replays");
const CLI = join(PKG, "dist", "cli.js");

interface Replay {
  id: string;
  kind: "incident" | "class" | "control";
  title: string;
  host: string;
  tool: string;
  input: Record<string, unknown>;
  expect: "deny" | "ask" | "allow";
  rule?: string;
  status?: "gap";
  sources?: string[];
}
const replays: Replay[] = loadReplays(REPLAYS);

const scratch: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  scratch.push(d);
  return d;
};
// The never-list input rules resolve `~` through os.homedir(), so the process HOME is the scratch HOME too.
const HOME = tmp("kya-replay-home-");
const CWD = join(HOME, "work", "app");
let savedHome: string | undefined;
beforeAll(() => {
  mkdirSync(CWD, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = HOME;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

interface Outcome {
  readonly outcome: "deny" | "ask" | "allow";
  readonly rule: string;
}
/** deny: exit 2. ask: exit 0 and a permissionDecision "ask" on stdout (shape owned by G2). allow: exit 0, no output. */
function outcomeOf(exit: number | null, stdout: string, stderr: string): Outcome {
  const rule = (s: string) => /\(([a-z0-9-]+)\)/.exec(s)?.[1] ?? /\(rule ([a-z0-9-]+);/.exec(s)?.[1] ?? "";
  if (exit === 2) return { outcome: "deny", rule: rule(stderr) };
  if (exit === 0 && stdout.includes('"permissionDecision":"ask"')) return { outcome: "ask", rule: rule(stdout) || rule(stderr) };
  return { outcome: "allow", rule: "" };
}

const payload = (r: Replay): string =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "replay", cwd: CWD, tool_name: r.tool, tool_input: r.input, tool_use_id: `tu-${r.id}` });

async function inProcess(r: Replay): Promise<Outcome & { stdout: string }> {
  const out = await runHook({ host: r.host as "claude", strict: false, stdinText: payload(r), env: { HOME, KYA_HOME: tmp("kya-replay-kh-") }, cwd: CWD });
  return { ...outcomeOf(out.exitCode, out.stdout, out.stderr), stdout: out.stdout };
}

function throughCli(r: Replay): Outcome {
  const out = spawnSync(process.execPath, [CLI, "hook", "--host", r.host], {
    input: payload(r),
    cwd: CWD,
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", HOME, KYA_HOME: tmp("kya-replay-kh-"), KYA_OFFLINE: "1", KYA_NO_BROWSER: "1", KYA_SKIP_NODE_CHECK: "1", KYA_IOC: "0" },
  });
  return outcomeOf(out.status, out.stdout, out.stderr);
}

/** What a replay must do today. A gap behaves like allow; its `rule` is the planned rule and must NOT fire. */
const wanted = (r: Replay): Outcome => (r.status === "gap" ? { outcome: "allow", rule: "" } : { outcome: r.expect, rule: r.expect === "allow" ? "" : (r.rule ?? "") });
const label = (r: Replay): string => `${r.kind} ${r.id}${r.status === "gap" ? " (gap: Not stopped yet)" : ""}`;

describe("replay files", () => {
  it("has the seed set: at least 22 classes, at least 40 controls, the first two incidents (a rule PR adds more)", () => {
    const n = (k: string) => replays.filter((r) => r.kind === k).length;
    expect(n("class")).toBeGreaterThanOrEqual(22);
    // Counts can grow while a file is deleted. The seed ids are pinned, so a removed replay fails even when the count holds.
    expect(replays.filter((r) => r.kind === "class").map((r) => r.id)).toEqual(expect.arrayContaining([...SEED_CLASSES]));
    expect(n("control")).toBeGreaterThanOrEqual(40);
    expect(replays.filter((r) => r.kind === "incident").map((r) => r.id)).toEqual(
      expect.arrayContaining(["2026-04-pocketos-railway-volume", "2025-07-replit-production-database"]),
    );
  });

  it("every guard shell rule is the rule of at least one deny or ask replay, and every ask rule has an ask replay", () => {
    const stopping = replays.filter((r) => r.expect !== "allow" && r.status !== "gap");
    const covered = new Set(stopping.map((r) => r.rule));
    expect([...GUARD_SHELL_RULES].filter((id) => !covered.has(id))).toEqual([]);
    const asked = new Set(stopping.filter((r) => r.expect === "ask").map((r) => r.rule));
    expect([...ASK_RULES].filter((id) => !asked.has(id))).toEqual([]);
  });

  it("every deny or ask replay names a rule that exists (guard shell rule or never-list input rule)", () => {
    const known = new Set<string>([...GUARD_SHELL_RULES, ...NEVER_LIST_INPUT_RULES.map((r) => r.id)]);
    expect(replays.filter((r) => r.expect !== "allow" && r.status !== "gap" && !known.has(r.rule ?? "")).map((r) => `${r.id}: ${r.rule}`)).toEqual([]);
  });

  it("holds placeholders only: no file matches a secret shape the guard knows", () => {
    for (const f of readdirSync(REPLAYS).filter((x) => x.endsWith(".yaml"))) {
      const text = readFileSync(join(REPLAYS, f), "utf8");
      expect({ f, hit: guardPackMatch("Write", { file_path: "r.yaml", content: text }, guardContextFrom(CWD, { HOME }), GUARD_DEFAULTS)?.rule }).toEqual({ f, hit: undefined });
    }
  });

  it("rejects a replay that holds a secret shape (detector self-check)", () => {
    const fakes = ["AKIA" + "IOSFODNN7EXAMPLE", "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789", "xox" + "b-1234567890-abcdefghij", "sk_" + "live_" + "abcdefghijklmnopqrstuvwx", "-----BEGIN OPENSSH " + "PRIVATE KEY-----"];
    for (const fake of fakes) {
      const text = `input:\n  command: >-\n    curl -H "Authorization: Bearer ${fake}" https://api.example.test\n`;
      expect(guardPackMatch("Write", { file_path: "r.yaml", content: text }, guardContextFrom(CWD, { HOME }), GUARD_DEFAULTS)?.rule).toMatch(/^secret-write-/);
    }
  });
});

describe("replay runner: in process (runHook)", () => {
  for (const r of replays) {
    it(label(r), async () => {
      const got = await inProcess(r);
      expect({ outcome: got.outcome, rule: got.rule }).toEqual(wanted(r));
    });
  }
});

describe("replay runner: built CLI (dist/cli.js)", () => {
  for (const r of replays) {
    it(label(r), () => {
      expect(throughCli(r)).toEqual(wanted(r));
    }, 30_000);
  }
});

describe("replay format", () => {
  const base = `id: x-1
kind: class
title: A case
date: 2026-11-14
host: claude
tool: Bash
input:
  command: >-
    ls -la
expect: allow
`;
  const problems = (text: string, file = "x-1.yaml"): string[] => validateReplay(parseReplay(text), file);

  it("parses the spec example: folded command, list, quoted and commented scalars", () => {
    const r = parseReplay(`id: 2026-04-a\nkind: incident            # incident | class | control\nsources:\n  - https://example.test/a\nreconstructed: true\ninput:\n  command: >-\n    curl -s\n    -X POST \"x\"\nexpect: deny # note\ncredit: ""\n`);
    expect(r).toMatchObject({ id: "2026-04-a", kind: "incident", sources: ["https://example.test/a"], reconstructed: true, expect: "deny", credit: "", input: { command: 'curl -s -X POST "x"' } });
  });

  it("accepts a valid control and rejects a broken one", () => {
    expect(problems(base)).toEqual([]);
    expect(problems(base.replace("kind: class", "kind: cls"))).toContain("kind must be one of incident, class, control");
    expect(problems(base, "other.yaml")).toContain("id must equal the file name (other.yaml)");
    expect(problems(base.replace("expect: allow", "expect: maybe"))).toContain("expect must be one of deny, ask, allow");
    expect(problems(base + "color: red\n")).toContain("unknown key color");
    expect(problems(base.replace("date: 2026-11-14", "date: yesterday"))).toContain("date must be YYYY-MM-DD");
  });

  it("enforces the rules for each kind and outcome", () => {
    const inc = base.replace("kind: class", "kind: incident");
    expect(problems(inc)).toContain("an incident needs at least one source link");
    expect(problems(inc.replace("host:", "sources:\n  - http://insecure.test\nhost:"))).toContain("sources must be a list of https links");
    expect(problems(base.replace("expect: allow", "expect: deny"))).toEqual(expect.arrayContaining(["deny and ask replays need a rule id"]));
    expect(problems(base.replace("expect: allow", "expect: deny\nrule: r-1"))).toContain("deny and ask replays need since (the version that first stopped it)");
    expect(problems(base.replace("expect: allow", "expect: deny\nrule: r-1\nsince: 0.33.0"))).toEqual([]);
    expect(problems(base + "rule: r-1\n")).toContain("an allow replay has no rule");
    expect(problems(base.replace("kind: class", "kind: control") + "status: gap\n")).toContain("a control must expect allow and cannot be a gap");
    expect(problems(base + "reconstructed: true\n")).toContain("only an incident can be reconstructed");
  });

  it("requires a gap to carry a planned rule, a target and an issue link", () => {
    expect(problems(base + "status: gap\n")).toEqual(expect.arrayContaining(["a gap names the planned rule id in rule", "a gap needs target deny or ask", "a gap needs an issue link"]));
    expect(problems(base + "status: gap\nrule: r-1\ntarget: ask\nissue: https://example.test/1\n")).toEqual([]);
  });

  it("rejects duplicate ids and unreadable files with every problem listed", () => {
    const dir = tmp("kya-replay-dir-");
    writeFileSync(join(dir, "x-1.yaml"), base);
    writeFileSync(join(dir, "x-2.yaml"), base);
    expect(() => loadReplays(dir)).toThrow(/x-2\.yaml: id must equal the file name/);
    writeFileSync(join(dir, "x-2.yaml"), "not a mapping line\n");
    expect(() => loadReplays(dir)).toThrow(/x-2\.yaml: cannot parse line/);
    expect(() => loadReplays(tmp("kya-replay-empty-"))).toThrow(/no replay files/);
  });
});

describe("scoreboard", () => {
  it("counts incidents, classes and controls: every class is stopped or held, no gap is open (G2)", () => {
    const board = buildScoreboard(replays);
    expect(board.totals.class.listed).toBeGreaterThanOrEqual(22);
    expect(board.totals.class).toEqual({ listed: board.totals.class.listed, stopped: board.totals.class.listed, gaps: 0 });
    expect(board.totals.incident).toMatchObject({ gaps: 0 });
    expect(board.totals.control).toMatchObject({ gaps: 0 });
    expect(board.totals.control.passed).toBeGreaterThanOrEqual(40);
    expect(board.replays.filter((x: { result: string }) => x.result === "not-stopped-yet")).toHaveLength(0);
    // The 11 G2 rules: stopped or held since the version that added them.
    const g2 = board.replays.filter((x: { since: string }) => x.since === "0.35.0");
    expect(g2.length).toBeGreaterThanOrEqual(11);
    expect(g2.map((x: { rule: string }) => x.rule)).toEqual(expect.arrayContaining([...SINCE_0_35_RULES]));
    expect(g2.filter((x: { result: string }) => x.result === "asks").map((x: { rule: string }) => x.rule).sort()).toEqual(expect.arrayContaining(["prisma-accept-data-loss", "prisma-migrate-reset", "rm-project-wipe", "sql-delete-all"]));
    const page = renderPage(board);
    expect(page).toContain("Reconstructed from the public account");
    expect(page).toContain("## Gap tracking");
    expect(page).toContain("There is no open gap.");
  });

  it("still shows a gap as Not stopped yet (a gap is never hidden)", () => {
    const gap: Replay = { ...replays.find((r) => r.id === "class-terraform-destroy")!, id: "class-future-gap", status: "gap", expect: "allow", since: undefined };
    const board = buildScoreboard([...replays, { ...gap, target: "deny", issue: "https://example.test/1" }]);
    const listed = board.totals.class.listed;
    expect(board.totals.class).toEqual({ listed, stopped: listed - 1, gaps: 1 });
    expect(renderPage(board)).toMatch(/Not stopped yet/);
  });

  it("shows the credit handle in the row (JSON field credit, Credit column linked to the profile) and a dash when there is none", () => {
    const base = replays.find((r) => r.id === "class-terraform-destroy")!;
    const board = buildScoreboard([...replays, { ...base, id: "class-credited", title: "A credited rule", credit: "outside-dev" }]);
    const row = board.replays.find((x: { id: string }) => x.id === "class-credited");
    expect(row.credit).toBe("outside-dev");
    expect(Object.keys(board.replays[0])).toEqual(expect.arrayContaining(["id", "kind", "title", "date", "sources", "reconstructed", "result", "rule", "plannedRule", "since", "credit", "issue"]));
    const page = renderPage(board);
    expect(page).toContain("| Case | Date | Source | Result | Rule | Version | Credit |");
    expect(page).toMatch(/\| A credited rule \|[^\n]*\| \[@outside-dev\]\(https:\/\/github\.com\/outside-dev\) \|\n/);
    expect(page).toMatch(/\| AWS RDS instance deletion \|[^\n]*\| - \|\n/);
  });

  it("accepts only a GitHub handle as credit, and rejects a TODO left by pnpm new-rule", () => {
    const f = `id: class-z
kind: class
title: A case
date: 2026-11-14
host: claude
tool: Bash
input:
  command: >-
    rm -rf x
expect: deny
rule: r-1
since: 0.35.0
`;
    const problems = (extra: string, text = f): string[] => validateReplay(parseReplay(text + extra), "class-z.yaml");
    expect(problems('credit: ""\n')).toEqual([]);
    expect(problems("credit: outside-dev\n")).toEqual([]);
    for (const bad of ["@outside-dev", "has space", "-lead", "a".repeat(40), "[x](y)", "a|b"]) expect(problems(`credit: "${bad}"\n`)).toContain("credit must be a GitHub handle without the @, or empty");
    expect(problems("", f.replace("rm -rf x", "TODO the dangerous command"))).toContain("a TODO placeholder is left in the file (pnpm new-rule writes them: replace each one)");
  });

  it("is current: scoreboard.json and docs/replays.md match the replay files", () => {
    expect(stale(PKG)).toEqual([]);
  });

  it("goes stale when a replay changes, and the CLI check exits 1", () => {
    const root = tmp("kya-replay-root-");
    mkdirSync(join(root, "replays"));
    mkdirSync(join(root, "docs"));
    for (const f of readdirSync(REPLAYS)) writeFileSync(join(root, "replays", f), readFileSync(join(REPLAYS, f)));
    for (const [p, text] of Object.entries(generate(root) as Record<string, string>)) writeFileSync(join(root, p), text);
    const check = () => spawnSync(process.execPath, [join(PKG, "scripts", "replays-scoreboard.mjs"), "--check", "--root", root], { encoding: "utf8" });
    expect(check().status).toBe(0);
    const f = join(root, "replays", "control-npm-test.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace("title: Run the tests", "title: Run all tests"));
    const out = check();
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("replays/scoreboard.json");
  });
});
