// Shared by sync-version.mjs (rewrites pins) and check-version-pins.mjs (fails on stale pins).
// Both scan the whole tree instead of trusting a hand-kept file list, so a new file that
// pins the package version is covered the day it is added.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

// Structured version fields. Matched by path SUFFIX during the same tree walk (so a plugin dir
// anywhere under the scanned roots is covered, and an absent file is simply never visited).
// Each pointer is dotted; `name[*]` fans out over an array. Absent fields are skipped.
export const MANIFESTS = [
  { file: ".claude-plugin/marketplace.json", pointers: ["plugins[*].version", "metadata.version"] },
  { file: ".claude-plugin/plugin.json", pointers: ["version"] },
  { file: ".codex-plugin/plugin.json", pointers: ["version"] },
  { file: ".agents/plugins/marketplace.json", pointers: ["plugins[*].version", "metadata.version"] },
  { file: "gemini-extension.json", pointers: ["version"] },
  { file: ".cursor-plugin/plugin.json", pointers: ["version"] },
];

// Optional extra scan roots, relative to the package root. Missing directories are skipped.
export const EXTRA_ROOTS = ["../kya-vscode", "../../integrations"];

/** Text files under `root` plus any extra root that exists. */
export function* walkPinFiles(root) {
  yield* walkTextFiles(root);
  for (const extra of EXTRA_ROOTS) {
    const dir = join(root, extra);
    if (existsSync(dir) && statSync(dir).isDirectory()) yield* walkTextFiles(dir);
  }
}

class Leaf {
  constructor(value, start, end) {
    Object.assign(this, { value, start, end });
  }
}

// JSON parser that remembers where each scalar sits in the text, so sync can edit a version in
// place and leave indent, inline arrays, key order and the trailing newline untouched.
function parseSpans(text) {
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i])) i++;
  };
  const string = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return new Leaf(JSON.parse(text.slice(start, i)), start, i);
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      const isObj = c === "{";
      const out = isObj ? {} : [];
      i++;
      ws();
      if (text[i] === (isObj ? "}" : "]")) return i++, out;
      for (;;) {
        ws();
        let key = out.length;
        if (isObj) {
          key = string().value;
          ws();
          i++; // ':'
        }
        out[key] = value();
        ws();
        if (text[i++] !== ",") return out;
      }
    }
    if (c === '"') return string();
    const start = i;
    while (i < text.length && !/[,\]}\s]/.test(text[i])) i++;
    return new Leaf(JSON.parse(text.slice(start, i)), start, i);
  };
  return value();
}

function* slots(node, segs, label) {
  const m = /^(.+)\[\*\]$/.exec(segs[0]);
  const key = m ? m[1] : segs[0];
  if (node === null || typeof node !== "object" || node instanceof Leaf || !(key in node)) return;
  const next = node[key];
  if (segs.length === 1) {
    if (next instanceof Leaf) yield { label: label + key, leaf: next };
  } else if (m) {
    if (Array.isArray(next)) for (const [i, el] of next.entries()) yield* slots(el, segs.slice(1), `${label}${key}[${i}].`);
  } else {
    yield* slots(next, segs.slice(1), `${label}${key}.`);
  }
}

/** Version fields of a manifest file (matched by `rel` path suffix); [] when `rel` is not one. */
export function manifestVersions(rel, text) {
  const spec = MANIFESTS.find((s) => rel === s.file || rel.endsWith(`/${s.file}`));
  if (!spec) return [];
  let tree;
  try {
    JSON.parse(text);
    tree = parseSpans(text);
  } catch (e) {
    throw new Error(`${rel}: cannot parse manifest (${e.message})`);
  }
  return spec.pointers.flatMap((p) => [...slots(tree, p.split("."), "")]);
}

export const relPosix = (root, file) => relative(root, file).split(sep).join("/");

/** Rewrite every pin and manifest version field under the scan roots; returns changed files (relative). */
export function syncTree(root, version) {
  const changed = [];
  for (const file of walkPinFiles(root)) {
    const before = readText(file);
    let after = before.replace(PIN_RE, `@shield-agent/kya@${version}`);
    const edits = manifestVersions(relPosix(root, file), after)
      .filter((s) => s.leaf.value !== version)
      .sort((a, b) => b.leaf.start - a.leaf.start);
    for (const { leaf } of edits) after = after.slice(0, leaf.start) + JSON.stringify(version) + after.slice(leaf.end);
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(relative(root, file));
    }
  }
  return changed;
}
