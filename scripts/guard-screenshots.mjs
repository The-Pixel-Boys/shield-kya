#!/usr/bin/env node
/**
 * Captures for the kya-guard submission pack (plugins/kya-guard/submission/screenshots).
 *   node scripts/guard-screenshots.mjs           write the text captures and render the PNGs with headless Chrome
 *   node scripts/guard-screenshots.mjs --check   fail when a committed text capture differs from a fresh run
 *                                                (timestamps are masked), without touching the files
 * The text is the real output of plugins/kya-guard/dist/guard.mjs in a temporary HOME. Nothing is invented.
 * The PNG is that text drawn in a terminal-like page; it needs Chrome (CHROME=/path, or the macOS default path).
 * No Chrome: the text captures are still written and the PNGs are left as they are.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadReplays } from "./lib/replays.mjs";

const PKG = join(fileURLToPath(import.meta.url), "..", "..");
const BUNDLE = join(PKG, "plugins", "kya-guard", "dist", "guard.mjs");
export const SHOTS = join(PKG, "plugins", "kya-guard", "submission", "screenshots");
const COLS = 100;

const mask = (text) => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/g, "<date> UTC");
export { mask };

function guardRun(home, project, host, command) {
  const stdin = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "shots", cwd: project, tool_name: "Bash", tool_input: { command } });
  const r = spawnSync(process.execPath, [BUNDLE, "--host", host], {
    cwd: project, input: stdin, encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home },
  });
  return { code: r.status, err: r.stderr.trim() };
}

/** The two text captures, from real runs in a temporary HOME. */
export function capture() {
  const base = mkdtempSync(join(tmpdir(), "kya-guard-shots-"));
  try {
    const home = join(base, "home");
    const project = join(base, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    const deny = guardRun(home, project, "claude", "terraform destroy -auto-approve");
    const text1 = [
      "agent tool call   Bash: terraform destroy -auto-approve",
      "KYA Guard         denied before it ran (exit code 2)",
      "message to agent:",
      deny.err,
    ].join("\n");
    guardRun(home, project, "claude", "git push --force origin main");
    guardRun(home, project, "claude", "ls -la");
    guardRun(home, project, "claude", "npm test");
    const status = spawnSync(process.execPath, [BUNDLE, "--status"], {
      cwd: project, encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home },
    });
    const text2 = `> /kya-guard:status\n${status.stdout.trim()}`;
    return { "01-deny": text1, "02-status": text2 };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * The near-miss card (G5, screenshot 3): the PocketOS replay goes through the bundle in a temporary HOME, then
 * `guard.mjs --card` writes the SVG. Returns the SVG text. The date is the day of the run.
 */
export function captureCard() {
  const replay = loadReplays(join(PKG, "replays")).find((r) => r.id === "2026-04-pocketos-railway-volume");
  const base = mkdtempSync(join(tmpdir(), "kya-guard-card-"));
  try {
    const home = join(base, "home");
    const project = join(base, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    guardRun(home, project, "claude", replay.input.command);
    const r = spawnSync(process.execPath, [BUNDLE, "--card"], {
      cwd: project, encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH ?? "", HOME: home, KYA_HOME: home },
    });
    const file = /^SVG: (.+)$/m.exec(r.stdout)?.[1];
    if (!file) throw new Error(`no card made: ${r.stdout}${r.stderr}`);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
const maskDate = (svg) => svg.replace(/\d{4}-\d\d-\d\d/g, "<date>");
export { maskDate };

function renderCardPng(svg) {
  const chrome = chromePath();
  if (!chrome) return false;
  const dir = mkdtempSync(join(tmpdir(), "kya-guard-chrome-"));
  try {
    const file = join(dir, "card.svg");
    writeFileSync(file, svg);
    const out = join(SHOTS, "03-card.png");
    const r = spawnSync(chrome, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--user-data-dir=${join(dir, "profile")}`,
      "--window-size=1200,630", `--screenshot=${out}`, pathToFileURL(file).href,
    ], { timeout: 60_000, stdio: "ignore" });
    return r.status === 0 && existsSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const wrap = (text) => text.split("\n").flatMap((l) => (l.length <= COLS ? [l] : l.match(new RegExp(`.{1,${COLS}}(\\s|$)|\\S+`, "g")).map((x) => x.trimEnd())));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function html(text, title) {
  const lines = wrap(text);
  return { lines: lines.length, page: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#0d1117}
.w{width:880px;padding:20px 28px 24px;box-sizing:border-box;font:15px/22px ui-monospace,Menlo,Consolas,monospace;color:#e6edf3}
.t{color:#8b949e;margin-bottom:14px;font-size:13px}
pre{margin:0;white-space:pre-wrap;word-break:break-word}
</style><div class="w"><div class="t">${esc(title)}</div><pre>${esc(lines.join("\n"))}</pre></div>` };
}

function chromePath() {
  const c = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(c) ? c : undefined;
}

function render(name, text, title) {
  const chrome = chromePath();
  if (!chrome) return false;
  const { lines, page } = html(text, title);
  const dir = mkdtempSync(join(tmpdir(), "kya-guard-chrome-"));
  try {
    const file = join(dir, "page.html");
    writeFileSync(file, page);
    const out = join(SHOTS, `${name}.png`);
    const r = spawnSync(chrome, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--user-data-dir=${join(dir, "profile")}`,
      `--window-size=880,${lines * 22 + 90}`, `--screenshot=${out}`, pathToFileURL(file).href,
    ], { timeout: 60_000, stdio: "ignore" });
    return r.status === 0 && existsSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const shots = capture();
  if (process.argv.includes("--check")) {
    let bad = 0;
    for (const [name, text] of Object.entries(shots)) {
      const file = join(SHOTS, `${name}.txt`);
      const have = existsSync(file) ? mask(readFileSync(file, "utf8").trimEnd()) : "";
      if (have !== mask(text)) { console.error(`${name}.txt differs from a fresh run. Run: node scripts/guard-screenshots.mjs`); bad++; }
    }
    const cardFile = join(SHOTS, "03-card.svg");
    if (!existsSync(cardFile) || maskDate(readFileSync(cardFile, "utf8")) !== maskDate(captureCard())) { console.error("03-card.svg differs from a fresh run. Run: node scripts/guard-screenshots.mjs"); bad++; }
    process.exit(bad ? 1 : 0);
  }
  mkdirSync(SHOTS, { recursive: true });
  const titles = { "01-deny": "KYA Guard: a deny", "02-status": "KYA Guard: /kya-guard:status" };
  for (const [name, text] of Object.entries(shots)) {
    writeFileSync(join(SHOTS, `${name}.txt`), `${text}\n`);
    console.log(`${name}.txt written; png ${render(name, text, titles[name]) ? "rendered" : "NOT rendered (no Chrome)"}`);
  }
  const card = captureCard();
  writeFileSync(join(SHOTS, "03-card.svg"), card);
  console.log(`03-card.svg written; png ${renderCardPng(card) ? "rendered" : "NOT rendered (no Chrome)"}`);
}
