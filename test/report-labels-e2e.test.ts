/**
 * Feature kya-receipt: the report counts calls by what happened (Ran, Blocked, Held, Never) from the very first
 * report. An empty trail must not fall back to the old Allow, Deny and Review labels.
 * Real-stack e2e: the built dist/cli.js (run `pnpm build` first) against a temp HOME, a temp KYA_HOME and a temp
 * project. Never touches the real home.
 *
 * Commands as written: kya receipt.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const posix = process.platform !== "win32";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** HOME and KYA_HOME are one temp dir; the project is a second temp dir. */
function fixture(): { home: string; proj: string } {
  const base = mkdtempSync(join(tmpdir(), "kya-labels-"));
  dirs.push(base);
  const home = join(base, "home");
  const proj = join(base, "proj");
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(join(home, ".kya"), { recursive: true });
  return { home, proj };
}

function report(fx: { home: string; proj: string }): { md: string; html: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fx.home, KYA_HOME: fx.home, KYA_NO_BROWSER: "1", KYA_OFFLINE: "1", KYA_TELEMETRY: "0", KYA_ALERTS: "off", DO_NOT_TRACK: "1" };
  for (const k of ["CI", "KYA_API_KEY", "SHIELD_API_KEY", "KYA_BASE_URL"]) delete env[k];
  const r = spawnSync(process.execPath, [cliJs, "receipt"], { cwd: fx.proj, encoding: "utf8", timeout: 60_000, env });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  const dir = join(fx.proj, ".kya", "receipts");
  return { md: readFileSync(join(dir, "last-3d.md"), "utf8"), html: readFileSync(join(dir, "last-3d.html"), "utf8") };
}

/** The Decisions card and the Activity counts bar: the two places that count calls by outcome. */
function countLabels(html: string): string {
  const card = html.match(/<section class="panel" aria-label="Verdicts">[\s\S]*?<\/section>/)?.[0] ?? "";
  const bar = html.match(/<button type="button" class="stat[^>]*data-fgroup="(?:outcome|verdict)"[\s\S]*?id="clear-filters"/)?.[0] ?? "";
  expect(card, "Decisions card").not.toBe("");
  expect(bar, "Activity counts bar").not.toBe("");
  return `${card}\n${bar}`;
}

describe.skipIf(!posix)("report labels: current labels from the first report (real CLI, temp HOME and KYA_HOME)", () => {
  it("an empty trail shows Ran, Blocked, Held and Never with zeros, never Allow, Deny or Review", () => {
    const { html, md } = report(fixture());
    const labels = countLabels(html);
    for (const l of ["Ran", "Blocked", "Held", "Never"]) expect(labels).toMatch(new RegExp(`>${l}(<b>|</span>)`));
    for (const l of ["Allow", "Deny", "Review"]) expect(labels).not.toMatch(new RegExp(`>${l}(<b>|</span>)`));
    expect(md).toContain("Ran 0, Blocked 0, Held 0 | Never 0");
    expect(md).not.toMatch(/Allow \d+ \| Deny \d+ \| Review \d+/);
  });

  it("old trail rows with no outcome keep their verdict, labelled Earlier, under the current labels", () => {
    const fx = fixture();
    const ts = new Date(Date.now() - 60_000).toISOString();
    const row = { ts, sessionId: "old", toolId: "Read", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" };
    appendFileSync(join(fx.home, ".kya", "trail.jsonl"), `${JSON.stringify(row)}\n`);
    const { html, md } = report(fx);
    const labels = countLabels(html);
    expect(labels).toContain("Ran");
    expect(labels).toContain("Earlier: Allow");
    expect(labels).not.toMatch(/>Allow(<b>|<\/span>)/);
    expect(md).toContain("Ran 0, Blocked 0, Held 0 | Never 0");
    expect(md).toContain("Earlier calls (no outcome recorded): Allow 1 | Deny 0 | Review 0");
  });
});
