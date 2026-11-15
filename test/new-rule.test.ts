/**
 * pnpm new-rule <id> (scripts/new-rule.mjs, spec G4): the scaffold for a contributor's rule PR.
 * Works on a scratch copy of the files it edits, so the real tree is never written. The last group plans a rule against the
 * real files (no write) to prove the markers and the docs anchor are still in place.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
// @ts-expect-error plain .mjs script, no type declarations
import { plan } from "../scripts/new-rule.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { parseReplay, validateReplay } from "../scripts/lib/replays.mjs";

const PKG = join(import.meta.dirname, "..");
const SCRIPT = join(PKG, "scripts", "new-rule.mjs");
const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A scratch package root with only the files the scaffold reads or edits. */
function root(extra: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "kya-newrule-"));
  scratch.push(d);
  for (const rel of ["src/guard-pack.ts", "docs/guard-pack.md", "package.json", "replays/class-terraform-destroy.yaml"]) {
    mkdirSync(join(d, rel, ".."), { recursive: true });
    cpSync(join(PKG, rel), join(d, rel));
  }
  for (const [rel, text] of Object.entries(extra)) { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), text); }
  return d;
}
/** path -> sha of every file under a root: equal before and after means nothing was written. */
function snap(d: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(d, rel))) {
    const r = rel ? `${rel}/${e}` : e;
    if (statSync(join(d, r)).isDirectory()) Object.assign(out, snap(d, r));
    else out[r] = createHash("sha256").update(readFileSync(join(d, r))).digest("hex");
  }
  return out;
}
const cli = (d: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args, "--root", d], { encoding: "utf8" });

