#!/usr/bin/env node
// pnpm new-rule <id>: scaffold a new guard rule so a contributor edits instead of hunts (spec G4).
//
//   pnpm new-rule helm-uninstall                 make the rule stub, the test file and the replay file
//   pnpm new-rule helm-uninstall --credit my-handle    put your GitHub handle in the replay's credit field
//   node scripts/new-rule.mjs <id> --root <dir>        package root (default: the folder above scripts/)
//
// It changes four places and creates two files. Nothing is written unless every check passes first:
//   src/guard-pack.ts            the id in GUARD_SHELL_RULES, a matcher stub, its SHELL_MATCHERS entry, a hint, a label
//                                (inserted above the `// new-rule:` marker comments, which stay)
//   docs/guard-pack.md           a row at the end of the shell rule table
//   test/guard-rule-<id>.test.ts the test block: commands the rule must stop and everyday commands that must pass
//   replays/class-<id>.yaml      the replay file (placeholder command)
// The stub matches nothing yet, so the new test and the replay fail until you replace every TODO. That is on purpose.
// Run it twice and the second run is refused with no change (an id that exists is never touched).
// Exit 0 done, 1 refused (nothing changed), 2 the package files are not in the shape this script expects.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED = ["secret-", "exfil-", "never-", "guard-"];
const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export class Refused extends Error {}
const refuse = (m) => { throw new Refused(m); };

const camel = (id) => id.split("-").map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
const nextMinor = (v) => { const [a, b] = v.split(".").map(Number); return `${a}.${b + 1}.0`; };

/** Insert `text` on its own line(s) directly above the one line that holds `marker`. */
function above(text, marker, add) {
  const lines = text.split("\n");
  const at = lines.flatMap((l, i) => (l.includes(marker) ? [i] : []));
  if (at.length !== 1) throw new Error(`the marker "${marker}" must appear exactly once (found ${at.length})`);
  lines.splice(at[0], 0, ...add.split("\n"));
  return lines.join("\n");
}

