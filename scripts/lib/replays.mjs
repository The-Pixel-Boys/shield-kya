// Incident Replay files (replays/*.yaml): parser, validator and scoreboard renderer.
// Shared by scripts/replays-scoreboard.mjs and test/replays.test.ts. No dependencies.
//
// Replay files use a small YAML subset, so the package needs no YAML parser:
//   key: value          plain, "double quoted" or 'single quoted' scalar; ` # comment` ends a plain scalar
//   key: >-             folded block, the more indented lines below are joined with one space
//   key:                a list (`- item` lines) or a one-level mapping (`  key: value` lines)
//   key: []             empty list
// true and false become booleans. Every other value stays a string. Anything else is an error.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["incident", "class", "control"];
export const OUTCOMES = ["deny", "ask", "allow"];
/** Public page that explains each gap. A gap row links here until the owner opens a real issue. */
export const GAP_ANCHOR = "https://github.com/The-Pixel-Boys/shield-kya/blob/main/docs/replays.md#gap-tracking";

const KEYS = new Set(["id", "kind", "title", "date", "sources", "reconstructed", "host", "tool", "input", "expect", "rule", "since", "credit", "status", "issue", "target"]);
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
const HTTPS = /^https:\/\/[^\s]+$/;
/** A GitHub handle without the @: letters, digits and single dashes inside, up to 39 characters. */
export const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function scalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) return JSON.parse(v);
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Error(`bad single-quoted scalar: ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  const plain = v.replace(/\s+#.*$/, "");
  if (plain === "true") return true;
  if (plain === "false") return false;
  return plain;
}

/** Parse one replay file. Throws on anything outside the subset. */
export function parseReplay(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = {};
  let i = 0;
  const indentOf = (l) => l.length - l.trimStart().length;
  const skippable = (l) => l.trim() === "" || l.trimStart().startsWith("#");
  /** Lines under a key that are more indented than the key (blank lines kept for blocks). */
  const children = () => {
    const body = [];
    while (i < lines.length && (lines[i].trim() === "" || indentOf(lines[i]) > 0)) body.push(lines[i++]);
    while (body.length && body[body.length - 1].trim() === "") body.pop();
    return body;
  };
  const folded = (body) => body.map((l) => l.trim()).filter(Boolean).join(" ");
  while (i < lines.length) {
    const line = lines[i++];
    if (skippable(line)) continue;
    if (indentOf(line) !== 0) throw new Error(`unexpected indent: ${line}`);
    const m = /^([A-Za-z_][\w-]*):(?: (.*))?$/.exec(line);
    if (!m) throw new Error(`cannot parse line: ${line}`);
    const [, key, rest = ""] = m;
    if (key in out) throw new Error(`duplicate key: ${key}`);
    const value = rest.trim();
    if (value === ">-") out[key] = folded(children());
    else if (value === "[]") out[key] = [];
    else if (value === "" || value.startsWith("#")) {
      const body = children().filter((l) => !skippable(l));
      if (body.length === 0) out[key] = "";
      else if (body.every((l) => l.trimStart().startsWith("- "))) out[key] = body.map((l) => scalar(l.trimStart().slice(2)));
      else {
        const map = {};
        for (let j = 0; j < body.length; j++) {
          const km = /^\s+([A-Za-z_][\w-]*):(?: (.*))?$/.exec(body[j]);
          if (!km) throw new Error(`cannot parse line under ${key}: ${body[j]}`);
          const [, k2, r2 = ""] = km;
          if (k2 in map) throw new Error(`duplicate key: ${key}.${k2}`);
          if (r2.trim() === ">-") {
            const block = [];
            const keyIndent = indentOf(body[j]);
            while (j + 1 < body.length && indentOf(body[j + 1]) > keyIndent) block.push(body[++j]);
            map[k2] = folded(block);
          } else map[k2] = scalar(r2);
        }
        out[key] = map;
      }
    } else out[key] = scalar(value);
  }
  return out;
}

/** Problems with one parsed replay, as strings. Empty list means valid. `file` is the base name. */
export function validateReplay(r, file) {
  const e = [];
  const need = (k) => { if (r[k] === undefined || r[k] === "") e.push(`missing ${k}`); };
  for (const k of Object.keys(r)) if (!KEYS.has(k)) e.push(`unknown key ${k}`);
  for (const k of ["id", "kind", "title", "date", "host", "tool", "input", "expect"]) need(k);
  if (r.id !== undefined && !KEBAB.test(r.id)) e.push("id must be lower-case words joined by dashes");
  if (r.id !== undefined && `${r.id}.yaml` !== file) e.push(`id must equal the file name (${file})`);
  if (r.kind !== undefined && !KINDS.includes(r.kind)) e.push(`kind must be one of ${KINDS.join(", ")}`);
  if (r.expect !== undefined && !OUTCOMES.includes(r.expect)) e.push(`expect must be one of ${OUTCOMES.join(", ")}`);
  if (r.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) e.push("date must be YYYY-MM-DD");
  if (r.input !== undefined && (typeof r.input !== "object" || Array.isArray(r.input) || Object.keys(r.input).length === 0)) e.push("input must be a mapping with at least one field");
  if (r.reconstructed !== undefined && typeof r.reconstructed !== "boolean") e.push("reconstructed must be true or false");
  const sources = r.sources ?? [];
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== "string" || !HTTPS.test(s))) e.push("sources must be a list of https links");
  if (r.kind === "incident" && (!Array.isArray(sources) || sources.length === 0)) e.push("an incident needs at least one source link");
  if (r.kind !== "incident" && r.reconstructed === true) e.push("only an incident can be reconstructed");
  if (r.credit !== undefined && r.credit !== "" && !HANDLE.test(r.credit)) e.push("credit must be a GitHub handle without the @, or empty");
  if (JSON.stringify(r).includes("TODO")) e.push("a TODO placeholder is left in the file (pnpm new-rule writes them: replace each one)");
  const gap = r.status === "gap";
  if (r.status !== undefined && !gap) e.push("status can only be gap");
  if (r.kind === "control" && (r.expect !== "allow" || gap)) e.push("a control must expect allow and cannot be a gap");
  if (r.rule !== undefined && r.rule !== "" && !KEBAB.test(r.rule)) e.push("rule must be a rule id");
  if (gap) {
    if (r.expect !== "allow") e.push("a gap must expect allow (today's behaviour)");
    if (!r.rule) e.push("a gap names the planned rule id in rule");
    if (!OUTCOMES.slice(0, 2).includes(r.target)) e.push("a gap needs target deny or ask");
    if (typeof r.issue !== "string" || !HTTPS.test(r.issue)) e.push("a gap needs an issue link");
    if (r.since) e.push("a gap has no since version");
  } else {
    if (r.target !== undefined) e.push("target is only for a gap");
    if (r.issue !== undefined) e.push("issue is only for a gap");
    if (r.expect === "allow" && r.rule) e.push("an allow replay has no rule");
    if (r.expect !== "allow" && !r.rule) e.push("deny and ask replays need a rule id");
    if (r.expect !== "allow" && !/^\d+\.\d+\.\d+$/.test(r.since ?? "")) e.push("deny and ask replays need since (the version that first stopped it)");
    if (r.expect === "allow" && r.since) e.push("an allow replay has no since version");
  }
  return e;
}

/** All replays in a folder, sorted by id. Throws one error that lists every problem found. */
export function loadReplays(dir) {
  const problems = [];
  const replays = [];
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort() : [];
  if (files.length === 0) problems.push(`no replay files in ${dir}`);
  const ids = new Set();
  for (const f of files) {
    try {
      const r = parseReplay(readFileSync(join(dir, f), "utf8"));
      const errs = validateReplay(r, f);
      if (ids.has(r.id)) errs.push("duplicate id");
      ids.add(r.id);
      for (const m of errs) problems.push(`${f}: ${m}`);
      if (errs.length === 0) replays.push(r);
    } catch (err) {
      problems.push(`${f}: ${err.message}`);
    }
  }
  if (problems.length) throw new Error(`replay files are not valid:\n${problems.join("\n")}`);
  return replays;
}

const KIND_ORDER = { incident: 0, class: 1, control: 2 };
const resultOf = (r) => (r.status === "gap" ? "not-stopped-yet" : r.expect === "deny" ? "stopped" : r.expect === "ask" ? "asks" : "passed");

/** Scoreboard data. The vitest runner proves each recorded result, so no hook runs here. */
export function buildScoreboard(replays) {
  const rows = replays
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      date: r.date,
      sources: r.sources ?? [],
      reconstructed: r.reconstructed === true,
      result: resultOf(r),
      rule: r.status === "gap" ? "" : r.rule ?? "",
      plannedRule: r.status === "gap" ? r.rule : "",
      since: r.status === "gap" ? "" : r.since ?? "",
      credit: r.credit ?? "",
      issue: r.issue ?? "",
    }))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.kind === "incident" ? b.date.localeCompare(a.date) : 0) || a.id.localeCompare(b.id));
  const totals = {};
  for (const kind of KINDS) {
    const of = rows.filter((x) => x.kind === kind);
    const good = of.filter((x) => x.result === "stopped" || x.result === "asks" || x.result === "passed").length;
    totals[kind] = { listed: of.length, [kind === "control" ? "passed" : "stopped"]: good, gaps: of.length - good };
  }
  return { totals, replays: rows };
}

const RESULT_TEXT = { stopped: "Stopped", asks: "Held (asks the user)", "not-stopped-yet": "Not stopped yet", passed: "Passed" };
const cell = (s) => String(s).replace(/\|/g, "\\|");

/** The whole docs/replays.md page. */
export function renderPage(board) {
  const t = board.totals;
  const table = (kind) => {
    const rows = board.replays.filter((x) => x.kind === kind);
    const lines = ["| Case | Date | Source | Result | Rule | Version | Credit |", "|---|---|---|---|---|---|---|"];
    for (const x of rows) {
      const notes = [x.reconstructed ? "_Reconstructed from the public account_" : ""].filter(Boolean);
      const name = [cell(x.title), ...notes].join("<br>");
      const src = x.sources.length ? x.sources.map((u, i) => `[${i + 1}](${u})`).join(" ") : "none";
      const rule = x.rule ? `\`${x.rule}\`` : x.plannedRule ? `planned: \`${x.plannedRule}\`` : "none";
      const credit = x.credit ? `[@${x.credit}](https://github.com/${x.credit})` : "-";
      lines.push(`| ${name} | ${x.date} | ${src} | ${RESULT_TEXT[x.result]} | ${rule} | ${x.since || "-"} | ${credit} |`);
    }
    return lines.join("\n");
  };
  const gaps = board.replays.filter((x) => x.result === "not-stopped-yet");
  return [
    "# Incident Replay scoreboard",
    "",
    "Generated from the files in [`replays/`](../replays) by `pnpm sync:replays`. Do not edit by hand.",
    "",
    "The same data is shown at [shield-agent.com/replays](https://shield-agent.com/replays), and the README badge \"incidents stopped\" reads it.",
    "",
    "Each file rebuilds one dangerous tool call and records whether KYA stops it. The test `test/replays.test.ts` runs every file through the real hook, so the table is a test result and not a claim. A miss stays on the page as \"Not stopped yet\" until a rule closes it.",
    "",
    `- Incidents stopped: **${t.incident.stopped} of ${t.incident.listed}**`,
    `- Classes stopped: **${t.class.stopped} of ${t.class.listed}**`,
    `- Controls passed: **${t.control.passed} of ${t.control.listed}**`,
    "",
    "A class is a destructive command type with no single incident behind it. A control is an everyday command that must pass, so a false positive shows here too. A result of \"Held\" means the guard asks the user and does not deny.",
    "",
    "## Incidents",
    "",
    table("incident"),
    "",
    "Where a row says \"Reconstructed from the public account\", the public reports did not publish the exact call. The call in the file is a rebuild and uses placeholder tokens and hosts only.",
    "",
    "## Classes",
    "",
    table("class"),
    "",
    "## Gap tracking",
    "",
    "Every row with \"Not stopped yet\" has a planned rule id. Each gap points to this section until a public issue is opened for it.",
    "",
    ...(gaps.length ? gaps.map((x) => `- \`${x.plannedRule}\`: ${x.title}`) : ["There is no open gap."]),
    "",
    "## Controls",
    "",
    `${t.control.listed} everyday commands (for example \`npm test\`, \`git status\`, \`prisma migrate dev\`) are in the [\`replays/\`](../replays) folder as files named \`control-*.yaml\`. Their results are in [\`replays/scoreboard.json\`](../replays/scoreboard.json).`,
    "",
    "## Add a replay",
    "",
    "1. Copy a file in `replays/` and change the fields. The file name must be the `id` plus `.yaml`.",
    "2. Use placeholder tokens and hosts. The test rejects a file that holds a real secret shape.",
    "3. An incident needs at least one source link that opens. Set `reconstructed: true` when the exact call was not published.",
    "4. Put your GitHub handle (no @) in `credit`. The scoreboard shows it in the Credit column and links it to your profile. Leave it empty for no credit.",
    "5. Run `pnpm test -- replays` and `pnpm sync:replays`. Commit the files that change.",
    "",
    "To add a whole guard rule (rule, tests and replay file together), run `pnpm new-rule <id>`. See [CONTRIBUTING.md](../CONTRIBUTING.md#add-a-rule).",
    "",
  ].join("\n");
}
