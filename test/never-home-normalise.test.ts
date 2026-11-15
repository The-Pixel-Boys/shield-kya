/**
 * Bug fix: the never-list home check missed when HOME holds `//` or `/./` (HOME=/data//u, HOME=/data/./u).
 * `rm -rf $HOME`, `rm -rf ~` and `rm -rf <clean path>` must all be denied. Real-stack e2e: the built CLI
 * (`kya hook`, needs `pnpm build`) and the guard bundle, both in a temp HOME and a temp KYA_HOME, never the real home.
 * Home dirs sit outside /home and /Users on purpose: those two prefixes are caught by a separate pattern.
 * A bad payload still fails open.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_DEFAULTS, guardContextFrom, guardPackMatch } from "../src/guard-pack.js";

const PKG = join(import.meta.dirname, "..");
const CLI = join(PKG, "dist", "cli.js");
const BUNDLE = join(PKG, "plugins", "kya-guard", "dist", "guard.mjs");
const posix = process.platform !== "win32";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A temp tree `<base>/data/u` and the same HOME spelled three ways. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kya-home-norm-")));
  dirs.push(base);
  mkdirSync(join(base, "data", "u"), { recursive: true });
  mkdirSync(join(base, "proj", ".git"), { recursive: true });
  const clean = `${base}/data/u`;
  return { clean, proj: join(base, "proj"), spellings: { clean, dslash: `${base}//data//u`, dot: `${base}/data/./u`, trailing: `${base}/data/u/` } };
}

const payload = (cwd: string, command: string): string =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "home-norm", cwd, tool_name: "Bash", tool_input: { command }, tool_use_id: "tu-1" });

function run(kind: "cli" | "bundle", home: string, cwd: string, stdin: string) {
  const args = kind === "cli" ? [CLI, "hook", "--host", "claude"] : [BUNDLE, "--host", "claude"];
  const r = spawnSync(process.execPath, args, {
    cwd, input: stdin, encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home, KYA_OFFLINE: "1", KYA_NO_BROWSER: "1" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!posix).each(["cli", "bundle"] as const)("never-list home normalisation (%s)", (kind) => {
  for (const spelling of ["dslash", "dot", "trailing"] as const) {
    for (const target of ["$HOME", "${HOME}", "~", "CLEAN"]) {
      it(`denies rm -rf ${target} when HOME has ${spelling}`, () => {
        const fx = fixture();
        const home = fx.spellings[spelling];
        const t = target === "CLEAN" ? fx.clean : target;
        const r = run(kind, home, fx.proj, payload(fx.proj, `rm -rf ${t}`));
        expect(r.code, r.err + r.out).toBe(2);
        expect(r.err + r.out).toMatch(/rm-(root-home|recursive-home-or-system)/);
      });
    }
  }

  it("still allows a harmless command with an odd HOME", () => {
    const fx = fixture();
    const r = run(kind, fx.spellings.dslash, fx.proj, payload(fx.proj, "echo hi"));
    expect(r.code, r.err).toBe(0);
  });

  it("allows rm -rf of a project subfolder with an odd HOME", () => {
    const fx = fixture();
    const r = run(kind, fx.spellings.dot, fx.proj, payload(fx.proj, "rm -rf ./build"));
    expect(r.code, r.err).toBe(0);
  });

  it("fails open on a bad payload", () => {
    const fx = fixture();
    const r = run(kind, fx.spellings.dslash, fx.proj, "{not json");
    expect(r.code, r.err).toBe(0);
  });
});

describe("project root normalisation (cwd with // or /./)", () => {
  for (const cwd of ["/work//app", "/work/./app", "//work/app", "/work/app/"]) {
    it(`asks on rm -rf . when cwd is ${cwd}`, () => {
      const ctx = guardContextFrom(cwd, { HOME: "/data/u" });
      expect(guardPackMatch("Bash", { command: "rm -rf ." }, ctx, GUARD_DEFAULTS)?.rule).toBe("rm-project-wipe");
    });
  }

  it("denies rm -rf of the parent of cwd when cwd has a leading //", () => {
    const ctx = guardContextFrom("//work/app", { HOME: "/data/u" });
    expect(guardPackMatch("Bash", { command: "rm -rf -- /work" }, ctx, GUARD_DEFAULTS)?.rule).toMatch(/rm-/);
  });

  it("still allows rm -rf ./dist", () => {
    const ctx = guardContextFrom("/work//app", { HOME: "/data/u" });
    expect(guardPackMatch("Bash", { command: "rm -rf ./dist" }, ctx, GUARD_DEFAULTS)).toBeUndefined();
  });
});
