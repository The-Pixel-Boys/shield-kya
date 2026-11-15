/**
 * Feature kya-help-surface, acceptance line 3: every example command in the 0.34.0 help text still exits
 * as it did. The 0.34.0 help is test/fixtures/help-0.34.0.txt. The exit codes of its examples, taken from the
 * built CLI on main before the help change, are test/fixtures/help-examples-exit.json.
 *
 * Real-stack e2e: the built dist/cli.js (run `pnpm build` first). Each example runs in its own temp HOME,
 * KYA_HOME and project, so nothing touches the real home. A report daemon that `kya start --yes` leaves is
 * stopped in a finally block. Set KYA_WRITE_EXIT_FIXTURE=1 to rewrite the exit-code fixture (only on 0.34.0 code).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const cliJs = join(root, "dist", "cli.js");
const fixtureDir = join(root, "test", "fixtures");
const posix = process.platform !== "win32";

/** Example lines of the 0.34.0 help: the indented lines after "Examples:" that start with kya or npx. */
export function exampleLines(helpText: string): string[] {
  const body = helpText.slice(helpText.indexOf("\nExamples:\n") + "\nExamples:\n".length);
  const lines = body.split("\n");
  const end = lines.findIndex((l) => l.trim() === "");
  return lines.slice(0, end < 0 ? undefined : end).map((l) => l.trim()).filter((l) => /^(kya|npx @shield-agent\/kya)\b/.test(l));
}

/** Split an example into argv after the program name. Handles double quotes only (all the help needs). */
export function argvOf(example: string): string[] {
  const rest = example.replace(/^npx @shield-agent\/kya\b/, "").replace(/^kya\b/, "").trim();
  return [...rest.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function runExample(argv: string[]): Run {
  const base = mkdtempSync(join(tmpdir(), "kya-ex-"));
  const home = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(proj, ".git"));
  mkdirSync(join(home, ".claude"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    KYA_HOME: home,
    TMPDIR: base,
    KYA_NO_BROWSER: "1",
    KYA_SKIP_NODE_CHECK: "1",
    KYA_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    KYA_UPDATE_CHECK: "0",
    KYA_SEMANTIC: "off",
    KYA_ALERTS: "off",
    KYA_BASE_URL: "http://127.0.0.1:1",
  };
  try {
    const r = spawnSync(process.execPath, [cliJs, ...argv], { cwd: proj, env, encoding: "utf8", timeout: 60_000, input: "" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    // `kya start --yes` leaves a report daemon: stop it before the directory goes.
    spawnSync(process.execPath, [cliJs, "stop"], { cwd: proj, env, encoding: "utf8", timeout: 30_000, input: "" });
    rmSync(base, { recursive: true, force: true });
  }
}

const golden = readFileSync(join(fixtureDir, "help-0.34.0.txt"), "utf8");
const examples = exampleLines(golden);

describe.skipIf(!posix)("help examples still run as in 0.34.0 (real CLI, temp HOME)", () => {
  it("the fixture has the 34 example lines of 0.34.0", () => {
    expect(examples).toHaveLength(34);
  });

  it(
    "every example exits as before and is not an unknown command",
    { timeout: 600_000 },
    () => {
      const result: Record<string, number | null> = {};
      for (const ex of examples) {
        const r = runExample(argvOf(ex));
        expect(`${r.out}${r.err}`, ex).not.toContain("Unknown command");
        result[ex] = r.code;
      }
      const fixturePath = join(fixtureDir, "help-examples-exit.json");
      if (process.env.KYA_WRITE_EXIT_FIXTURE === "1") {
        writeFileSync(fixturePath, `${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, number | null>;
      expect(result).toEqual(expected);
    },
  );
});
