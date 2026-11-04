#!/usr/bin/env node
// Generated feature lists from sdks/kya/features.json (G1 and G2 of docs/operations/kya-feature-coverage.md).
//
//   node scripts/sync-features.mjs          # write README.md feature block and docs/features.md
//   node scripts/sync-features.mjs --check  # exit 1 when any file is stale (CI: pnpm check:features)
//
// Monorepo only (the ../../web tree exists): also writes G3, the hosted features fragment for the
// public docs page /docs/kya/hosted-commands, and G4, docs/llms.txt (served with the public docs site).
//
// Only rows with plan oss or both, and status stable or beta, are rendered. Rows with status flagged
// (not live) or planned (not published) never reach a generated surface (rule R8). The tests column
// is never rendered: its ../../ paths point into the monorepo and the public mirror ships this file.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const README = "README.md";
export const FEATURES_PAGE = "docs/features.md";
export const START = "<!-- features:start -->";
export const END = "<!-- features:end -->";
export const LLMS = "docs/llms.txt";
/** G3, relative to the package root. Only written when the monorepo web tree is present. */
export const HOSTED_FRAGMENT = "../../web/src/main/resources/templates/marketing/fragments/features.html";
const RENDERED_STATUS = new Set(["stable", "beta"]);

const esc = (s) => s.replace(/\|/g, "\\|");
const cliCell = (row) => (row.cli.length ? row.cli.map((e) => `\`${e}\``).join(", ") : "none");
const rendered = (rows) => rows.filter((r) => (r.plan === "oss" || r.plan === "both") && RENDERED_STATUS.has(r.status));

/** The README block between the markers, without the markers. */
export function renderReadmeBlock(rows) {
  const lines = [
    "Generated from `sdks/kya/features.json` by `pnpm sync:features`. Do not edit by hand. Full list with docs links: [docs/features.md](docs/features.md).",
    "",
    "| Feature | Command or flag | Status |",
    "|---|---|---|",
    ...rendered(rows).map((r) => `| ${esc(r.name)} | ${esc(cliCell(r))} | ${r.status} |`),
  ];
  return lines.join("\n");
}

