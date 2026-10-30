#!/usr/bin/env node
// Feature coverage gate. sdks/kya/features.json is the registry of every documented kya feature:
// its CLI commands and flags, status, plan and docs. This check keeps the registry in step with
// the code and the OSS docs.
//
//   node scripts/check-feature-coverage.mjs                     # rules R1 to R6, exit 1 on a problem
//   node scripts/check-feature-coverage.mjs --base origin/main  # also R7 (diff rule, needs history)
//   node scripts/check-feature-coverage.mjs --pkg <dir>         # check another package root (tests, pending branches)
//
// Oracles are read as text, never imported, so a change to how src/cli.ts imports its command
// modules (static or on demand) does not change them:
//   commands  the "Commands:" section of the HELP text in src/cli.ts, and the `case "x":` labels.
//   flags     every string literal passed to flagString / flagBool / flagInt / collectMulti after
//             the first argument, every flags["x"] read, and every --name token in HELP.
//             LIMIT: a flag name built at run time (a variable instead of a literal) is invisible.
//
// Registry shape: { features: [row], knownGaps: [gap] }. A row cli entry starting with `kya ` is a
// command; one starting with `-` is a flag; anything else is free text that no rule parses (env vars,
// `brew install ...`, `uses: ...`). Docs paths are package-relative (`README.md`, `docs/x.md`), so the
// public mirror, which has the same layout, runs the same check. Hosted rows cite public https URLs.
//
// Rules:
//   R1 command oracle: every HELP command has a row; every row command and every case label is a
//      HELP command or an INTERNAL_COMMANDS entry.
//   R2 flag oracle: every flag from code or HELP has a row (through FLAG_ALIASES for alternate
//      spellings); every row flag exists in code or HELP (or is a GLOBAL_FLAGS entry).
//   R3 docs: an oss/both row's first docs path exists and contains every `kya <cmd>` literal of
//      its row. A row with no docs path is a gap unless status is flagged.
//   R4 claims: name and summary match neither FORBIDDEN (check-channel-copy.mjs) nor CLAIMS_EXTRA.
//   R5 plan scope: oss/both rows cite package paths only; hosted rows cite https URLs only.
//   R6 tests: every stable or beta row lists at least one `tests` path that exists and contains the
//      feature id or one of its cli entries as written. Hosted rows cite ../../ paths (the monorepo).
//      Those are checked only when the monorepo is present; the public mirror skips them.
//   R7 diff rule (--base only): a change to src/cli.ts or src/commands/*.ts needs features.json changed.
//      No `Features: n/a` escape in B1; the trailer rule lands with B2.
//   R8 (generated surfaces must skip flagged rows) has no generated surface yet. It lands with B2/B4.
//
// Known gaps: features.json knownGaps lists today's real gaps, each with a reason and the node that
// clears it. A gap that is not listed fails. A listed gap that is gone fails too (remove the entry).
// Fail closed: when the parse finds too few commands or flags, the run fails instead of passing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN } from "./check-channel-copy.mjs";

export const REGISTRY = "features.json";
const CLI = "src/cli.ts";
const MIN_COMMANDS = 30; // HELP has 32 commands and cli.ts has 34 case labels today
const MIN_FLAGS = 20; // about 80 today
const STATUSES = new Set(["stable", "beta", "planned", "flagged"]);
const PLANS = new Set(["oss", "hosted", "both"]);
const ROW_KEYS = new Set(["id", "name", "summary", "cli", "docs", "tests", "status", "plan"]);
const TEST_STATUS = new Set(["stable", "beta"]);
const GAP_RULES = new Set(["R3-literal", "R3-docs", "R6-tests"]);
const CLAIMS_EXTRA = /\b(hash-chained|tamper-evident)\b/i;

// Commands that exist in cli.ts as `case` labels but are not HELP commands (internal processes).
export const INTERNAL_COMMANDS = {
  "receipt-serve": "internal server behind the receipt report",
  "gate-serve": "internal gateway process started by kya gate run",
  "notify-flush": "internal flush of queued notifications",
};

// Flags every command accepts or that are generic (not a feature row of their own).
export const GLOBAL_FLAGS = {
  h: "short help",
  help: "help",
  v: "short version",
  V: "short version",
  version: "version",
  json: "machine-readable output, shared by commands",
};