/** Type errors of `text` placed at `file` (a path inside the real package), with the real tsconfig rules. */
function typeErrors(file: string, text: string): string[] {
  const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(join(PKG, "tsconfig.json"), ts.sys.readFile).config, ts.sys, PKG);
  const options: ts.CompilerOptions = { ...cfg.options, noEmit: true, rootDir: undefined, outDir: undefined, declaration: false, declarationMap: false, sourceMap: false };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (f, lv, ...rest) => (f === file ? ts.createSourceFile(f, text, lv) : getSourceFile(f, lv, ...rest));
  host.fileExists = (f) => f === file || fileExists(f);
  host.readFile = (f) => (f === file ? text : readFile(f));
  const program = ts.createProgram([file], options, host);
  return ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("pnpm new-rule: scaffold", () => {
  it("is registered in package.json", () => {
    expect(JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).scripts["new-rule"]).toBe("node scripts/new-rule.mjs");
  });

  it("creates the rule stub, the test block and the replay file, and the result type checks", () => {
    const d = root();
    const r = cli(d, "sample-widget-rule", "--credit", "outside-dev");
    expect(r.status, r.stderr).toBe(0);
    const g = readFileSync(join(d, "src/guard-pack.ts"), "utf8");
    expect(g).toContain('  "sample-widget-rule",\n  // new-rule:ids');
    expect(g).toContain("const sampleWidgetRule: Matcher = (_sh, _ctx) => NO; // TODO(new-rule)");
    expect(g).toContain('  ["sample-widget-rule", sampleWidgetRule],\n  // new-rule:entries');
    expect(g).toContain('  "sample-widget-rule": "TODO:');
    expect(g).toContain('  "sample-widget-rule": "TODO what the agent tried to do, in plain words, no command text",\n  // new-rule:labels');
    for (const m of ["ids", "matchers", "entries", "hints", "labels"]) expect(g.match(new RegExp(`// new-rule:${m}`, "g"))).toHaveLength(1);
    const docs = readFileSync(join(d, "docs/guard-pack.md"), "utf8");
    expect(docs).toMatch(/\| `sample-widget-rule` \| TODO[^\n]*\|\n\n### The ask outcome/);
    const test = readFileSync(join(d, "test/guard-rule-sample-widget-rule.test.ts"), "utf8");
    expect(test).toContain('const RULE = "sample-widget-rule";');
    expect(test).toContain("guardLabel(RULE)");
    expect(test).toMatch(/STOPPED: string\[\] = \[\n  "TODO[^\n]*\n  "TODO/);
    const replayText = readFileSync(join(d, "replays/class-sample-widget-rule.yaml"), "utf8");
    const replay = parseReplay(replayText);
    expect(replay).toMatchObject({ id: "class-sample-widget-rule", kind: "class", expect: "deny", rule: "sample-widget-rule", credit: "outside-dev", host: "claude", tool: "Bash" });
    expect(replay.since).toMatch(/^\d+\.\d+\.0$/);
    // valid in shape; the only problem is the TODO placeholders, so a forgotten stub cannot be merged
    expect(validateReplay(replay, "class-sample-widget-rule.yaml")).toEqual(["a TODO placeholder is left in the file (pnpm new-rule writes them: replace each one)"]);
    // the new code compiles under the package's strict rules (unused locals and parameters included)
    expect(typeErrors(join(PKG, "src/guard-pack.ts"), g)).toEqual([]);
    expect(typeErrors(join(PKG, "test/guard-rule-sample-widget-rule.test.ts"), test)).toEqual([]);
  }, 90_000);

  it("the stub matches nothing yet: the new test and the replay are red until the contributor edits them", () => {
    const d = root();
    cli(d, "sample-widget-rule");
    const test = readFileSync(join(d, "test/guard-rule-sample-widget-rule.test.ts"), "utf8");
    expect(test).toContain('expect([...STOPPED, ...PASSING].filter((c) => c.includes("TODO"))).toEqual([]);');
    expect(readFileSync(join(d, "replays/class-sample-widget-rule.yaml"), "utf8")).toContain("TODO the dangerous command");
  });

  it("refuses an id that exists: no change, exit 1; a second run is a no-op (idempotent)", () => {
    const d = root({ "src/other.ts": 'export const R = "legacy-style-rule";\n', "replays/class-x.yaml": "id: class-x\nrule: replay-only-rule\n" });
    for (const id of ["terraform-destroy", "legacy-style-rule", "replay-only-rule", "cloud-delete"]) {
      const before = snap(d);
      const r = cli(d, id);
      expect({ id, status: r.status }).toEqual({ id, status: 1 });
      expect(r.stderr).toContain("exists already");
      expect(snap(d)).toEqual(before);
    }
    expect(cli(d, "sample-widget-rule").status).toBe(0);
    const after = snap(d);
    const again = cli(d, "sample-widget-rule");
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/exists already.*GUARD_SHELL_RULES/);
    expect(snap(d)).toEqual(after);
  });

  it("refuses an id whose test file or replay file already exists, even if the id is new elsewhere", () => {
    const d = root({ "test/guard-rule-file-only.test.ts": "// mine\n", "replays/class-replay-file-only.yaml": "id: class-replay-file-only\n" });
    for (const id of ["file-only", "replay-file-only"]) {
      const before = snap(d);
      const r = cli(d, id);
      expect({ id, status: r.status }).toEqual({ id, status: 1 });
      expect(r.stderr).toMatch(/exists\)|exists;/);
      expect(snap(d)).toEqual(before);
    }
  });

  it("refuses a bad id or a bad handle and writes nothing", () => {
    const d = root();
    const before = snap(d);
    const bad = ["", "Bad-Id", "Bad", "has_underscore", "1abc", "ab", "a--b", "-lead", "trail-", "x".repeat(41), "../escape", "secret-read-thing", "exfil-x", "never-x", "guard-config", "with space"];
    for (const id of bad) {
      const r = id === "" ? spawnSync(process.execPath, [SCRIPT, "--root", d], { encoding: "utf8" }) : cli(d, id);
      expect({ id, status: r.status }).toEqual({ id, status: 1 });
    }
    expect(cli(d, "good-rule", "--credit", "not a handle!").status).toBe(1);
    expect(cli(d, "good-rule", "--credit", "-leading").status).toBe(1);
    expect(snap(d)).toEqual(before);
  });

  it("stops with exit 2 and writes nothing when a marker or the docs anchor is gone", () => {
    for (const [file, from] of [["src/guard-pack.ts", "// new-rule:labels"], ["src/guard-pack.ts", "// new-rule:hints"], ["src/guard-pack.ts", "// new-rule:ids"], ["docs/guard-pack.md", "### The ask outcome"]] as const) {
      const d = root();
      writeFileSync(join(d, file), readFileSync(join(d, file), "utf8").replace(from, "// removed"));
      const before = snap(d);
      const r = cli(d, "sample-widget-rule");
      expect({ file, status: r.status }).toEqual({ file, status: 2 });
      expect(snap(d)).toEqual(before);
    }
  });

  it("finds every marker and the docs anchor in the real files (a plan, nothing written)", () => {
    const before = snap(PKG, "src");
    const p = plan(PKG, "zz-probe-rule");
    expect(Object.keys(p.writes).sort()).toEqual(["docs/guard-pack.md", "replays/class-zz-probe-rule.yaml", "src/guard-pack.ts", "test/guard-rule-zz-probe-rule.test.ts"]);
    expect(snap(PKG, "src")).toEqual(before);
    expect(typeErrors(join(PKG, "src/guard-pack.ts"), p.writes["src/guard-pack.ts"])).toEqual([]);
  }, 90_000);
});
