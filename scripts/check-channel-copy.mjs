#!/usr/bin/env node
// Fails when a distribution channel describes kya differently from channel-copy.json, or when
// a screenshot drifts from sdks/kya/assets.
//
// channel-copy.json is the single source of truth: `short` (tagline), `long` (description),
// `variants` (a channel that is a different product surface, e.g. the MCP gate or the Python
// shim; each still starts with the tagline) and `screenshots` (file, sha256, alt).
//
//   node scripts/check-channel-copy.mjs                # exit 1, one `path: channel: expected X, found Y` per drift
//   node scripts/check-channel-copy.mjs --write        # rewrite every drifted description in place
//   node scripts/check-channel-copy.mjs --require-all  # a missing channel file fails instead of being skipped
//
// Paths are relative to the package root (sdks/kya, or the root of the public mirror). A channel
// whose file is absent is skipped and printed (the public mirror has no ../kya-python, no
// ../../web); a file that exists but lacks the field fails. Screenshots: assets/ is the source of
// truth, `--write` copies it over same-named web/static/img/kya files; a changed or new PNG needs
// its sha256 / alt edited in channel-copy.json by hand (the error prints the sha to paste).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpans, slots } from "./lib/version-pins.mjs";

export const COPY_FILE = "channel-copy.json";
export const WEB_IMG_DIR = "../../web/src/main/resources/static/img/kya";
const WEB_TPL = "../../web/src/main/resources/templates/marketing";
const WINGET_DIR = "packaging/winget/manifests/t/The-Pixel-Boys/ShieldKYA";
const RAW_PREFIX = "https://raw.githubusercontent.com/The-Pixel-Boys/shield-kya/main/";
// MCP registry server.schema.json (2025-10-17): ServerDetail.description maxLength 100.
const SERVER_JSON_MAX = 100;
// Copy must stay truthful: OSS is advisory and fails open (except the never-list), hosted is not GA.
// Applies to every description and to screenshot alt texts.
export const FORBIDDEN =
  /\b(enforce[sd]?|enforcing|enforcement|generally available|general availability|GA|fail[- ]?closed|production[- ]ready|guarantee[sd]?|blocks (?:every|all))\b/i;
// Every image in assets/ must be listed in channel-copy.json `screenshots` with its sha256.
const IMAGE_RE = /\.(png|jpe?g|webp|svg|gif)$/i;
const stem = (f) => f.replace(/\.[^.]+$/, "");

const noPeriod = (s) => s.replace(/[.\s]+$/, "");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// --- field accessors: get(text) -> [{label, value}] ; set(text, label, value) -> text ---

function jsonField(...pointers) {
  const fields = (text) => {
    JSON.parse(text); // throws a readable error on invalid JSON before the span parser runs
    const tree = parseSpans(text);
    return pointers.flatMap((p) => [...slots(tree, p.split("."), "")]);
  };
  // `list[*].key`: an entry WITHOUT the key yields { value: undefined } (slots skips it silently).
  const missing = (text) =>
    pointers.flatMap((p) => {
      const m = /^(\w+)\[\*\]\.(\w+)$/.exec(p);
      const list = m && JSON.parse(text)[m[1]];
      if (!Array.isArray(list)) return [];
      return list.flatMap((el, i) => (el && typeof el === "object" && m[2] in el ? [] : [{ label: `${m[1]}[${i}].${m[2]}`, value: undefined }]));
    });
  return {
    get: (text) => [...fields(text).map(({ label, leaf }) => ({ label, value: leaf.value })), ...missing(text)],
    set: (text, label, value) => {
      const { leaf } = fields(text).find((f) => f.label === label);
      return text.slice(0, leaf.start) + JSON.stringify(value) + text.slice(leaf.end);
    },
  };
}

