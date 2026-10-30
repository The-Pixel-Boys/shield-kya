/**
 * Feature coverage gate (scripts/check-feature-coverage.mjs). Every test builds a throwaway copy of
 * the package (src/, docs/, README.md, vscode/README.md, features.json) and changes one thing, so
 * each mutant must fail for the rule it breaks. The real tree must pass.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { parseCaseLabels, parseHelp, runChecks } from "../scripts/check-feature-coverage.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPIED = ["src", "docs", "test", "README.md", "vscode/README.md", "features.json"];

let dir: string;
const extraDirs: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-features-"));
  extraDirs.push(dir);
  for (const rel of COPIED) {
    const from = join(PKG, rel);
    if (existsSync(from)) cpSync(from, join(dir, rel), { recursive: true });
  }
});
afterEach(() => {
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");
const write = (rel: string, body: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const registry = (): { features: Array<Record<string, any>>; knownGaps: Array<Record<string, any>> } =>
  JSON.parse(read("features.json"));
const saveRegistry = (r: unknown): void => write("features.json", JSON.stringify(r, null, 2));
const row = (r: ReturnType<typeof registry>, id: string): Record<string, any> => {
  const found = r.features.find((x) => x.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};
const problemsOf = (opts: { base?: string } = {}): string[] => runChecks(dir, opts).problems;

describe("feature coverage: real tree", () => {
  it("passes on sdks/kya with every known gap listed", () => {
    const { problems, summary } = runChecks(PKG);
    expect(problems).toEqual([]);
    expect(summary).toContain("79 rows");
    expect(summary).toContain("34 HELP commands");
  });

  it("lists exactly the gaps the design found in 4b and 4c", () => {
    const { gaps } = runChecks(PKG);
    expect(gaps.filter((g: string) => g.startsWith("R3-literal|")).sort()).toEqual([
      "R3-literal|kya-team-init|kya team",
      "R3-literal|kya-team-managed|kya team",
      "R3-literal|kya-update|kya update",
    ]);
  });

  it("every stable or beta row has a tests path, or is a listed R6 gap", () => {
    const r = JSON.parse(readFileSync(join(PKG, "features.json"), "utf8"));
    const { gaps } = runChecks(PKG);
    for (const row of r.features) {
      expect(Array.isArray(row.tests)).toBe(true);
      if (row.status === "stable" || row.status === "beta") {
        const listed = gaps.includes(`R6-tests|${row.id}|`);
        if (row.tests.length === 0) expect(listed).toBe(true);
      }
    }
    // At most 30 known R6 gaps. The public mirror has no hosted test files, so the checker skips the rows
    // that cite ../../ test paths there and counts fewer (24 at 0.32.8). The exact stale-entry check lives in
    // runChecks, so a ceiling here keeps the ratchet and works in both trees.
    expect(gaps.filter((g: string) => g.startsWith("R6-tests|")).length).toBeLessThanOrEqual(30);
  });
});

describe("parsers read text, so lazy command imports do not change them", () => {
  it("finds the 34 HELP commands and the case labels", () => {
    const cli = read("src/cli.ts");
    const help = parseHelp(cli);
    expect(help.commands).toHaveLength(34);
    expect(help.commands).toContain("register-agent");
    expect(parseCaseLabels(cli)).toContain("notify-flush");
  });

  it("gives the same oracle sets when the static imports are removed (on-demand loading)", () => {
    const cli = read("src/cli.ts");
    const lazy = cli.replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
    expect(lazy).not.toEqual(cli);
    expect(parseHelp(lazy).commands).toEqual(parseHelp(cli).commands);
    expect(parseHelp(lazy).flags).toEqual(parseHelp(cli).flags);
    expect(parseCaseLabels(lazy)).toEqual(parseCaseLabels(cli));
  });

  it("reads HELP when a function returns it (the shape N2 moves cli.ts to)", () => {
    const cli = read("src/cli.ts");
    const shaped = cli.replace("const HELP = `", "async function helpText(): Promise<string> {\n  return `").replace(/\n`;\n/, "\n`;\n}\n");
    expect(shaped).not.toEqual(cli);
    expect(parseHelp(shaped).commands).toEqual(parseHelp(cli).commands);
    expect(parseHelp(shaped).flags).toEqual(parseHelp(cli).flags);
  });

  it("fails closed when cli.ts has no HELP block", () => {
    write("src/cli.ts", "export const x = 1;\n");
    expect(problemsOf().join("\n")).toMatch(/PARSE: HELP parse found 0 commands/);
  });

  it("fails closed when the HELP block lists too few commands", () => {
    const cli = read("src/cli.ts");
    const cut = cli.replace(/^  (?!version |start |stop |connect )[a-z][a-z-]*\s.*$/gm, "");
    write("src/cli.ts", cut);
    expect(problemsOf().join("\n")).toMatch(/PARSE: HELP parse found \d+ commands/);
  });

  it("fails closed when no flags are found anywhere", () => {
    const cases = Array.from({ length: 40 }, (_, i) => `  cmd${i}  Does a thing`).join("\n");
    rmSync(join(dir, "src"), { recursive: true, force: true });
    write("src/cli.ts", `const HELP = \`Usage\n\nCommands:\n${cases}\n\nOptions (shared):\n\`;\n`);
    const out = problemsOf().join("\n");
    expect(out).toMatch(/PARSE: found \d+ flag names/);
  });
});

describe("mutants: each change must fail the rule it breaks", () => {
  it("R1: a HELP command with no registry row fails (remove kya-version)", () => {
    const r = registry();
    saveRegistry({ ...r, features: r.features.filter((x) => x.id !== "kya-version") });
    expect(problemsOf().join("\n")).toMatch(/R1: HELP command "kya version" has no registry row/);
  });

  it("R1: a renamed HELP command fails both ways", () => {
    const cli = read("src/cli.ts");
    const renamed = cli.replace(/^  stop(\s+)Stop the background/m, "  stopp$1Stop the background");
    expect(renamed).not.toEqual(cli);
    write("src/cli.ts", renamed);
    const out = problemsOf().join("\n");
    expect(out).toMatch(/R1: HELP command "kya stopp" has no registry row/);
    expect(out).toMatch(/R1: case "stop" in src\/cli.ts is not a HELP command/);
  });

  it("R1: a new case label that is not in HELP fails", () => {
    const cli = read("src/cli.ts");
    write("src/cli.ts", cli.replace('      case "start": {', '      case "zzz-new": {\n        break;\n      }\n      case "start": {'));
    expect(problemsOf().join("\n")).toMatch(/R1: case "zzz-new" in src\/cli.ts is not a HELP command/);
  });

  it("R1: a row that names a command in neither HELP nor a case label fails", () => {
    const r = registry();
    const holder = r.features.find((x) => x.cli.includes("kya stop"));
    expect(holder).toBeTruthy();
    holder!.cli = holder!.cli.map((e: string) => (e === "kya stop" ? "kya zzz-ghost" : e));
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/R1 [^:]+: row names "kya zzz-ghost", which is neither in HELP nor a case label/);
  });

  it("R1: an INTERNAL_COMMANDS entry that is no longer a case label fails (remove it)", () => {
    const cli = read("src/cli.ts");
    const changed = cli.replace('case "notify-flush":', 'case "notify-flush-renamed":');
    expect(changed).not.toEqual(cli);
    write("src/cli.ts", changed);
    expect(problemsOf().join("\n")).toMatch(/R1: INTERNAL_COMMANDS entry "notify-flush" is not a case label in src\/cli.ts \(remove it\)/);
  });

  it("R2: a FLAG_ALIASES entry that no code reads fails (remove it)", () => {
    const recv = read("src/commands/receipt.ts");
    const changed = recv.replace('flagString(parsed.flags, "q", "query", "search")', 'flagString(parsed.flags, "q", "query")');
    expect(changed).not.toEqual(recv);
    write("src/commands/receipt.ts", changed);
    expect(problemsOf().join("\n")).toMatch(/R2: FLAG_ALIASES entry "search" is not read by the code \(remove it\)/);
  });

  it("schema: a null entry in features fails with a message instead of crashing", () => {
    const r = registry();
    saveRegistry({ ...r, features: [...r.features, null] });
    expect(problemsOf().join("\n")).toMatch(/SCHEMA[^\n]*each features entry must be an object/);
  });

  it("parsers: a CRLF checkout of src gives the same oracle as LF", () => {
    for (const rel of ["src/cli.ts"]) write(rel, read(rel).replace(/\n/g, "\r\n"));
    expect(problemsOf()).toEqual([]);
  });

  it("R2: a new flag read in a command module fails", () => {
    write("src/commands/init.ts", read("src/commands/init.ts") + '\nexport const probe = (f: any) => flagBool(f, "brand-new-flag");\n');
    expect(problemsOf().join("\n")).toMatch(/R2: flag "--brand-new-flag" \(src\/commands\/init\.ts\) is in no row/);
  });

  it("R2: a row that lists a flag no code reads fails", () => {
    const r = registry();
    row(r, "kya-sandbox").cli = row(r, "kya-sandbox").cli.map((e: string) => (e === "--cmd" ? "--command" : e));
    saveRegistry(r);
    const out = problemsOf().join("\n");
    expect(out).toMatch(/R2 kya-sandbox: row lists "--command"/);
    expect(out).toMatch(/R2: flag "--cmd"/);
  });

  it("R3: a docs path that does not exist fails", () => {
    const r = registry();
    row(r, "kya-certify").docs = ["docs/missing.md"];
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/R3 kya-certify: docs path "docs\/missing.md" does not exist/);
  });

  it("R3: a new command with no README literal is a NEW GAP", () => {
    write("README.md", read("README.md").replace(/kya start/g, "kya begin"));
    const out = problemsOf().join("\n");
    expect(out).toMatch(/GAP kya-start: NEW GAP: first docs path "README.md" has no "kya start" literal/);
  });

  it("R3 and GAP: a fixed gap whose allowlist entry is kept fails as STALE", () => {
    write("README.md", read("README.md") + "\nkya update and kya team init are documented here.\n");
    const out = problemsOf().join("\n");
    expect(out).toMatch(/STALE knownGaps entry R3-literal\|kya-update\|kya update/);
    expect(out).toMatch(/STALE knownGaps entry R3-literal\|kya-team-init\|kya team/);
  });

  it("GAP: a hosted row with no docs and no knownGaps entry is a NEW GAP", () => {
    const r = registry();
    r.knownGaps = r.knownGaps.filter((g) => g.id !== "kya-sessions");
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/GAP kya-sessions: NEW GAP: no docs path/);
  });

  it("R6: removing the only tests path of a stable row fails (NEW GAP)", () => {
    const r = registry();
    row(r, "kya-certify-sign").tests = [];
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/GAP kya-certify-sign: NEW GAP: no listed tests path exists/);
  });

  it("R6: a listed tests path that does not exist fails", () => {
    const r = registry();
    row(r, "kya-certify").tests = ["test/no-such-file.test.ts"];
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/R6 kya-certify: tests path "test\/no-such-file.test.ts" does not exist/);
  });

  it("R6: a tests path that names nothing from the row does not satisfy the rule", () => {
    const r = registry();
    row(r, "kya-certify-sign").tests = ["test/init.test.ts"];
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/GAP kya-certify-sign: NEW GAP/);
  });

  it("R6: a removed gap entry for a row whose tests now fail fails (no silent drop)", () => {
    const r = registry();
    r.knownGaps = r.knownGaps.filter((g) => !(g.rule === "R6-tests" && g.id === "kya-brew"));
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/GAP kya-brew: NEW GAP: no listed tests path exists/);
  });

  it("R4: a banned claim in a summary fails (hash-chained)", () => {
    const r = registry();
    row(r, "kya-certify").summary = "Lists gaps in a hash-chained trail from local evidence.";
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/R4 kya-certify: summary contains "hash-chained"/);
  });

  it("R4: an enforcement claim for the OSS plan fails", () => {
    const r = registry();
    row(r, "kya-certify").summary = "Enforces the trust baseline on every run.";
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/R4 kya-certify: summary contains "Enforces"/);
  });

  it("R5: a hosted row that cites a repo path fails", () => {
    const r = registry();
    row(r, "kya-kill").docs = ["docs/hosted-hook.md"];
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/R5 kya-kill: plan hosted row cites "docs\/hosted-hook.md"/);
  });

  it("R5: an OSS row that cites a URL or escapes the package fails", () => {
    const r = registry();
    row(r, "kya-certify").docs = ["README.md", "../../web/src/main/java/Docs.java"];
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/R5 kya-certify: plan oss row cites "..\/..\/web/);
  });

  it("schema: a duplicate id fails", () => {
    const r = registry();
    r.features.push({ ...row(r, "kya-version") });
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/SCHEMA kya-version: duplicate id/);
  });

  it("schema: a knownGaps entry with no reason fails", () => {
    const r = registry();
    r.knownGaps[0].reason = "";
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/SCHEMA kya-update: knownGaps entry needs a reason/);
  });

  it("schema: an unknown status fails", () => {
    const r = registry();
    row(r, "kya-certify").status = "stable?";
    saveRegistry(r);
    expect(problemsOf().join("\n")).toMatch(/SCHEMA kya-certify: status "stable\?" is not one of/);
  });
});

describe("R7: diff rule (needs history, PR CI passes --base)", () => {
  const git = (cwd: string, args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t.t", ...args], {
      cwd,
      encoding: "utf8",
    });

  function repoWithPkg(): { pkg: string; base: string } {
    const root = mkdtempSync(join(tmpdir(), "kya-repo-"));
    extraDirs.push(root);
    mkdirSync(join(root, "sdks"), { recursive: true });
    cpSync(dir, join(root, "sdks", "kya"), { recursive: true });
    git(root, ["init", "-q"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]).trim();
    return { pkg: join(root, "sdks", "kya"), base };
  }

  it("fails when cli.ts changes without features.json", () => {
    const { pkg, base } = repoWithPkg();
    const cli = join(pkg, "src", "cli.ts");
    writeFileSync(cli, readFileSync(cli, "utf8") + "\n// touched\n");
    git(join(pkg, ".."), ["add", "-A"]);
    git(join(pkg, ".."), ["commit", "-qm", "touch cli"]);
    const { problems } = runChecks(pkg, { base });
    expect(problems.join("\n")).toMatch(/R7: src\/cli.ts or src\/commands changed without features.json/);
  });

  it("passes when a command module and features.json change together", () => {
    const { pkg, base } = repoWithPkg();
    const init = join(pkg, "src", "commands", "init.ts");
    writeFileSync(init, readFileSync(init, "utf8") + "\n// touched\n");
    const reg = join(pkg, "features.json");
    writeFileSync(reg, readFileSync(reg, "utf8").replace('"summary": "Prints the installed kya version and exits."', '"summary": "Prints the kya version and exits."'));
    git(join(pkg, ".."), ["add", "-A"]);
    git(join(pkg, ".."), ["commit", "-qm", "touch init and registry"]);
    expect(runChecks(pkg, { base }).problems).toEqual([]);
  });

  it("passes when only docs change (the rule is about command code)", () => {
    const { pkg, base } = repoWithPkg();
    writeFileSync(join(pkg, "docs", "telemetry.md"), readFileSync(join(pkg, "docs", "telemetry.md"), "utf8") + "\nnote\n");
    git(join(pkg, ".."), ["add", "-A"]);
    git(join(pkg, ".."), ["commit", "-qm", "docs only"]);
    expect(runChecks(pkg, { base }).problems).toEqual([]);
  });

  it("fails closed when the base ref cannot be resolved", () => {
    const { pkg } = repoWithPkg();
    const out = runChecks(pkg, { base: "no-such-ref" }).problems.join("\n");
    expect(out).toMatch(/R7: cannot compute the range/);
  });
});
