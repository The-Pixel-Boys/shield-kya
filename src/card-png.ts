/**
 * PNG for the near-miss card, with no new dependency: a renderer that is already on the machine.
 * `rsvg-convert` first, then a headless Chrome or Chromium. No renderer: SVG only, and the caller says so.
 * Not imported by the kya-guard bundle (it starts a process); only `kya receipt --card` and the report action use it.
 * The renderer gets the card file and nothing else; it makes no network call (file URL, fresh profile folder).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { CARD_HEIGHT, CARD_WIDTH } from "./card.js";

const RENDER_TIMEOUT_MS = 30_000;

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
];

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const d of (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (d && existsSync(join(d, name))) return join(d, name);
  }
  return undefined;
}

/** Render `svgPath` to `pngPath` (1200 x 630). The renderer name on success, undefined when none is available or it failed. */
export function renderCardPng(svgPath: string, pngPath: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.KYA_CARD_PNG === "0") return undefined;
  // Chrome can exit non-zero after it wrote the screenshot (odd HOME, no display service), so the file decides, not the exit code.
  const run = (cmd: string, args: string[]): boolean => {
    rmSync(pngPath, { force: true });
    spawnSync(cmd, args, { stdio: "ignore", timeout: RENDER_TIMEOUT_MS, killSignal: "SIGKILL", env });
    return existsSync(pngPath) && statSync(pngPath).size > 0;
  };
  const rsvg = onPath("rsvg-convert", env);
  if (rsvg && run(rsvg, ["-w", String(CARD_WIDTH), "-h", String(CARD_HEIGHT), "-o", pngPath, svgPath])) return "rsvg-convert";
  const chrome = env.KYA_CHROME?.trim() || CHROME_PATHS.find((p) => existsSync(p)) || onPath("google-chrome", env) || onPath("chromium", env);
  if (!chrome) return undefined;
  const profile = mkdtempSync(join(tmpdir(), "kya-card-"));
  try {
    const ok = run(chrome, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--hide-scrollbars",
      `--user-data-dir=${profile}`, `--window-size=${CARD_WIDTH},${CARD_HEIGHT}`, `--screenshot=${pngPath}`, pathToFileURL(svgPath).href,
    ]);
    return ok ? "headless Chrome" : undefined;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