// One `key = "..."` / `key "..."` style line, first match wins.
function lineField(label, re, render) {
  return {
    get: (text) => {
      const m = re.exec(text);
      return m ? [{ label, value: m[2] }] : [];
    },
    set: (text, _l, value) => text.replace(re, (_all, head) => head + render(value)),
  };
}

// pyproject.toml `description` inside the [project] table only (up to the next `[header]`).
const PROJECT_RE = /^\[project\][ \t]*$/m;
const PY_DESC_RE = /^(description\s*=\s*)("((?:[^"\\]|\\.)*)")/m;
function projectTable(text) {
  const head = PROJECT_RE.exec(text);
  if (!head) return null;
  const start = head.index + head[0].length;
  const next = /^\[/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}
const pyprojectDescription = {
  get: (text) => {
    const t = projectTable(text);
    const m = t && PY_DESC_RE.exec(text.slice(t.start, t.end));
    return m ? [{ label: "[project].description", value: m[2] }] : [];
  },
  set: (text, _l, value) => {
    const t = projectTable(text);
    const body = text.slice(t.start, t.end).replace(PY_DESC_RE, (_a, head) => head + JSON.stringify(value));
    return text.slice(0, t.start) + body + text.slice(t.end);
  },
};

// Winget `Description:` is a scalar or a `|` block. Block lines are kept as lines (indent stripped),
// so a block wrapped over several lines does not equal the one-line copy and `--write` unwraps it.
const WINGET_DESC_RE = /^(Description:)[ \t]*(\|[^\n]*\n((?:[ \t]+[^\n]*\n?)*)|[^\n]*)/m;
const wingetDescription = {
  get: (text) => {
    const m = WINGET_DESC_RE.exec(text);
    if (!m) return [];
    const raw = m[3] !== undefined ? m[3] : m[2];
    return [{ label: "Description", value: raw.split("\n").map((l) => l.trim()).filter(Boolean).join("\n") }];
  },
  // A `|` block match ends after its last newline, a scalar match before it.
  set: (text, _l, value) =>
    text.replace(WINGET_DESC_RE, (_a, _h, _b, block) => `Description: |\n  ${value}${block !== undefined ? "\n" : ""}`),
};

const decodeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const encodeHtml = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Only <meta name="description">: the templates and layouts/public.html carry no OG/twitter tags.
const META_RE = /(<meta\s+name="description"\s+content=")([^"]*)(")/;
const metaDescription = {
  get: (text) => {
    const m = META_RE.exec(text);
    return m ? [{ label: 'meta[name="description"]', value: decodeHtml(m[2]) }] : [];
  },
  set: (text, _l, value) => text.replace(META_RE, (_a, head, _old, tail) => head + encodeHtml(value) + tail),
};

// README lead: the first line that opens with bold. It must START with the long copy, rendered
// as `**<short>** <rest of long>`; whatever follows on that line is free text.
function readmeLead(copy) {
  const md = `**${copy.short}** ${copy.long.slice(copy.short.length).trim()}`;
  const n = copy.long.split(/(?<=\.)\s+/).length; // sentences the long copy spans
  const LEAD_RE = /^\*\*.*$/m;
  const oldPrefixEnd = (line) => {
    const ends = [...line.matchAll(/\.(?:\*\*)?(?=\s|$)/g)];
    return ends.length >= n ? ends[n - 1].index + ends[n - 1][0].length : line.length;
  };
  return {
    get: (text) => {
      const line = LEAD_RE.exec(text)?.[0];
      if (line === undefined) return [];
      return [{ label: "lead paragraph", value: line.startsWith(md) ? md : line.slice(0, oldPrefixEnd(line)) }];
    },
    set: (text, _l, _v) => text.replace(LEAD_RE, (line) => md + line.slice(oldPrefixEnd(line))),
    expect: () => md,
  };
}

function newestWingetLocale(root) {
  const dir = join(root, WINGET_DIR);
  if (!existsSync(dir)) return `${WINGET_DIR}/<newest>/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`;
  const num = (v) => v.split(".").map(Number);
  const versions = readdirSync(dir)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => num(a).map((x, i) => x - num(b)[i]).find((d) => d !== 0) ?? 0);
  if (versions.length === 0) throw new Error(`${WINGET_DIR}: no x.y.z version directory`);
  return `${WINGET_DIR}/${versions.at(-1)}/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`;
}

