/**
 * Feature kya-near-miss-card (spec item G5), real stack: the built CLI (`dist/cli.js`, run `pnpm build` first) and the real
 * kya-guard bundle, both in a temp HOME and a temp KYA_HOME (never the real home). The PocketOS replay goes through the
 * hook, then `kya receipt --card` and `guard.mjs --card` (the /kya-guard:share command) make the card.
 * Paths: happy, --id, no deny, approved ask (no card), unknown id, privacy markers in every input, the offer in status,
 * no offer in the deny text, the report control. The live /action/card checks are in near-miss-card.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventIdOf, cardLines } from "../src/card.js";
import type { TrailEvent } from "../src/trail.js";
// @ts-expect-error plain .mjs script, no type declarations
import { loadReplays } from "../scripts/lib/replays.mjs";

const PKG = join(import.meta.dirname, "..");
const BUNDLE = join(PKG, "plugins", "kya-guard", "dist", "guard.mjs");
const CLI = join(PKG, "dist", "cli.js");
const posix = process.platform !== "win32";
const POCKETOS = (loadReplays(join(PKG, "replays")) as { id: string; input: { command: string } }[]).find((r) => r.id === "2026-04-pocketos-railway-volume")!;

/** Strings that must never reach a card: a command word, a path, a project name, a session id. */
const MARKS = { cmd: "CMDMARK_91f3", path: "PATHMARK_52ab", proj: "PROJMARK_77cd", sess: "SESSMARK_08ef" };
const FOUR = (rule: string, label: string, host: string, date: string): string[] => [
  `My coding agent tried to ${label}.`, "KYA Guard stopped it.", `Rule ${rule} | ${host} | ${date}`, "Install: npx @shield-agent/kya@latest start",
];

