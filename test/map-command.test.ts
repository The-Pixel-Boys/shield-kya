/**
 * `kya map` end to end: the real CLI (dist/cli.js) in a temp KYA_HOME and project folder. The fixture rows are
 * shifted so the newest row is one hour old, so the default 3-day window holds all of them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMap } from "../src/map/build.js";
import { ADVISORY_LINE } from "../src/map/page.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const FIXTURE = join(import.meta.dirname, "fixtures", "map", "trail.jsonl");
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

type Row = Record<string, unknown> & { ts: string; sessionId: string };

let root: string;
let home: string;
let cwd: string;

beforeEach(() => {
  // Real path: the project writer refuses a project reached through a symlink (tmpdir is one on macOS).
  root = realpathSync(mkdtempSync(join(tmpdir(), "kya-map-cli-")));
  home = join(root, "home");
  cwd = join(root, "proj");
  mkdirSync(join(home, ".kya"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function kya(args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home, KYA_NO_BROWSER: "1", KYA_UPDATE_CHECK: "0" },
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Fixture rows with timestamps moved so the newest is one hour before now. */
function fixtureRows(): Row[] {
  const rows = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Row);
  const newest = Math.max(...rows.map((r) => Date.parse(r.ts)));
  const delta = Date.now() - 3_600_000 - newest;
  return rows.map((r) => ({ ...r, ts: new Date(Date.parse(r.ts) + delta).toISOString() }));
}

function writeTrail(rows: Array<Row | string>): void {
  writeFileSync(join(home, ".kya", "trail.jsonl"), `${rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`);
}

/** The page body outside the vendored library, which keeps its own licence header. */
function outsideLibrary(html: string): string {
  return html.replace(/<script id="kya-cytoscape">[\s\S]*?<\/script>/, "");
}

function hostileRows(): Row[] {
  const ts = new Date(Date.now() - 60_000).toISOString();
  return [
    { ts, sessionId: "s-hostile", host: 'evil"><svg onload=alert(1)>', product: "claude", project: "</script><script>alert(1)</script>", toolId: "<img src=x onerror=alert(1)>", verdict: "ALLOW", reasonCode: "ALLOW", mode: "offline" },
    { ts, sessionId: "s-hostile", product: "claude", project: "</script><script>alert(1)</script>", toolId: "Bash", targetClass: 'network:evil"><svg onload=alert(1)>', verdict: "DENY", reasonCode: "NEVER_EVENT", mode: "offline" },
  ];
}

describe("kya map (real CLI)", { timeout: 60_000 }, () => {
  it("kya map --json parses, and its node and edge counts match an in-process build of the same rows", () => {
    const rows = fixtureRows();
    writeTrail(rows);
    const r = kya(["map", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { nodes: unknown[]; edges: unknown[]; heat: { when: { days: string[]; cells: number[][] } }; view: { rowsRead: number } };
    const expected = buildMap(rows, { salt: "fixed", now: new Date(), days: 3 });
    expect(j.nodes).toHaveLength(expected.nodes.length);
    expect(j.edges).toHaveLength(expected.edges.length);
    expect(j.nodes.length).toBeGreaterThan(10);
    expect(j.view.rowsRead).toBe(rows.length);
    expect(j.heat.when.days).toHaveLength(7);
    expect(j.heat.when.cells.every((row) => row.length === 24)).toBe(true);
  });

  it("kya map --html FILE writes one page: inline library, both heat tables, advisory line, CSP, no network string outside the library", () => {
    writeTrail(fixtureRows());
    const r = kya(["map", "--html", "out.html"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("html: ");
    const html = readFileSync(join(cwd, "out.html"), "utf8");
    expect(html).toContain('<script id="kya-cytoscape">');
    expect(html).toContain('class="map-heat map-when"');
    expect(html).toContain('class="map-heat map-where"');
    expect(html).toContain(ADVISORY_LINE);
    expect(html).toContain(`content="${CSP}"`);
    expect(outsideLibrary(html)).not.toMatch(/https?:\/\//);
  });

  it("kya map with no flag writes .kya/receipts/map-3d.html in the project and prints its path", () => {
    writeTrail(fixtureRows());
    const r = kya(["map"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("map-3d.html");
    expect(existsSync(join(cwd, ".kya", "receipts", "map-3d.html"))).toBe(true);
  });

  it("kya map --session keeps one session only", () => {
    const rows = fixtureRows();
    writeTrail(rows);
    const sid = rows[0]!.sessionId;
    const mine = rows.filter((x) => x.sessionId === sid).length;
    expect(mine).toBeGreaterThan(0);
    expect(mine).toBeLessThan(rows.length);
    const r = kya(["map", "--json", "--session", sid]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { nodes: Array<{ kind: string; count: number }> };
    expect(j.nodes.filter((n) => n.kind === "device").reduce((s, n) => s + n.count, 0)).toBe(mine);
  });

  it("empty trail (no file): exit 0, 'No events in the last 3 days.' on the page and in the summary", () => {
    const r = kya(["map"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No events in the last 3 days.");
    const html = readFileSync(join(cwd, ".kya", "receipts", "map-3d.html"), "utf8");
    expect(html).toContain("No events in the last 3 days.");
    expect(html).not.toContain('id="kya-map-graph"');
  });

  it("empty trail with --json: stdout is still one valid JSON document, the empty line goes to stderr", () => {
    writeTrail([]);
    const r = kya(["map", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { nodes: unknown[]; edges: unknown[] };
    expect(j.nodes).toEqual([]);
    expect(j.edges).toEqual([]);
    expect(r.err).toContain("No events in the last 3 days.");
  });

  it("a malformed line is skipped and counted, not fatal", () => {
    writeTrail([...fixtureRows().slice(0, 3), "{not json"]);
    const r = kya(["map", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { view: { rowsRead: number; rowsSkipped: number } };
    expect(j.view.rowsSkipped).toBe(1);
  });

  it.each([
    [["map", "--days", "0"]],
    [["map", "--days", "-1"]],
    [["map", "--days", "abc"]],
    [["map", "--days", "3x"]],
    [["map", "--days", "1.5"]],
    [["map", "--days"]],
    [["map", "--html"]],
    [["map", "--session"]],
  ])("bad flag %j is a usage error (exit 2) with the usage tag", (args) => {
    const r = kya(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain("error:");
    expect(r.err).toContain("[USAGE]");
  });

  it("a hostile trail: no raw markup in the page, and the JSON output carries the original strings", () => {
    writeTrail(hostileRows());
    const html = kya(["map", "--html", "evil.html"]);
    expect(html.code).toBe(0);
    const page = readFileSync(join(cwd, "evil.html"), "utf8");
    expect(page).not.toContain("<img src=x onerror=alert(1)>");
    expect(page).not.toContain("</script><script>alert(1)</script>");
    expect(page).not.toContain('evil"><svg onload=alert(1)>');
    const json = kya(["map", "--json"]);
    expect(json.code).toBe(0);
    const j = JSON.parse(json.out) as { nodes: Array<{ label: string; detail?: string }>; heat: unknown };
    expect(j.nodes.map((n) => n.label)).toContain("<img src=x onerror=alert(1)>");
    expect(j.nodes.map((n) => n.label)).toContain("</script><script>alert(1)</script>");
    expect(j.nodes.map((n) => n.label)).toContain('network:evil"><svg onload=alert(1)>');
  });
});