/** Every repo-local channel: [{ path, channel, key, field, norm? }]. key names the copy in channel-copy.json. */
export function channels(root, copy) {
  const winget = newestWingetLocale(root);
  return [
    { path: "package.json", channel: "npm", key: "long", field: jsonField("description") },
    { path: "manifest.json", channel: "Claude Desktop extension", key: "variants.mcp", field: jsonField("description") },
    { path: "server.json", channel: "MCP registry", key: "variants.mcp", field: jsonField("description"), max: SERVER_JSON_MAX },
    { path: ".claude-plugin/marketplace.json", channel: "Claude marketplace", key: "variants.plugin", field: jsonField("description") },
    { path: ".claude-plugin/marketplace.json", channel: "Claude marketplace plugin", key: "variants.plugin", field: jsonField("plugins[*].description"), many: true },
    { path: "plugins/kya/.claude-plugin/plugin.json", channel: "Claude Code plugin", key: "variants.plugin", field: jsonField("description") },
    { path: "plugins/kya/.codex-plugin/plugin.json", channel: "Codex plugin", key: "variants.plugin", field: jsonField("description") },
    { path: "gemini-extension.json", channel: "Gemini CLI extension", key: "variants.plugin", field: jsonField("description") },
    { path: ".cursor-plugin/plugin.json", channel: "Cursor plugin", key: "long", field: jsonField("description") },
    // Monorepo copy of the Python shim. PyPI publishes from the public repo's own kya-python/, which is
    // public-only (mirror excludes): that copy is a hand-paste channel, see packaging/README.md.
    { path: "../kya-python/pyproject.toml", channel: "kya-python pyproject (monorepo copy, not the PyPI source)", key: "variants.python", field: pyprojectDescription },
    { path: "packaging/homebrew/shield-kya.rb", channel: "Homebrew", key: "short", norm: noPeriod, brew: true, field: lineField("desc", /^(\s*desc\s+)("((?:[^"\\]|\\.)*)")/m, (v) => JSON.stringify(noPeriod(v))) },
    { path: "packaging/scoop/shield-kya.json", channel: "Scoop", key: "long", field: jsonField("description") },
    { path: winget, channel: "winget ShortDescription", key: "short", norm: noPeriod, field: lineField("ShortDescription", /^(ShortDescription:[ \t]*)(.*)$/m, (v) => noPeriod(v)) },
    { path: winget, channel: "winget Description", key: "long", field: wingetDescription },
    { path: "README.md", channel: "README", key: "long", field: readmeLead(copy) },
    { path: `${WEB_TPL}/install.html`, channel: "web /install", key: "variants.webInstall", field: metaDescription },
    { path: `${WEB_TPL}/how-kya-works.html`, channel: "web /how-kya-works", key: "variants.webHowKyaWorks", field: metaDescription },
  ];
}

// The pyproject/brew line regexes capture the quoted string in group 2; unquote it for comparison.
function unquote(v) {
  return /^".*"$/s.test(v) ? JSON.parse(v) : v;
}

const lookup = (copy, key) => key.split(".").reduce((o, k) => o?.[k], copy);