// Alternate spellings read by the code. Each maps to the canonical flag a row must list.
export const FLAG_ALIASES = {
  sandboxId: { to: "sandbox-id", why: "camelCase alias read by eval-tool.ts and sandbox.ts" },
  toolId: { to: "tool-id", why: "camelCase alias read by eval-tool.ts and invoke.ts" },
  actionClass: { to: "action-class", why: "camelCase alias read by invoke.ts" },
  argsHash: { to: "args-hash", why: "camelCase alias read by invoke.ts" },
  breakGlassReason: { to: "break-glass-reason", why: "camelCase alias read by register-agent.ts" },
  versionHash: { to: "version-hash", why: "camelCase alias read by register-agent.ts" },
  workItem: { to: "work-item", why: "camelCase alias read by wrap.ts" },
  shareRetries: { to: "share-retries", why: "camelCase alias read by receipt.ts" },
  sessionId: { to: "session", why: "camelCase alias read by receipt.ts" },
  "session-id": { to: "session", why: "alternate spelling read by receipt.ts" },
  outDir: { to: "out", why: "camelCase alias read by receipt.ts" },
  "out-dir": { to: "out", why: "alternate spelling read by receipt.ts" },
  query: { to: "q", why: "alternate spelling read by receipt.ts" },
  search: { to: "q", why: "alternate spelling read by receipt.ts" },
};

const FLAG_HELPER_RE = /flag(?:String|Bool|Int)\(\s*[\w.]+\s*,\s*((?:"[^"]*"\s*,?\s*)+)/g;
const FLAG_READ_RE = /flags\[\s*"([^"]+)"\s*\]/g;
const FLAG_MULTI_RE = /collectMulti\(\s*\w+\s*,\s*"([^"]+)"/g;

/**
 * HELP commands (first word of each line in the "Commands:" section) and every `--flag` token in HELP.
 * The HELP text is the template literal that holds the "Commands:" section. That literal may be a
 * `const HELP` (today) or the return value of a function (N2 moved it), so the parser finds the
 * literal by its contents, not by its declaration.
 */
export function parseHelp(cliText) {
  const marker = cliText.indexOf("\nCommands:\n");
  const open = marker < 0 ? -1 : cliText.lastIndexOf("`", marker);
  const close = open < 0 ? -1 : cliText.indexOf("`", marker);
  if (open < 0 || close < 0) return { helpText: "", commands: [], flags: [] };
  const helpText = cliText.slice(open, close);
  const c1 = helpText.indexOf("\nOptions (shared):");
  const section = helpText.slice(helpText.indexOf("\nCommands:\n"), c1 < 0 ? undefined : c1);
  const commands = [...new Set([...section.matchAll(/^  ([a-z][a-z0-9-]*)(?=\s|$)/gm)].map((m) => m[1]))];
  const flags = [...new Set([...helpText.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]))];
  return { helpText, commands, flags };
}

/** Names of `case "x":` labels in cli.ts. */
export function parseCaseLabels(cliText) {
  return [...new Set([...cliText.matchAll(/^\s*case "([a-z][a-z0-9-]*)":/gm)].map((m) => m[1]))];
}

/** Flag names read by code. files: [{ path, text }]. Returns Map name -> Set(path). */
export function parseCodeFlags(files) {
  const found = new Map();
  for (const { path, text } of files) {
    const add = (name) => found.set(name, (found.get(name) ?? new Set()).add(path));
    for (const m of text.matchAll(FLAG_HELPER_RE)) for (const s of m[1].matchAll(/"([^"]*)"/g)) add(s[1]);
    for (const m of text.matchAll(FLAG_READ_RE)) add(m[1]);
    for (const m of text.matchAll(FLAG_MULTI_RE)) add(m[1]);
  }
  return found;
}

const cmdOf = (entry) => (entry.startsWith("kya ") ? entry.split(/\s+/)[1] : undefined);
const flagOf = (entry) => (/^--?[A-Za-z]/.test(entry) ? entry.replace(/^--?/, "") : undefined);
/** Literals R3 checks: `kya <cmd>` for each command entry of a row (two words, e.g. `kya team`). */
export const literalsOf = (row) => [...new Set(row.cli.filter((e) => cmdOf(e)).map((e) => `kya ${cmdOf(e)}`))];
const gapKey = (rule, id, literal = "") => `${rule}|${id}|${literal}`;