/** The whole docs/features.md page. Docs links are relative to the page, so they resolve in docs/. */
export function renderFeaturesPage(rows) {
  // Only docs/ pages are served by the docs site, so only they get a link. A row whose docs are only
  // the README shows "README" (the OSS README is not on the docs site).
  const docsCell = (r) => {
    const pages = r.docs.filter((d) => d.startsWith("docs/"));
    return pages.length ? pages.map((p) => `[${p}](${posix.relative("docs", p)})`).join(", ") : "README";
  };
  const lines = [
    "# Features",
    "",
    "Generated from `sdks/kya/features.json` by `pnpm sync:features`. Do not edit by hand.",
    "Rows with status `planned` or `flagged` are not listed (not live).",
    "",
    "| Feature | What it does | Command or flag | Status | Docs |",
    "|---|---|---|---|---|",
    ...rendered(rows).map(
      (r) => `| ${esc(r.name)} | ${esc(r.summary)} | ${esc(cliCell(r))} | ${r.status} | ${docsCell(r)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/**
 * G3: hosted and both rows (status stable or beta) as a Thymeleaf fragment; each row has its id as anchor.
 * No status column: public templates must not print "beta" (PlanDisplayConsistencyTest).
 */
export function renderHostedFragment(rows) {
  const hosted = rows.filter((r) => (r.plan === "hosted" || r.plan === "both") && RENDERED_STATUS.has(r.status));
  const html = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const lines = [
    "<!-- Generated from sdks/kya/features.json by sdks/kya/scripts/sync-features.mjs. Do not edit by hand. -->",
    '<div th:fragment="hostedFeatures" class="feature-list">',
    '<table class="app-table">',
    "<thead><tr><th>Feature</th><th>What it does</th><th>Command or flag</th></tr></thead>",
    "<tbody>",
    ...hosted.map(
      (r) =>
        `<tr id="${html(r.id)}"><td>${html(r.name)}</td><td>${html(r.summary)}</td>` +
        `<td>${r.cli.length ? r.cli.map((e) => `<code>${html(e)}</code>`).join(" ") : "none"}</td>` +
        "</tr>",
    ),
    "</tbody>",
    "</table>",
    "</div>",
    "",
  ];
  return lines.join("\n");
}

/** G4: docs/llms.txt, the OSS features (plan oss or both, status stable or beta) as a plain list. */
export function renderLlms(rows) {
  const lines = [
    "# Shield KYA features",
    "",
    "> Generated from sdks/kya/features.json by `pnpm sync:features`. Do not edit by hand. Lists the live open source",
    "> CLI features. Hosted features: https://shield-agent.com/docs/kya/hosted-commands. Full table with docs links:",
    "> https://docs.shield-agent.com/features.html",
    "",
    "## Features",
    "",
    ...rendered(rows).map(
      (r) => `- ${r.name}: ${r.summary} Command or flag: ${r.cli.length ? r.cli.map((e) => `\`${e}\``).join(", ") : "none"}.`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** Replaces the text between the markers. Returns null when a marker is missing or repeated. */
export function spliceBlock(text, block) {
  const starts = text.split(START).length - 1;
  const ends = text.split(END).length - 1;
  if (starts !== 1 || ends !== 1) return null;
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (b < a) return null;
  return `${text.slice(0, a + START.length)}\n${block}\n${text.slice(b)}`;
}

/** The README text with its generated block removed (the R3 docs check reads prose only). */
export function stripBlock(text) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) return text;
  return text.slice(0, a) + text.slice(b + END.length);
}

/**
 * Computes the expected files for one package root. Returns { files: [{ path, expected, current }], problems }.
 * Missing markers are a problem, not a silent skip.
 */
export function computeSync(pkg) {
  const rows = JSON.parse(readFileSync(join(pkg, "features.json"), "utf8")).features;
  const problems = [];
  const readmePath = join(pkg, README);
  const readme = readFileSync(readmePath, "utf8");
  const spliced = spliceBlock(readme, renderReadmeBlock(rows));
  if (spliced === null) problems.push(`${README}: feature markers ${START} and ${END} must appear once each, in order`);
  const files = [{ path: README, expected: spliced ?? readme, current: readme }];
  const pagePath = join(pkg, FEATURES_PAGE);
  files.push({
    path: FEATURES_PAGE,
    expected: renderFeaturesPage(rows),
    current: existsSync(pagePath) ? readFileSync(pagePath, "utf8") : null,
  });
  const llmsPath = join(pkg, LLMS);
  files.push({ path: LLMS, expected: renderLlms(rows), current: existsSync(llmsPath) ? readFileSync(llmsPath, "utf8") : null });
  if (existsSync(join(pkg, "..", "..", "web"))) {
    const fragPath = join(pkg, HOSTED_FRAGMENT);
    files.push({
      path: HOSTED_FRAGMENT,
      expected: renderHostedFragment(rows),
      current: existsSync(fragPath) ? readFileSync(fragPath, "utf8") : null,
    });
  }
  return { files, problems };
}

function main(argv) {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
  const check = argv.includes("--check");
  if (argv.some((a) => a !== "--check")) {
    console.error("usage: sync-features.mjs [--check]");
    process.exit(2);
  }
  const { files, problems } = computeSync(pkg);
  const stale = [];
  for (const f of files) {
    if (check) {
      if (f.current !== f.expected) stale.push(f.path);
    } else if (f.current !== f.expected) {
      mkdirSync(dirname(join(pkg, f.path)), { recursive: true });
      writeFileSync(join(pkg, f.path), f.expected);
      console.log(`wrote ${relative(process.cwd(), join(pkg, f.path))}`);
    }
  }
  if (problems.length > 0) {
    console.error(`sync features: ${problems.join("; ")}`);
    process.exit(1);
  }
  if (stale.length > 0) {
    console.error(`sync features: stale generated file(s): ${stale.join(", ")}. Run: pnpm sync:features`);
    process.exit(1);
  }
  if (check) console.log("sync features OK: generated feature lists match features.json");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