/** Plan every change for `id` in package root `root`. Returns { writes: {path: text}, summary }. Throws Refused or Error. */
export function plan(root, id, { credit = "", today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!ID.test(id) || id.length < 3 || id.length > 40) refuse(`"${id}" is not a rule id: use 3 to 40 lower-case letters, digits and single dashes, starting with a letter (for example helm-uninstall)`);
  const bad = RESERVED.find((p) => id.startsWith(p));
  if (bad) refuse(`rule ids that start with "${bad}" are reserved for the built-in families: pick another id`);
  if (credit && !HANDLE.test(credit)) refuse(`"${credit}" is not a GitHub handle`);
  const P = (rel) => join(root, rel);
  const need = (rel) => { if (!existsSync(P(rel))) throw new Error(`${rel} is missing: run this from the kya package folder`); return readFileSync(P(rel), "utf8"); };
  const guard = need("src/guard-pack.ts");
  const docs = need("docs/guard-pack.md");
  const version = JSON.parse(need("package.json")).version;
  const testRel = `test/guard-rule-${id}.test.ts`;
  const replayRel = `replays/class-${id}.yaml`;

  // Refuse anything that already carries this id. All checks come before the first write.
  const taken = [];
  const ids = /export const GUARD_SHELL_RULES = \[([\s\S]*?)\] as const;/.exec(guard)?.[1];
  if (ids === undefined) throw new Error("GUARD_SHELL_RULES not found in src/guard-pack.ts");
  if ([...ids.matchAll(/"([a-z0-9-]+)"/g)].some((m) => m[1] === id)) taken.push("it is in GUARD_SHELL_RULES");
  if (guard.includes(`"${id}"`)) taken.push("src/guard-pack.ts already uses it");
  for (const f of walk(P("src"))) if (readFileSync(f, "utf8").includes(`"${id}"`)) taken.push(`${f.slice(root.length + 1)} already uses it`);
  if (docs.includes(`\`${id}\``)) taken.push("docs/guard-pack.md already lists it");
  for (const rel of [testRel, replayRel]) if (existsSync(P(rel))) taken.push(`${rel} exists`);
  if (existsSync(P("replays"))) for (const f of readdirSync(P("replays")).filter((x) => x.endsWith(".yaml"))) if (new RegExp(`^rule: ${id}\\s*$`, "m").test(readFileSync(P(`replays/${f}`), "utf8"))) taken.push(`replays/${f} uses it`);
  if (taken.length) refuse(`rule id "${id}" exists already (${[...new Set(taken)].join("; ")}). Nothing was changed.`);

  let name = camel(id);
  while (new RegExp(`\\b${name}\\b`).test(guard)) name += "Rule";
  let g = guard;
  g = above(g, "// new-rule:ids", `  "${id}",`);
  g = above(g, "// new-rule:matchers", [
    `/**`,
    ` * ${id}: TODO say what this denies in one line. A matcher returns NO (no match), "" (match, no target) or the matched target.`,
    ` * Example: hasCommand(sh, (c) => c.name === "helm" && words(c.args).pos[0] === "uninstall") ? "" : NO`,
    ` * It must not match everyday commands that look alike: the test file lists them.`,
    ` */`,
    `const ${name}: Matcher = (_sh, _ctx) => NO; // TODO(new-rule): replace this body`,
    ``,
  ].join("\n"));
  g = above(g, "// new-rule:entries", `  ["${id}", ${name}],`);
  g = above(g, "// new-rule:hints", `  "${id}": "TODO: one sentence that tells the agent what to do instead.",`);
  // The near-miss card says "My coding agent tried to <label>." A test fails for a rule with no label.
  g = above(g, "// new-rule:labels", `  "${id}": "TODO what the agent tried to do, in plain words, no command text",`);

  const lines = docs.split("\n");
  const ask = lines.findIndex((l) => l.startsWith("### The ask outcome"));
  let last = ask - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (ask < 0 || !lines[last]?.startsWith("| ")) throw new Error("docs/guard-pack.md: the shell rule table before '### The ask outcome' was not found");
  lines.splice(last + 1, 0, `| \`${id}\` | TODO: say what this rule denies, and which similar commands pass. |`);

  const test = testTemplate(id);
  const replay = [
    `id: class-${id}`, `kind: class`, `title: TODO describe the dangerous command in one line`, `date: ${today}`, `host: claude`, `tool: Bash`,
    `input:`, `  command: >-`, `    TODO the dangerous command, with placeholder tokens and hosts only`,
    `expect: deny`, `rule: ${id}`, `since: ${nextMinor(version)}`, `credit: ${JSON.stringify(credit)}`, ``,
  ].join("\n");
  return {
    writes: { "src/guard-pack.ts": g, "docs/guard-pack.md": lines.join("\n"), [testRel]: test, [replayRel]: replay },
    summary: { id, matcher: name, testRel, replayRel, since: nextMinor(version) },
  };
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

function testTemplate(id) {
  return `/**
 * Rule ${id} (made by \`pnpm new-rule ${id}\`). Replace every TODO, then run: pnpm test -- guard-rule-${id}
 * The bar for a new rule: at least 2 commands it must stop, and at least 3 everyday commands that must pass untouched
 * (the false-positive bar). Put commands that look like the dangerous one but are safe in PASSING.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/commands/hook.js";
import { GUARD_SHELL_RULES, guardLabel } from "../src/guard-pack.js";

const RULE = "${id}";
/** Commands the rule must stop (exit 2, and the deny line names the rule). */
const STOPPED: string[] = [
  "TODO a command the rule must stop",
  "TODO a second command the rule must stop",
];
/** Everyday commands that must pass with no output: the three must-pass controls. */
const PASSING: string[] = [
  "TODO an everyday command that looks similar but is safe",
  "TODO a second safe command",
  "TODO a third safe command",
];

const scratch: string[] = [];
const home = mkdtempSync(join(tmpdir(), "kya-rule-home-"));
scratch.push(home);
const cwd = join(home, "work", "app");
let savedHome: string | undefined;
beforeAll(() => {
  mkdirSync(cwd, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = home; // the never-list resolves ~ through os.homedir()
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

async function hook(command: string) {
  const kyaHome = mkdtempSync(join(tmpdir(), "kya-rule-kh-"));
  scratch.push(kyaHome);
  const stdinText = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "rule", cwd, tool_name: "Bash", tool_input: { command }, tool_use_id: "tu-rule" });
  return runHook({ host: "claude", strict: false, stdinText, env: { HOME: home, KYA_HOME: kyaHome }, cwd });
}

describe(\`rule \${RULE}\`, () => {
  it("is registered, has its replay file, and has no TODO left", () => {
    expect(GUARD_SHELL_RULES as readonly string[]).toContain(RULE);
    const replay = join(import.meta.dirname, "..", "replays", \`class-\${RULE}.yaml\`);
    expect(existsSync(replay)).toBe(true);
    expect(readFileSync(replay, "utf8")).toContain(\`rule: \${RULE}\`);
    expect([...STOPPED, ...PASSING].filter((c) => c.includes("TODO"))).toEqual([]);
  });

  it("has a plain-words label for the near-miss card (the card says: My coding agent tried to <label>.)", () => {
    const label = guardLabel(RULE);
    expect(label, "add a label in LABELS in src/guard-pack.ts").toBeTruthy();
    expect(label).not.toContain("TODO");
    expect(label!.length).toBeLessThanOrEqual(60);
  });

  it("meets the false-positive bar: 2 commands stopped, 3 everyday commands pass", () => {
    expect(STOPPED.length).toBeGreaterThanOrEqual(2);
    expect(PASSING.length).toBeGreaterThanOrEqual(3);
  });

  for (const cmd of STOPPED) {
    it(\`stops: \${cmd.slice(0, 70)}\`, async () => {
      const r = await hook(cmd);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(\`(\${RULE})\`);
    });
  }

  for (const cmd of PASSING) {
    it(\`passes: \${cmd.slice(0, 70)}\`, async () => {
      const r = await hook(cmd);
      expect({ exit: r.exitCode, stdout: r.stdout, stderr: r.stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
    });
  }
});
`;
}

async function main(argv) {
  const rest = argv.filter((a, i) => !a.startsWith("--") && !["--root", "--credit"].includes(argv[i - 1]));
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (rest.length !== 1) { console.error("usage: pnpm new-rule <id> [--credit <github-handle>]"); return 1; }
  const root = resolve(opt("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  try {
    const { writes, summary } = plan(root, rest[0], { credit: opt("--credit") ?? "" });
    for (const [rel, text] of Object.entries(writes)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    console.log(`new rule "${summary.id}":`);
    for (const rel of Object.keys(writes)) console.log(`  wrote ${rel}`);
    console.log(`\nNext:\n  1. In src/guard-pack.ts, fill in the matcher ${summary.matcher}, the hint and the label (the card says "My coding agent tried to <label>."). Search for TODO.\n  2. In ${summary.testRel}, list 2+ commands to stop and 3+ everyday commands that must pass.\n  3. In ${summary.replayRel}, write the dangerous command (placeholders only) and a title.\n  4. In docs/guard-pack.md, describe the rule in its table row.\n  5. pnpm test -- guard-rule-${summary.id} replays && pnpm sync:replays && pnpm build:guard`);
    return 0;
  } catch (e) {
    console.error(`new-rule: ${e.message}`);
    return e instanceof Refused ? 1 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