function walkTs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walkTs(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const formatProblem = ({ rule, id, msg }) => `${rule}${id ? ` ${id}` : ""}: ${msg}`;

/** Runs the rules against one package root (sdks/kya or the public mirror root). */
export function runChecks(pkg, { base } = {}) {
  const problems = [];
  const bad = (rule, id, msg) => problems.push({ rule, id, msg });

  const cliPath = join(pkg, CLI);
  if (!existsSync(cliPath)) {
    bad("PARSE", undefined, `${CLI} not found under ${pkg}`);
    return { problems: problems.map(formatProblem), summary: "" };
  }
  const cliText = readFileSync(cliPath, "utf8").replace(/\r\n/g, "\n");
  const help = parseHelp(cliText);
  const cases = parseCaseLabels(cliText);
  const srcFiles = walkTs(join(pkg, "src")).map((p) => ({ path: relative(pkg, p), text: readFileSync(p, "utf8").replace(/\r\n/g, "\n") }));
  const codeFlags = parseCodeFlags(srcFiles);

  // Fail closed: an oracle that parses almost nothing must not pass every rule with no work.
  if (help.commands.length < MIN_COMMANDS) bad("PARSE", undefined, `HELP parse found ${help.commands.length} commands, expected at least ${MIN_COMMANDS}`);
  if (cases.length < MIN_COMMANDS) bad("PARSE", undefined, `found ${cases.length} case labels in ${CLI}, expected at least ${MIN_COMMANDS}`);
  const allFlags = new Set([...help.flags, ...codeFlags.keys()]);
  if (allFlags.size < MIN_FLAGS) bad("PARSE", undefined, `found ${allFlags.size} flag names, expected at least ${MIN_FLAGS}`);

  let registry;
  try {
    registry = JSON.parse(readFileSync(join(pkg, REGISTRY), "utf8"));
  } catch (e) {
    bad("SCHEMA", undefined, `${REGISTRY} is missing or not valid JSON (${e.message})`);
    return { problems: problems.map(formatProblem), summary: "" };
  }
  const rows = Array.isArray(registry.features) ? registry.features : (bad("SCHEMA", undefined, "features must be an array"), []);
  const knownGaps = Array.isArray(registry.knownGaps) ? registry.knownGaps : (bad("SCHEMA", undefined, "knownGaps must be an array"), []);

  // Schema: strict keys, unique ids, enumerated status and plan.
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      bad("SCHEMA", "(not an object)", "each features entry must be an object");
      continue;
    }
    const id = row.id;
    const where = typeof id === "string" ? id : "(no id)";
    for (const k of Object.keys(row ?? {})) if (!ROW_KEYS.has(k)) bad("SCHEMA", where, `unknown key "${k}"`);
    if (typeof id !== "string" || !/^kya-[a-z0-9-]+$/.test(id)) bad("SCHEMA", where, "id must match kya-<slug>");
    if (seen.has(id)) bad("SCHEMA", where, "duplicate id");
    seen.add(id);
    if (typeof row.name !== "string" || !row.name) bad("SCHEMA", where, "name must be a non-empty string");
    if (typeof row.summary !== "string" || !row.summary) bad("SCHEMA", where, "summary must be a non-empty string");
    for (const k of ["cli", "docs", "tests"]) {
      if (!Array.isArray(row[k]) || !row[k].every((x) => typeof x === "string")) bad("SCHEMA", where, `${k} must be an array of strings`);
    }
    if (!STATUSES.has(row.status)) bad("SCHEMA", where, `status "${row.status}" is not one of ${[...STATUSES].join(", ")}`);
    if (!PLANS.has(row.plan)) bad("SCHEMA", where, `plan "${row.plan}" is not one of ${[...PLANS].join(", ")}`);
  }
  const structural = problems.some((p) => p.rule === "SCHEMA");
  if (structural) return { problems: problems.map(formatProblem), summary: "" };

  // R1: command oracle.
  const rowCommands = new Map(); // command -> row ids
  for (const row of rows) {
    for (const e of row.cli) {
      const c = cmdOf(e);
      if (c) rowCommands.set(c, [...(rowCommands.get(c) ?? []), row.id]);
    }
  }
  const helpSet = new Set(help.commands);
  const caseSet = new Set(cases);
  for (const c of help.commands) if (!rowCommands.has(c)) bad("R1", undefined, `HELP command "kya ${c}" has no registry row`);
  for (const c of cases) if (!helpSet.has(c) && !(c in INTERNAL_COMMANDS)) bad("R1", undefined, `case "${c}" in ${CLI} is not a HELP command and not an INTERNAL_COMMANDS entry`);
  for (const [c, ids] of rowCommands) {
    if (!helpSet.has(c) && !caseSet.has(c)) bad("R1", ids.join(","), `row names "kya ${c}", which is neither in HELP nor a case label`);
  }
  for (const c of Object.keys(INTERNAL_COMMANDS)) if (!caseSet.has(c)) bad("R1", undefined, `INTERNAL_COMMANDS entry "${c}" is not a case label in ${CLI} (remove it)`);

  // R2: flag oracle.
  const rowFlags = new Map(); // flag -> row ids
  for (const row of rows) {
    for (const e of row.cli) {
      const f = flagOf(e);
      if (f) rowFlags.set(f, [...(rowFlags.get(f) ?? []), row.id]);
    }
  }
  const canonical = (name) => FLAG_ALIASES[name]?.to ?? name;
  const codeAndHelp = new Set([...allFlags]);
  for (const name of codeAndHelp) {
    if (name in GLOBAL_FLAGS) continue;
    const want = canonical(name);
    if (!rowFlags.has(want)) {
      const where = [...(codeFlags.get(name) ?? []), ...(help.flags.includes(name) ? [CLI + " HELP"] : [])].join(", ");
      bad("R2", undefined, `flag "--${name}" (${where}) is in no row`);
    }
  }
  for (const [name, { why }] of Object.entries(FLAG_ALIASES)) {
    if (!codeAndHelp.has(name)) bad("R2", undefined, `FLAG_ALIASES entry "${name}" is not read by the code (remove it)`);
    if (typeof why !== "string" || why.trim().length < 10) bad("R2", undefined, `FLAG_ALIASES entry "${name}" has no reason`);
  }
  for (const [f, ids] of rowFlags) {
    if (f in GLOBAL_FLAGS) continue;
    if (!codeAndHelp.has(f)) bad("R2", ids.join(","), `row lists "--${f}", which no code or HELP reads`);
  }

  // R3 (docs), R5 (plan scope), gaps.
  const gaps = new Map(); // key -> message
  for (const row of rows) {
    if (row.status === "flagged") continue; // not live: no public docs by design
    const docs = row.docs;
    if (docs.length === 0) {
      gaps.set(gapKey("R3-docs", row.id), `no docs path (plan ${row.plan})`);
      continue;
    }
    if (row.plan === "hosted") {
      for (const d of docs) {
        if (!/^https:\/\/[^\s]+$/.test(d)) bad("R5", row.id, `plan hosted row cites "${d}": hosted rows cite public https URLs only`);
      }
      continue;
    }
    for (const d of docs) {
      if (/^(https?:|\/)/.test(d) || d.split("/").includes("..")) bad("R5", row.id, `plan ${row.plan} row cites "${d}": OSS rows cite package paths only`);
    }
    const first = docs[0];
    const firstPath = join(pkg, first);
    if (!existsSync(firstPath)) {
      bad("R3", row.id, `docs path "${first}" does not exist`);
      continue;
    }
    const text = readFileSync(firstPath, "utf8");
    for (const d of docs.slice(1)) if (!existsSync(join(pkg, d))) bad("R3", row.id, `docs path "${d}" does not exist`);
    for (const lit of literalsOf(row)) {
      if (!text.includes(lit)) gaps.set(gapKey("R3-literal", row.id, lit), `first docs path "${first}" has no "${lit}" literal`);
    }
  }

  // R4: claims in prose. The cli field is exempt (flags such as --fail-closed are real).
  for (const row of rows) {
    for (const field of ["name", "summary"]) {
      const m = FORBIDDEN.exec(row[field]) ?? CLAIMS_EXTRA.exec(row[field]);
      if (m) bad("R4", row.id, `${field} contains "${m[0]}", a claim the copy rules forbid`);
    }
  }

  // R6: tests. A listed path must exist; a stable or beta row needs one listed file that names it.
  const monorepo = existsSync(join(pkg, "..", "..", "app")) || existsSync(join(pkg, "..", "..", "web"));
  let skippedTests = 0;
  const skippedIds = new Set();
  for (const row of rows) {
    if (!TEST_STATUS.has(row.status)) {
      for (const t of row.tests) if (!existsSync(join(pkg, t)) && !t.startsWith("../../")) bad("R6", row.id, `tests path "${t}" does not exist`);
      continue;
    }
    if (!monorepo && row.tests.some((t) => t.startsWith("../../"))) {
      skippedTests++; // hosted tests live in the monorepo; the public mirror cannot see them
      skippedIds.add(row.id);
      continue;
    }
    const names = [row.id, ...row.cli.filter((e) => e.trim().length > 0)];
    let satisfied = false;
    for (const t of row.tests) {
      if (t.startsWith("/") || (t.split("/").includes("..") && !t.startsWith("../../"))) {
        bad("R6", row.id, `tests path "${t}" must be package-relative or start with ../../ (monorepo)`);
        continue;
      }
      const p = join(pkg, t);
      if (!existsSync(p)) {
        bad("R6", row.id, `tests path "${t}" does not exist`);
        continue;
      }
      const text = readFileSync(p, "utf8");
      if (names.some((n) => text.includes(n))) satisfied = true;
    }
    if (!satisfied) gaps.set(gapKey("R6-tests", row.id), "no listed tests path exists that names the feature (its id or a cli entry)");
  }

  // Known gaps: every real gap is listed with a reason and a clearing node; no stale entries.
  const allow = new Map();
  for (const g of knownGaps) {
    const id = g?.id ?? "(no id)";
    if (!GAP_RULES.has(g?.rule)) bad("SCHEMA", id, `knownGaps rule "${g?.rule}" is not one of ${[...GAP_RULES].join(", ")}`);
    if (g?.rule === "R3-literal" && typeof g.literal !== "string") bad("SCHEMA", id, "R3-literal gap needs a literal");
    if (typeof g?.reason !== "string" || g.reason.replace(/\s/g, "").length < 10) bad("SCHEMA", id, "knownGaps entry needs a reason (10+ characters)");
    if (typeof g?.clearedBy !== "string" || !g.clearedBy) bad("SCHEMA", id, "knownGaps entry needs clearedBy (the node that clears it)");
    allow.set(gapKey(g?.rule, g?.id, g?.literal ?? ""), g);
  }
  for (const [key, msg] of gaps) {
    if (!allow.has(key)) bad("GAP", key.split("|")[1], `NEW GAP: ${msg}. Fix the row, or add a knownGaps entry with a reason and clearedBy`);
  }
  for (const key of allow.keys()) {
    if (key.startsWith("R6-tests|") && skippedIds.has(key.split("|")[1])) continue; // not evaluated here
    if (!gaps.has(key)) bad("GAP", key.split("|")[1], `STALE knownGaps entry ${key}: it is no longer a gap. Remove the entry`);
  }

  // R7: diff rule, needs history (PR CI passes --base).
  if (base) {
    let mb;
    try {
      mb = git(pkg, ["merge-base", base, "HEAD"]).trim();
    } catch {
      bad("R7", undefined, `cannot compute the range: no merge-base of "${base}" and HEAD (fetch the target branch)`);
    }
    if (mb) {
      const changed = git(pkg, ["diff", "--relative", "--name-only", "-z", mb, "HEAD"]).split("\0").filter(Boolean);
      const codeChanged = changed.some((p) => p === CLI || (p.startsWith("src/commands/") && p.endsWith(".ts")));
      if (codeChanged && !changed.includes(REGISTRY)) {
        bad("R7", undefined, `src/cli.ts or src/commands changed without ${REGISTRY} (update the registry in this PR)`);
      }
    }
  }

  const summary = `${rows.length} rows (${rows.filter((r) => r.plan !== "hosted").length} oss or both), ${help.commands.length} HELP commands, ${allFlags.size} flags, ${gaps.size} known gaps allowlisted${skippedTests ? `, ${skippedTests} hosted test checks skipped (no monorepo)` : ""}`;
  return { problems: problems.map(formatProblem), summary, gaps: [...gaps.keys()] };
}

function main(argv) {
  let pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
  let base;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pkg") pkg = argv[++i];
    else if (argv[i] === "--base") base = argv[++i];
    else {
      console.error("usage: check-feature-coverage.mjs [--pkg <dir>] [--base <ref>]");
      process.exit(2);
    }
  }
  const { problems, summary } = runChecks(pkg, { base });
  if (problems.length > 0) {
    console.error(`feature coverage: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    console.error(`\nFix: edit sdks/kya/${REGISTRY} (rows and knownGaps) and the docs it cites, then rerun.`);
    process.exit(1);
  }
  console.log(`feature coverage OK: ${summary}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