/** Problems with channel-copy.json itself (truthfulness, tagline prefix, registry limits). */
export function validateCopy(copy) {
  const problems = [];
  if (!copy.short || !copy.short.endsWith(".")) problems.push(`${COPY_FILE}: short must be a sentence ending in "."`);
  const all = { short: copy.short, long: copy.long, ...Object.fromEntries(Object.entries(copy.variants ?? {}).map(([k, v]) => [`variants.${k}`, v])) };
  for (const [key, text] of Object.entries(all)) {
    if (typeof text !== "string" || !text.trim()) problems.push(`${COPY_FILE}: ${key} is empty`);
    else {
      if (!text.startsWith(noPeriod(copy.short ?? ""))) problems.push(`${COPY_FILE}: ${key} must start with the tagline "${copy.short}"`);
      if (FORBIDDEN.test(text)) problems.push(`${COPY_FILE}: ${key} claims enforcement or GA ("${FORBIDDEN.exec(text)[0]}"); OSS is advisory and fails open`);
      if (/[\u2013\u2014]/.test(text)) problems.push(`${COPY_FILE}: ${key} contains a long dash`);
    }
  }
  for (const s of copy.screenshots ?? []) {
    if (typeof s.alt === "string" && FORBIDDEN.test(s.alt)) {
      problems.push(`${COPY_FILE}: screenshots ${s.file} alt claims enforcement or GA ("${FORBIDDEN.exec(s.alt)[0]}")`);
    }
  }
  return problems;
}

function checkScreenshots(root, copy, write, skipped, uncovered) {
  const problems = [];
  const assets = join(root, "assets");
  const listed = new Map((copy.screenshots ?? []).map((s) => [s.file, s]));
  const images = existsSync(assets) ? readdirSync(assets).filter((f) => IMAGE_RE.test(f)) : [];
  for (const f of images) {
    const actual = sha256(join(assets, f));
    const entry = listed.get(`assets/${f}`);
    if (!entry) problems.push(`assets/${f}: screenshots: expected a ${COPY_FILE} entry, found none (sha256 ${actual}, add it with an alt text)`);
    else {
      if (entry.sha256 !== actual) problems.push(`assets/${f}: screenshots: expected sha256 ${entry.sha256}, found ${actual} (update ${COPY_FILE})`);
      if (!entry.alt?.trim()) problems.push(`assets/${f}: screenshots: expected alt text, found none`);
    }
  }
  for (const file of listed.keys()) {
    if (!existsSync(join(root, file))) problems.push(`${file}: screenshots: expected file, found none (listed in ${COPY_FILE})`);
  }

  const web = join(root, WEB_IMG_DIR);
  if (!existsSync(web)) skipped.push(WEB_IMG_DIR);
  else if (existsSync(assets)) {
    // Same file name: bytes must match (assets wins on --write). Same stem, other format (e.g.
    // activity-receipt.jpg vs .png) or no asset counterpart: reported as not covered, not failed,
    // because a re-encoded copy cannot be byte-compared.
    const assetFiles = new Set(images);
    const assetStems = new Map(images.map((f) => [stem(f), f]));
    for (const f of readdirSync(web).filter((n) => IMAGE_RE.test(n) && !assetFiles.has(n))) {
      const twin = assetStems.get(stem(f));
      uncovered.push(`${WEB_IMG_DIR}/${f}` + (twin ? ` (same name as assets/${twin}, different format: not byte-checked)` : " (no assets/ counterpart)"));
    }
    const webFiles = new Set(readdirSync(web));
    for (const f of images.filter((n) => webFiles.has(n))) {
      const want = sha256(join(assets, f));
      const got = sha256(join(web, f));
      if (want === got) continue;
      if (write) copyFileSync(join(assets, f), join(web, f));
      else problems.push(`${WEB_IMG_DIR}/${f}: web screenshot: expected sha256 ${want} (assets/${f}), found ${got}`);
    }
  }

  const readme = join(root, "README.md");
  if (existsSync(readme)) {
    const text = readFileSync(readme, "utf8");
    const refs = [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g), ...text.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      const local = ref.startsWith(RAW_PREFIX) ? ref.slice(RAW_PREFIX.length) : /^[a-z]+:/i.test(ref) ? null : ref.replace(/^\.\//, "");
      if (local === null) continue;
      const rel = relative(resolve(root), resolve(root, local));
      if (rel === ".." || rel.startsWith(`..${sep}`)) {
        problems.push(`README.md: image: expected a path inside the package, found ${ref} (it 404s in the public mirror)`);
      } else if (!existsSync(join(root, local))) problems.push(`README.md: image: expected ${local} to exist, found none (${ref})`);
    }
  }
  return problems;
}

