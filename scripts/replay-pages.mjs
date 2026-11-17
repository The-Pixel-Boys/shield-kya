#!/usr/bin/env node
// Replay pages (acquisition build B1b). Reads replays/*.yaml, src/ rule labels and docs/hosts/*.md, writes replays/pages/.
//
//   node scripts/replay-pages.mjs                 # write the pages and replays/pages/pages.json
//   node scripts/replay-pages.mjs --check         # exit 1 when a page is stale or an orphan (CI: pnpm check:replay-pages)
//   node scripts/replay-pages.mjs --root <dir>    # package root, default is the folder above scripts/
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES_DIR, generate, stale } from "./lib/replay-pages.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = at >= 0 ? resolve(args[at + 1]) : join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (args.includes("--check")) {
      const bad = stale(root);
      if (bad.length) {
        console.error(`replay pages: stale generated file(s):\n${bad.map((p) => `  ${p}`).join("\n")}\nRun: node scripts/replay-pages.mjs`);
        process.exit(1);
      }
      console.log("replay pages: replays/pages/ is current");
    } else {
      const files = generate(root);
      const dir = join(root, PAGES_DIR);
      mkdirSync(dir, { recursive: true });
      // A page whose replay is gone is removed here, so the next --check finds no orphan.
      if (existsSync(dir)) for (const f of readdirSync(dir)) if (!(`${PAGES_DIR}/${f}` in files)) rmSync(join(dir, f));
      for (const [p, text] of Object.entries(files)) writeFileSync(join(root, p), text);
      console.log(`wrote ${Object.keys(files).length} files in ${PAGES_DIR}/`);
    }
  } catch (err) {
    console.error(`replay pages: ${err.message}`);
    process.exit(1);
  }
}
