#!/usr/bin/env node
// Incident Replay scoreboard (spec G3). Reads replays/*.yaml, writes replays/scoreboard.json and docs/replays.md.
//
//   node scripts/replays-scoreboard.mjs                 # write both files
//   node scripts/replays-scoreboard.mjs --check         # exit 1 when a file is stale (CI: pnpm check:replays)
//   node scripts/replays-scoreboard.mjs --root <dir>    # package root, default is the folder above scripts/
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildScoreboard, loadReplays, renderPage } from "./lib/replays.mjs";

export const JSON_FILE = "replays/scoreboard.json";
export const PAGE_FILE = "docs/replays.md";

/** The two generated files as { path: text }. Throws when a replay file is not valid. */
export function generate(root) {
  const board = buildScoreboard(loadReplays(join(root, "replays")));
  return { [JSON_FILE]: `${JSON.stringify(board, null, 2)}\n`, [PAGE_FILE]: renderPage(board) };
}

/** Paths whose file on disk differs from the generated text. */
export function stale(root) {
  return Object.entries(generate(root)).filter(([p, text]) => !existsSync(join(root, p)) || readFileSync(join(root, p), "utf8") !== text).map(([p]) => p);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = at >= 0 ? resolve(args[at + 1]) : join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (args.includes("--check")) {
      const bad = stale(root);
      if (bad.length) {
        console.error(`replays: stale generated file(s): ${bad.join(", ")}. Run: node scripts/replays-scoreboard.mjs`);
        process.exit(1);
      }
      console.log("replays: scoreboard.json and docs/replays.md are current");
    } else {
      for (const [p, text] of Object.entries(generate(root))) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), text);
        console.log(`wrote ${p}`);
      }
    }
  } catch (err) {
    console.error(`replays: ${err.message}`);
    process.exit(1);
  }
}
