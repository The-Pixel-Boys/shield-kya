/**
 * `kya --version`, `-v`, `-V` and `kya version` print the package version
 * from package.json and exit 0, before help, config and the Node handoff.
 * The spawn check runs dist/cli.js - run `pnpm build` first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";

const pkgVersion = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
).version as string;

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    exit: () => {
      /* no-op in tests */
    },
  };
  return { io, logs, errors };
}

describe("runCli version output", () => {
  it.each([["--version"], ["-v"], ["-V"], ["version"]])(
    "%s prints the package version, exit 0, nothing else",
    async (spelling) => {
      const cwd = mkdtempSync(join(tmpdir(), "kya-version-"));
      dirs.push(cwd);
      const { io, logs, errors } = captureIo();
      const code = await runCli([spelling], io, {}, cwd);
      expect(code).toBe(0);
      expect(logs).toEqual([pkgVersion]);
      expect(errors).toEqual([]);
    },
  );

  it("--help still prints help, not the version", async () => {
    const { io, logs } = captureIo();
    const code = await runCli(["--help"], io, {}, process.cwd());
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
    expect(logs.join("\n")).toContain("--version, -v");
    expect(logs).not.toEqual([pkgVersion]);
  });
});

describe("kya --version (built CLI, real process)", () => {
  it("prints exactly the package.json version on stdout and exits 0", () => {
    const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
    expect(existsSync(cliJs), "dist/cli.js missing - run pnpm build first").toBe(true);
    const home = mkdtempSync(join(tmpdir(), "kya-version-e2e-"));
    dirs.push(home);
    const r = spawnSync(process.execPath, [cliJs, "--version"], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      encoding: "utf8",
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${pkgVersion}\n`);
    expect(r.stderr).toBe("");
  });
});