/** Returns { problems, skipped, written, uncovered }. `write` repairs every description and web screenshot drift it can. */
export function checkChannelCopy(root, { write = false, requireAll = false } = {}) {
  const copy = JSON.parse(readFileSync(join(root, COPY_FILE), "utf8"));
  const problems = validateCopy(copy);
  const skipped = [];
  const written = new Set();
  const uncovered = [];

  for (const ch of channels(root, copy)) {
    const abs = join(root, ch.path);
    if (!existsSync(abs)) {
      skipped.push(ch.path);
      continue;
    }
    const want = lookup(copy, ch.key);
    if (typeof want !== "string") {
      problems.push(`${ch.path}: ${ch.channel}: ${COPY_FILE} has no ${ch.key}`);
      continue;
    }
    const norm = ch.norm ?? ((s) => s);
    const shown = ch.field.expect?.() ?? norm(want);
    if (ch.max && want.length > ch.max) problems.push(`${COPY_FILE}: ${ch.key} is ${want.length} chars, ${ch.channel} allows ${ch.max}`);
    if (ch.brew) {
      if (shown.length > 80) problems.push(`${COPY_FILE}: ${ch.key} is ${shown.length} chars, brew audit allows 80`);
      if (/^(a|an|the)\b/i.test(shown)) problems.push(`${COPY_FILE}: ${ch.key} starts with an article, brew audit rejects that`);
    }
    let text = readFileSync(abs, "utf8");
    const fields = ch.field.get(text);
    if (fields.length === 0) {
      problems.push(`${ch.path}: ${ch.channel}: expected ${JSON.stringify(shown)}, found no description field`);
      continue;
    }
    for (const { label, value } of fields) {
      if (value === undefined) {
        problems.push(`${ch.path}: ${ch.channel} (${label}): expected ${JSON.stringify(shown)}, found no description field`);
        continue;
      }
      const found = norm(unquote(value));
      if (found === shown) continue;
      if (write) {
        text = ch.field.set(text, label, want);
        written.add(ch.path);
      } else {
        const where = ch.many ? `${ch.channel} (${label})` : ch.channel;
        problems.push(`${ch.path}: ${where}: expected ${JSON.stringify(shown)}, found ${JSON.stringify(found)}`);
      }
    }
    if (write && written.has(ch.path)) writeFileSync(abs, text);
  }

  problems.push(...checkScreenshots(root, copy, write, skipped, uncovered));
  if (requireAll) for (const s of skipped) problems.push(`${s}: expected file, found none (--require-all)`);
  return { problems, skipped, written: [...written], uncovered };
}

// Same symlink-safe self-detection as check-version-pins.mjs: a string compare could skip the
// check and exit 0.
if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const write = args.has("--write");
  const root = join(import.meta.dirname, "..");
  let result = checkChannelCopy(root, { write, requireAll: args.has("--require-all") });
  for (const s of new Set(result.skipped)) console.log(`skipped (absent): ${s}`);
  for (const u of result.uncovered) console.log(`not covered: ${u}`);
  if (write) {
    for (const f of result.written) console.log(`rewrote ${f}`);
    result = checkChannelCopy(root, { requireAll: args.has("--require-all") });
  }
  if (result.problems.length > 0) {
    console.error(`channel copy drift: ${result.problems.length} problem(s)\n  ${result.problems.join("\n  ")}`);
    console.error(`\nFix: edit ${COPY_FILE} if the copy should change, then run \`pnpm sync:channel-copy\`.`);
    process.exit(1);
  }
  console.log("channel copy OK");
}
