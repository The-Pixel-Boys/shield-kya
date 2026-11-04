/**
 * Generated feature lists (scripts/sync-features.mjs), the R7 trailer escape and the reason rule.
 * The generator runs as a real process (node scripts/sync-features.mjs) on a throwaway copy of the
 * package, so each mutant must make the command exit 1 for the reason it breaks.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { reasonOk, runChecks } from "../scripts/check-feature-coverage.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { renderHostedFragment, renderLlms } from "../scripts/sync-features.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC = join(PKG, "scripts", "sync-features.mjs");
const MONOREPO = existsSync(join(PKG, "..", "..", "scripts", "ci", "check-docs-parity.sh"));
const COPIED = ["src", "docs", "test", "scripts", "README.md", "vscode/README.md", "features.json"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-sync-"));
  for (const rel of COPIED) {
    const from = join(PKG, rel);
    if (existsSync(from)) cpSync(from, join(dir, rel), { recursive: true });
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");
const write = (rel: string, body: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const sync = (args: string[] = ["--check"]) =>
  spawnSync(process.execPath, [join(dir, "scripts", "sync-features.mjs"), ...args], { encoding: "utf8" });
const git = (args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });

describe("generated feature lists: real tree", () => {
  it("the committed README block and docs/features.md match features.json", () => {
    const r = spawnSync(process.execPath, [SYNC, "--check"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("generated feature lists: mutants", () => {
  it("a hand edit inside the README block is stale (exit 1)", () => {
    write("README.md", read("README.md").replace("| Print version |", "| Print the version (hand edit) |"));
    const r = sync();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("README.md");
  });

  it("a stale docs/features.md is stale (exit 1)", () => {
    write("docs/features.md", read("docs/features.md") + "\nhand edit\n");
    expect(sync().status).toBe(1);
  });

  it("the write mode repairs a stale file, and then --check passes", () => {
    write("docs/features.md", "stale\n");
    expect(sync([]).status).toBe(0);
    expect(sync().status).toBe(0);
  });

  it("a missing marker is a problem, not a silent skip", () => {
    write("README.md", read("README.md").replace("<!-- features:end -->", ""));
    const r = sync([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("feature markers");
  });

  it("flagging a row removes it from both generated files", () => {
    const r = JSON.parse(read("features.json"));
    const row = r.features.find((x: { id: string }) => x.id === "kya-certify");
    expect(row).toBeTruthy();
    row.status = "flagged";
    write("features.json", JSON.stringify(r, null, 2));
    expect(sync([]).status).toBe(0);
    // The row name is used, not the command: the command also appears in the prose outside the block.
    const block = read("README.md").split("<!-- features:start -->")[1];
    expect(block).not.toContain("Trust baseline gap report");
    expect(read("docs/features.md")).not.toContain("Trust baseline gap report");
  });

  it("planned rows, hosted rows and test paths never reach a generated file", () => {
    const readme = read("README.md");
    const page = read("docs/features.md");
    // kya-devcontainer is planned (not published), kya-invoke is hosted only.
    expect(readme).not.toContain("Dev Container feature");
    expect(page).not.toContain("Dev Container feature");
    expect(readme).not.toContain("kya invoke");
    expect(page).not.toContain("kya invoke");
    // The tests column is never rendered: no ../../ monorepo path and no test file name.
    expect(page).not.toContain("../../");
    expect(page).not.toContain("test/team.test.ts");
  });

  it("the docs page links docs/ pages and shows README rows as plain paths", () => {
    const page = read("docs/features.md");
    expect(page).toContain("[docs/team-rollout.md](team-rollout.md)");
    expect(page).toContain("| Team rollout: commit plugin pin |");
    expect(page).toMatch(/\| Print version \|.*\| README \|$/m);
  });
});

describe("R7 trailer escape (Features: n/a)", () => {
  // A throwaway repo holding one commit, then one commit that changes src/cli.ts only.
  const commitCliChange = (message: string): string => {
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    write("src/cli.ts", read("src/cli.ts") + "\n// comment only\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
    return base;
  };
  const r7 = (base: string): string[] => runChecks(dir, { base }).problems.filter((p: string) => p.startsWith("R7"));

  it("a cli.ts change with no registry change and no trailer fails R7", () => {
    const base = commitCliChange("chore: comment");
    expect(r7(base)).toHaveLength(1);
  }, 30_000);

  it("a Features: n/a line with a real reason passes R7", () => {
    const base = commitCliChange("chore: comment\n\nFeatures: n/a comment only, no command or flag changed");
    expect(r7(base)).toEqual([]);
  }, 30_000);

  it("a Features: n/a line with a one-character reason fails R7 and says why", () => {
    const base = commitCliChange("chore: comment\n\nFeatures: n/a x");
    const out = r7(base);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("too short or repeated");
  }, 30_000);

  it("a Features: n/a line with one repeated character fails R7", () => {
    const base = commitCliChange("chore: comment\n\nFeatures: n/a aaaaaaaaaaaaaaaa");
    expect(r7(base)).toHaveLength(1);
  }, 30_000);

  it("a registry change in the range passes R7 without a trailer", () => {
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    write("src/cli.ts", read("src/cli.ts") + "\n// comment only\n");
    write("features.json", read("features.json") + "\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "chore: comment"]);
    expect(r7(base)).toEqual([]);
  }, 30_000);
});

describe("reason rule (reasonOk, port of reason_ok in check-docs-parity.sh)", () => {
  const corpus = [
    "",
    "short",
    "aaaaaaaaaaaaaaaa",
    "a a a a a a a a a a a",
    "ok ok ok ok ok ok ok ok ok ok ok",
    "single-word-of-ten-plus-chars",
    "Team rollout only touched docs",
    "n/a n/a n/a n/a n/a",
    "comment only change here",
    " x ",
    "abcabcabcabc def",
    "one two three four five",
    "ab ab ab ab ab",
  ];

  it("accepts a real reason and rejects a short, repeated or empty one", () => {
    expect(reasonOk("comment only change here")).toBe(true);
    expect(reasonOk("short")).toBe(false);
    expect(reasonOk("aaaaaaaaaaaaaaaa")).toBe(false);
    expect(reasonOk("n/a n/a n/a n/a n/a")).toBe(false);
    expect(reasonOk("")).toBe(false);
  });

  it.runIf(MONOREPO)("agrees with the bash reason_ok on every corpus line", () => {
    const script = join(PKG, "..", "..", "scripts", "ci", "check-docs-parity.sh");
    const bashOk = (reason: string): boolean =>
      spawnSync("bash", ["-c", 'eval "$(sed -n \'/^reason_ok()/,/^}/p\' "$1")"; reason_ok "$2"', "_", script, reason]).status === 0;
    for (const reason of corpus) expect({ reason, js: reasonOk(reason) }).toEqual({ reason, js: bashOk(reason) });
  });
});

describe("G3 hosted fragment and G4 llms.txt renderers", () => {
  const rows = [
    { id: "kya-a", name: "A <b>", summary: "x & y", cli: ["kya a", "--x"], docs: [], plan: "hosted", status: "beta" },
    { id: "kya-f", name: "F", summary: "flagged", cli: [], docs: [], plan: "hosted", status: "flagged" },
    { id: "kya-p", name: "P", summary: "planned", cli: [], docs: ["README.md"], plan: "oss", status: "planned" },
    { id: "kya-o", name: "O", summary: "oss only", cli: ["kya o"], docs: ["README.md"], plan: "oss", status: "stable" },
  ];

  it("G3 lists live hosted rows with their id as anchor, escaped, and no flagged, planned or oss-only row", () => {
    const html = renderHostedFragment(rows);
    expect(html).toContain('<tr id="kya-a">');
    expect(html).toContain("A &lt;b&gt;");
    expect(html).toContain("x &amp; y");
    expect(html).not.toContain("kya-f");
    expect(html).not.toContain("kya-p");
    expect(html).not.toContain("kya-o");
  });

  it("G4 lists live oss and both rows only", () => {
    const txt = renderLlms(rows);
    expect(txt).toContain("- O: oss only Command or flag: `kya o`.");
    expect(txt).not.toContain("A <b>");
    expect(txt).not.toContain("flagged");
    expect(txt).not.toContain("planned");
  });
});
