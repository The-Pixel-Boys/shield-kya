// Shared by sync-version.mjs (rewrites pins) and check-version-pins.mjs (fails on stale pins).
// Both scan the whole tree instead of trusting a hand-kept file list, so a new file that
// pins the package version is covered the day it is added.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Matches an exact-version pin of this package, e.g. `@shield-agent/kya@1.2.3` or `...@1.2.3-beta.1`. */
export const PIN_RE = /@shield-agent\/kya@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;

// Build output, vendored code and history never carry live pins. `scripts` and anything
// named *version-pins* talk ABOUT pins (examples, fixtures) and are not pins themselves.
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".kya", "_baseline", "kya-python", "scripts"]);
const SKIP_FILES = /^(CHANGELOG.*|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|version-pins/;
const TEXT_EXT = /\.(md|json|toml|ya?ml|txt|mjs|cjs|js|ts|rb|sh|ps1)$|^Dockerfile$/;

/** Every text file under `root` that could carry a live version pin. */
export function* walkTextFiles(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walkTextFiles(path);
    } else if (!SKIP_FILES.test(name) && TEXT_EXT.test(name)) {
      yield path;
    }
  }
}

export const readText = (path) => readFileSync(path, "utf8");