interface Fx { readonly base: string; readonly home: string; readonly proj: string }
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(): Fx {
  const base = mkdtempSync(join(tmpdir(), "kya-card-e2e-"));
  dirs.push(base);
  const home = join(base, "home");
  const proj = join(base, `proj-${MARKS.proj}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(join(proj, ".git"), { recursive: true });
  return { base, home, proj };
}
/** KYA_CARD_PNG=0 skips the PNG (a headless Chrome start takes seconds); only the first CLI test renders it. */
const env = (fx: Fx, png = false): NodeJS.ProcessEnv => ({
  ...(png ? {} : { KYA_CARD_PNG: "0" }), PATH: process.env.PATH ?? "", HOME: fx.home, KYA_HOME: fx.home, KYA_NO_BROWSER: "1", KYA_SKIP_NODE_CHECK: "1", KYA_OFFLINE: "1", KYA_TELEMETRY: "0", KYA_SEMANTIC: "off", KYA_ALERTS: "off", DO_NOT_TRACK: "1",
});
const run = (bin: string, args: string[], fx: Fx, input?: string, png = false) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: fx.proj, encoding: "utf8", timeout: 60_000, env: env(fx, png), ...(input !== undefined ? { input } : {}) });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const payload = (fx: Fx, command: string): string =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: MARKS.sess, cwd: fx.proj, tool_name: "Bash", tool_input: { command: `${command} # ${MARKS.cmd} ${fx.home}/${MARKS.path}` } });
const hook = (fx: Fx, command: string) => run(CLI, ["hook", "--host", "claude"], fx, payload(fx, command));
const trail = (fx: Fx): TrailEvent[] => readFileSync(join(fx.home, ".kya", "trail.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TrailEvent);
const cardFiles = (fx: Fx, ext: string): string[] => (existsSync(join(fx.home, ".kya", "cards")) ? readdirSync(join(fx.home, ".kya", "cards")).filter((f) => f.endsWith(ext)) : []);
const decode = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const visible = (svg: string): string[] => [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()));
const today = (): string => new Date().toISOString().slice(0, 10);
const noMarks = (label: string, ...texts: (string | Buffer)[]): void => {
  for (const t of texts) for (const m of Object.values(MARKS)) expect(Buffer.isBuffer(t) ? t.includes(m) : t.includes(m), `${label}: ${m}`).toBe(false);
};

describe.skipIf(!posix || !existsSync(CLI))("kya-near-miss-card e2e: kya receipt --card (built CLI)", { timeout: 90_000 }, () => {
  it("after the PocketOS replay, --card writes an SVG whose text is the four lines, and prints the path and a two-line caption", () => {
    const fx = fixture();
    const h = hook(fx, POCKETOS.input.command);
    expect(h.code, h.err).toBe(2);
    const r = run(CLI, ["receipt", "--card"], fx, undefined, true);
    expect(r.code, r.err).toBe(0);
    const svgs = cardFiles(fx, ".svg");
    expect(svgs).toHaveLength(1);
    const svgPath = join(fx.home, ".kya", "cards", svgs[0]!);
    const svg = readFileSync(svgPath, "utf8");
    expect(visible(svg)).toEqual(FOUR("railway-volume-delete", "delete a cloud volume", "Claude Code", today()));
    expect(svg).toMatch(/width="1200" height="630"/);
    expect(svg).toContain("<title");
    expect(svg).toContain("<desc");
    expect(r.out).toContain(`SVG: ${svgPath}`);
    const caption = r.out.split("Caption to paste:\n")[1]!.trimEnd().split("\n");
    expect(caption).toEqual([
      "My coding agent tried to delete a cloud volume. KYA Guard stopped it.",
      "Rule railway-volume-delete. Local, no network, one file: npx @shield-agent/kya@latest start",
    ]);
    // Privacy: the markers were in the command, a path, the project folder and the session id. None is in the card, the PNG or the output.
    noMarks("svg", svg);
    noMarks("stdout", r.out);
    for (const png of cardFiles(fx, ".png")) {
      const b = readFileSync(join(fx.home, ".kya", "cards", png));
      expect(b.subarray(1, 4).toString()).toBe("PNG");
      expect(b.readUInt32BE(16)).toBe(1200);
      expect(b.readUInt32BE(20)).toBe(630);
      noMarks("png", b);
    }
    if (cardFiles(fx, ".png").length === 0) expect(r.out).toMatch(/PNG: not made\. No renderer found/);
    // --card adds the cards folder and changes nothing in the trail: it still has the one row the hook wrote.
    expect(readdirSync(join(fx.home, ".kya"))).toContain("cards");
    expect(trail(fx)).toHaveLength(1);
  });

  it("--id picks another denied call; the default is the newest one", () => {
    const fx = fixture();
    hook(fx, POCKETOS.input.command);
    hook(fx, "terraform destroy");
    const rows = trail(fx);
    const [first] = rows;
    const newest = rows.at(-1)!;
    const byId = run(CLI, ["receipt", "--card", "--id", eventIdOf(first!)], fx);
    expect(byId.code, byId.err).toBe(0);
    expect(byId.out).toContain(`call ${eventIdOf(first!)}`);
    expect(byId.out).toContain("delete a cloud volume");
    const dflt = run(CLI, ["receipt", "--card"], fx);
    expect(dflt.out).toContain(`call ${eventIdOf(newest)}`);
    expect(dflt.out).toContain("destroy your infrastructure");
    expect(cardFiles(fx, ".svg")).toHaveLength(2);
  });

  it("with no denied call it says so, exits 1 and writes no card", () => {
    const fx = fixture();
    const empty = run(CLI, ["receipt", "--card"], fx);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("has not stopped a call yet");
    expect(cardFiles(fx, ".svg")).toEqual([]);
    hook(fx, "ls -la");
    expect(run(CLI, ["receipt", "--card"], fx).code).toBe(1);
    expect(cardFiles(fx, ".svg")).toEqual([]);
  });

  it("an ask (outcome held) is not a near miss: no card, and --id of it is refused", () => {
    const fx = fixture();
    const h = hook(fx, "npx prisma migrate reset");
    expect(h.code, h.err).toBe(0);
    expect(trail(fx)[0]).toMatchObject({ outcome: "held", neverRule: "prisma-migrate-reset" });
    const r = run(CLI, ["receipt", "--card"], fx);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/an approved ask is not a near miss/);
    const byId = run(CLI, ["receipt", "--card", "--id", eventIdOf(trail(fx)[0]!)], fx);
    expect(byId.code).toBe(1);
    expect(byId.err).toMatch(/was not denied/);
    expect(cardFiles(fx, ".svg")).toEqual([]);
  });

  it("an unknown id is refused and lists the recent stopped calls", () => {
    const fx = fixture();
    hook(fx, POCKETOS.input.command);
    const r = run(CLI, ["receipt", "--card", "--id", "deadbeef"], fx);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No call with id deadbeef");
    expect(r.err).toContain("railway-volume-delete");
    expect(cardFiles(fx, ".svg")).toEqual([]);
  });

  it("--json prints the id, both paths and the caption", () => {
    const fx = fixture();
    hook(fx, POCKETOS.input.command);
    const r = run(CLI, ["receipt", "--card", "--json"], fx);
    const j = JSON.parse(r.out) as { id: string; svg: string; png: string | null; caption: string };
    expect(j.id).toBe(eventIdOf(trail(fx)[0]!));
    expect(existsSync(j.svg)).toBe(true);
    expect(j.caption.split("\n")).toHaveLength(2);
  });

  it("the static report puts the CLI command next to the stopped row, with the id the command accepts", () => {
    const fx = fixture();
    hook(fx, POCKETOS.input.command);
    hook(fx, "npx prisma migrate reset");
    hook(fx, "ls -la");
    expect(run(CLI, ["receipt"], fx).code).toBe(0);
    const html = readFileSync(join(fx.proj, ".kya", "receipts", "last-3d.html"), "utf8");
    const [deny, ask, ran] = trail(fx);
    expect(html).toContain(`kya receipt --card --id ${eventIdOf(deny!)}`);
    expect(html).not.toContain(eventIdOf(ask!));
    expect(html).not.toContain(eventIdOf(ran!));
    expect(run(CLI, ["receipt", "--card", "--id", eventIdOf(deny!)], fx).code).toBe(0);
  });
});

describe.skipIf(!posix)("kya-near-miss-card e2e: /kya-guard:share and /kya-guard:status (the real bundle)", { timeout: 60_000 }, () => {
  const guard = (fx: Fx, args: string[], input?: string) => run(BUNDLE, args, fx, input);
  const gpayload = (fx: Fx, command: string): string => payload(fx, command);

  it("share.md runs the bundle with --card, as status.md runs it with --status", () => {
    const md = readFileSync(join(PKG, "plugins", "kya-guard", "commands", "share.md"), "utf8");
    expect(md).toContain('node "${CLAUDE_PLUGIN_ROOT}/dist/guard.mjs" --card');
    expect(md).toMatch(/disable-model-invocation: true/);
    expect(md).toContain("Show the text above to the user exactly as it is. Add nothing.");
  });

  it("after the PocketOS replay, --card makes the card from the bundle (SVG only), with the four lines and no marker", () => {
    const fx = fixture();
    expect(guard(fx, ["--host", "claude"], gpayload(fx, POCKETOS.input.command)).code).toBe(2);
    const r = guard(fx, ["--card"]);
    expect(r.code, r.err).toBe(0);
    const [svgName, ...rest] = cardFiles(fx, ".svg");
    expect(rest).toEqual([]);
    const svg = readFileSync(join(fx.home, ".kya", "cards", svgName!), "utf8");
    expect(visible(svg)).toEqual(FOUR("railway-volume-delete", "delete a cloud volume", "Claude Code", today()));
    noMarks("svg", svg);
    noMarks("stdout", r.out);
    expect(r.out).toContain("PNG: not made. This plugin makes the SVG only.");
    expect(r.out.split("Caption to paste:\n")[1]!.trimEnd().split("\n")).toHaveLength(2);
    expect(cardFiles(fx, ".png")).toEqual([]);
    expect(readdirSync(join(fx.home, ".kya")).sort()).toEqual(["cards", "trail.jsonl"]);
  });

  it("--card --id works, no denied call gives a clear message (exit 0, no file), an approved ask gives no card", () => {
    const fx = fixture();
    expect(guard(fx, ["--card"]).out).toContain("has not stopped a call yet");
    guard(fx, ["--host", "claude"], gpayload(fx, "npx prisma migrate reset"));
    const ask = guard(fx, ["--card"]);
    expect(ask.code).toBe(0);
    expect(ask.out).toMatch(/an approved ask is not a near miss/);
    expect(cardFiles(fx, ".svg")).toEqual([]);
    guard(fx, ["--host", "claude"], gpayload(fx, POCKETOS.input.command));
    guard(fx, ["--host", "claude"], gpayload(fx, "terraform destroy"));
    const rows = trail(fx).filter((e) => e.outcome === "blocked");
    const byId = guard(fx, ["--card", "--id", eventIdOf(rows[0]!)]);
    expect(byId.out).toContain("delete a cloud volume");
    expect(guard(fx, ["--card", "--id", "nope"]).out).toContain("No call with id nope");
    expect(cardFiles(fx, ".svg")).toHaveLength(1);
  });

  it("status uses the label in the last-stopped list and offers /kya-guard:share when a deny is under 7 days old", () => {
    const fx = fixture();
    guard(fx, ["--host", "claude"], gpayload(fx, POCKETOS.input.command));
    const s = guard(fx, ["--status"]);
    expect(s.out).toContain("Last 1 stopped: delete a cloud volume [railway-volume-delete] (");
    expect(s.out).toContain("/kya-guard:share");
    const lines = s.out.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("Full report: npx @shield-agent/kya receipt --open");
    expect(s.out.match(/npx @shield-agent\/kya/g)).toHaveLength(1);
  });

  it("status makes no offer with an empty trail, with only an ask, or with a deny older than 7 days", () => {
    const fx = fixture();
    expect(guard(fx, ["--status"]).out).not.toContain("/kya-guard:share");
    guard(fx, ["--host", "claude"], gpayload(fx, "npx prisma migrate reset"));
    expect(guard(fx, ["--status"]).out).not.toContain("/kya-guard:share");
    const old = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();
    writeFileSync(join(fx.home, ".kya", "trail.jsonl"), `${JSON.stringify({ ts: old, sessionId: "s", toolId: "Bash", verdict: "DENY", outcome: "blocked", reasonCode: "NEVER_SHELL", mode: "offline", neverRule: "terraform-destroy" })}\n`);
    expect(guard(fx, ["--status"]).out).not.toContain("/kya-guard:share");
  });

  it("the deny and ask text the agent reads never mentions a card or sharing", () => {
    const fx = fixture();
    const deny = guard(fx, ["--host", "claude"], gpayload(fx, POCKETOS.input.command));
    const ask = guard(fx, ["--host", "claude"], gpayload(fx, "npx prisma migrate reset"));
    for (const t of [deny.out + deny.err, ask.out + ask.err]) expect(t).not.toMatch(/card|share|post/i);
  });

  it("every host's copy of the bundle is the same file and answers --card", () => {
    const fx = fixture();
    guard(fx, ["--host", "claude"], gpayload(fx, POCKETOS.input.command));
    const bytes = readFileSync(BUNDLE);
    for (const d of ["kya-guard-cursor", "kya-guard-copilot", "kya-guard-gemini"]) {
      const copy = join(PKG, "plugins", d, "dist", "guard.mjs");
      expect(readFileSync(copy).equals(bytes), d).toBe(true);
      expect(run(copy, ["--card"], fx).out).toContain("My coding agent tried to delete a cloud volume.");
    }
  });
});

describe("kya-near-miss-card e2e: the card text matches the lines the builder promises", () => {
  it("cardLines is the single source of the visible text and the alt text", () => {
    expect(cardLines({ ruleId: "r", label: "l", host: "h", date: "d" })[0]).toBe("My coding agent tried to l.");
  });
});
