/**
 * Channel copy + screenshot parity guard (scripts/check-channel-copy.mjs). channel-copy.json is
 * the single source of truth for every distribution channel's description; assets/ is the source
 * of truth for screenshots. Each test builds a throwaway monorepo-shaped tree:
 * <tmp>/sdks/kya (package root), <tmp>/sdks/kya-python, <tmp>/web.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { channels, checkChannelCopy, COPY_FILE, validateCopy } from "../scripts/check-channel-copy.mjs";
import { existsSync } from "node:fs";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WINGET = "packaging/winget/manifests/t/The-Pixel-Boys/ShieldKYA";
const WEB_TPL = "../../web/src/main/resources/templates/marketing";
const WEB_IMG = "../../web/src/main/resources/static/img/kya";

const COPY = {
  short: "Tagline for agents.",
  long: "Tagline for agents. Long story here.",
  variants: {
    mcp: "Tagline for agents. Gate surface.",
    plugin: "Tagline for agents. Plugin surface, advisory.",
    python: "Tagline for agents. Python shim.",
    webInstall: "Tagline for agents. Install & go.",
    webHowKyaWorks: "Tagline for agents. How it works.",
  },
};
const PNG_A = Buffer.from("png-a");
const PNG_B = Buffer.from("png-b");
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const LOGO = { file: "assets/logo.svg", sha256: sha(Buffer.from("<svg/>")), alt: "Logo" };

let repo: string;
let dir: string;

function put(rel: string, body: string | Buffer): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}
const read = (rel: string): string => readFileSync(join(dir, rel), "utf8");
const edit = (rel: string, from: string, to: string): void => {
  const before = read(rel);
  expect(before).toContain(from);
  put(rel, before.replace(from, to));
};

function fixture(): void {
  put(
    "channel-copy.json",
    JSON.stringify({ ...COPY, screenshots: [{ file: "assets/shot.png", sha256: sha(PNG_A), alt: "A shot" }, LOGO] }, null, 2),
  );
  put("package.json", JSON.stringify({ name: "x", description: COPY.long }, null, 2));
  put("manifest.json", JSON.stringify({ description: COPY.variants.mcp, long_description: "free text" }, null, 2));
  put("server.json", JSON.stringify({ description: COPY.variants.mcp }, null, 2));
  put(
    ".claude-plugin/marketplace.json",
    `{\n\t"description": ${JSON.stringify(COPY.variants.plugin)},\n\t"plugins": [\n\t\t{ "name": "a", "description": ${JSON.stringify(COPY.variants.plugin)} },\n\t\t{ "name": "b", "description": ${JSON.stringify(COPY.variants.plugin)} }\n\t]\n}`,
  );
  put("plugins/kya/.claude-plugin/plugin.json", JSON.stringify({ description: COPY.variants.plugin }));
  put(".cursor-plugin/plugin.json", JSON.stringify({ description: COPY.long }));
  put("../kya-python/pyproject.toml", `[project]\nname = "x"\ndescription = ${JSON.stringify(COPY.variants.python)}\n`);
  put("packaging/homebrew/shield-kya.rb", `class ShieldKya < Formula\n  desc "Tagline for agents"\n  homepage "h"\nend\n`);
  put("packaging/scoop/shield-kya.json", JSON.stringify({ version: "1.0.0", description: COPY.long }, null, 4));
  // 0.10.0 is newest (numeric sort); a stale 0.9.0 dir must be ignored.
  put(`${WINGET}/0.9.0/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`, "ShortDescription: stale\nDescription: stale\n");
  put(
    `${WINGET}/0.10.0/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`,
    `PackageName: x\nShortDescription: Tagline for agents\nDescription: |\n  Tagline for agents. Long story here.\nMoniker: x\n`,
  );
  put(
    "README.md",
    `# x\n\n[![b](https://img.shields.io/x.svg)](y)\n\n**Tagline for agents.** Long story here. Free text after.\n\n![s](https://raw.githubusercontent.com/The-Pixel-Boys/shield-kya/main/assets/shot.png)\n`,
  );
  put(`${WEB_TPL}/install.html`, `<head>\n<meta name="description"\n      content="Tagline for agents. Install &amp; go."/>\n</head>\n`);
  put(`${WEB_TPL}/how-kya-works.html`, `<head><meta name="description" content="Tagline for agents. How it works."/></head>\n`);
  put("assets/shot.png", PNG_A);
  put("assets/logo.svg", "<svg/>");
  put(`${WEB_IMG}/shot.png`, PNG_A);
  put(`${WEB_IMG}/web-only.jpg`, "jpg");
}

const problems = (opts = {}): string[] => checkChannelCopy(dir, opts).problems;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kya-copy-"));
  dir = join(repo, "sdks", "kya");
  fixture();
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// [channel file, text to replace, label the problem must name]
const DRIFT: Array<[string, string, string]> = [
  ["package.json", COPY.long, "package.json: npm:"],
  ["manifest.json", COPY.variants.mcp, "manifest.json: Claude Desktop extension:"],
  ["server.json", COPY.variants.mcp, "server.json: MCP registry:"],
  // First occurrence is the top-level description; the plugin entry is targeted by its name.
  [".claude-plugin/marketplace.json", COPY.variants.plugin, ".claude-plugin/marketplace.json: Claude marketplace:"],
  [".claude-plugin/marketplace.json", `"name": "a", "description": ${JSON.stringify(COPY.variants.plugin)}`, ".claude-plugin/marketplace.json: Claude marketplace plugin (plugins[0].description):"],
  ["plugins/kya/.claude-plugin/plugin.json", COPY.variants.plugin, "plugins/kya/.claude-plugin/plugin.json: Claude Code plugin:"],
  [".cursor-plugin/plugin.json", COPY.long, ".cursor-plugin/plugin.json: Cursor plugin:"],
  ["../kya-python/pyproject.toml", COPY.variants.python, "../kya-python/pyproject.toml: kya-python pyproject (monorepo copy, not the PyPI source):"],
  ["packaging/homebrew/shield-kya.rb", '"Tagline for agents"', "packaging/homebrew/shield-kya.rb: Homebrew:"],
  ["packaging/scoop/shield-kya.json", COPY.long, "packaging/scoop/shield-kya.json: Scoop:"],
  [`${WINGET}/0.10.0/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`, "ShortDescription: Tagline for agents", "winget ShortDescription:"],
  [`${WINGET}/0.10.0/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`, "agents. Long story here.", "winget Description:"],
  ["README.md", "Long story here.", "README.md: README:"],
  [`${WEB_TPL}/install.html`, "Install &amp; go.", `${WEB_TPL}/install.html: web /install:`],
  [`${WEB_TPL}/how-kya-works.html`, "How it works.", `${WEB_TPL}/how-kya-works.html: web /how-kya-works:`],
];

describe("checkChannelCopy", () => {
  it("passes on a clean tree, with every channel present", () => {
    expect(problems({ requireAll: true })).toEqual([]);
    expect(checkChannelCopy(dir).skipped).toEqual([]);
  });

  it.each(DRIFT)("fails on drift in %s and names it; --write repairs it", (file, from, label) => {
    const before = read(file);
    const to = from.startsWith('"name"') ? '"name": "a", "description": "Other"' : from.startsWith('"') ? '"Some other words"' : from.startsWith("ShortDescription") ? "ShortDescription: Other" : "Drifted words.";
    edit(file, from, to);
    const found = problems();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(label);
    expect(found[0]).toMatch(/expected .*, found /);

    expect(checkChannelCopy(dir, { write: true }).written).toEqual([file]);
    expect(problems()).toEqual([]);
    // Only the description changed back; everything else in the file is byte-identical.
    if (!file.endsWith("README.md") && !file.includes("winget")) expect(read(file)).toBe(before);
  });

  it("repairs a winget scalar Description and the README lead in place", () => {
    const loc = `${WINGET}/0.10.0/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`;
    put(loc, "PackageName: x\nShortDescription: Old\nDescription: Old one-liner\nMoniker: x\n");
    edit("README.md", "**Tagline for agents.** Long story here.", "**Old tagline.** Old second sentence.");
    expect(problems()).toHaveLength(3);
    checkChannelCopy(dir, { write: true });
    expect(read(loc)).toBe("PackageName: x\nShortDescription: Tagline for agents\nDescription: |\n  Tagline for agents. Long story here.\nMoniker: x\n");
    expect(read("README.md")).toContain("\n**Tagline for agents.** Long story here. Free text after.\n");
    expect(problems()).toEqual([]);
  });

  it("ignores older winget version directories", () => {
    expect(read(`${WINGET}/0.9.0/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`)).toContain("stale");
    expect(problems()).toEqual([]);
  });

  it("fails when a channel file exists but has no description field", () => {
    put("server.json", JSON.stringify({ name: "x" }));
    put(".claude-plugin/marketplace.json", JSON.stringify({ description: COPY.variants.plugin, plugins: [] }));
    expect(problems()).toEqual([
      `server.json: MCP registry: expected ${JSON.stringify(COPY.variants.mcp)}, found no description field`,
      `.claude-plugin/marketplace.json: Claude marketplace plugin: expected ${JSON.stringify(COPY.variants.plugin)}, found no description field`,
    ]);
  });

  it("passes the public mirror layout (no ../kya-python, no ../../web) and lists what it skipped", () => {
    rmSync(join(repo, "sdks", "kya-python"), { recursive: true });
    rmSync(join(repo, "web"), { recursive: true });
    const { problems: p, skipped } = checkChannelCopy(dir);
    expect(p).toEqual([]);
    expect(skipped).toEqual(["../kya-python/pyproject.toml", `${WEB_TPL}/install.html`, `${WEB_TPL}/how-kya-works.html`, WEB_IMG]);
    // --require-all (the private CI step) turns every skip into a failure.
    expect(problems({ requireAll: true })).toHaveLength(4);
  });
});

describe("screenshots", () => {
  it("fails on a changed PNG whose sha256 was not updated in channel-copy.json", () => {
    put("assets/shot.png", PNG_B);
    put(`${WEB_IMG}/shot.png`, PNG_B);
    expect(problems()).toEqual([`assets/shot.png: screenshots: expected sha256 ${sha(PNG_A)}, found ${sha(PNG_B)} (update channel-copy.json)`]);
  });

  it("fails on an unlisted PNG, a listed file that is gone, and an empty alt", () => {
    put("assets/new.png", PNG_B);
    expect(problems()).toEqual([
      `assets/new.png: screenshots: expected a channel-copy.json entry, found none (sha256 ${sha(PNG_B)}, add it with an alt text)`,
    ]);
    const copy = JSON.parse(read("channel-copy.json"));
    copy.screenshots = [
      { file: "assets/shot.png", sha256: sha(PNG_A), alt: " " },
      { file: "assets/new.png", sha256: sha(PNG_B), alt: "New" },
      { file: "assets/gone.png", sha256: sha(PNG_B), alt: "Gone" },
      LOGO,
    ];
    put("channel-copy.json", JSON.stringify(copy));
    expect(problems()).toEqual([
      "assets/shot.png: screenshots: expected alt text, found none",
      "assets/gone.png: screenshots: expected file, found none (listed in channel-copy.json)",
    ]);
  });

  it("fails when a web copy differs from assets/ and --write copies assets over it", () => {
    put(`${WEB_IMG}/shot.png`, PNG_B);
    expect(problems()).toEqual([`${WEB_IMG}/shot.png: web screenshot: expected sha256 ${sha(PNG_A)} (assets/shot.png), found ${sha(PNG_B)}`]);
    checkChannelCopy(dir, { write: true });
    expect(readFileSync(join(dir, WEB_IMG, "shot.png"))).toEqual(PNG_A);
    expect(problems()).toEqual([]);
  });

  it("fails when README references a repo image that does not exist (raw URL or relative)", () => {
    edit("README.md", "main/assets/shot.png", "main/assets/missing.png");
    put("README.md", `${read("README.md")}<img src="./assets/also-missing.png">\n`);
    expect(problems()).toEqual([
      "README.md: image: expected assets/missing.png to exist, found none (https://raw.githubusercontent.com/The-Pixel-Boys/shield-kya/main/assets/missing.png)",
      "README.md: image: expected assets/also-missing.png to exist, found none (./assets/also-missing.png)",
    ]);
  });
});

describe("validateCopy", () => {
  it("accepts the fixture copy", () => {
    expect(validateCopy(COPY)).toEqual([]);
  });

  it("rejects a variant that does not start with the tagline", () => {
    expect(validateCopy({ ...COPY, variants: { mcp: "Something else." } })).toEqual([
      'channel-copy.json: variants.mcp must start with the tagline "Tagline for agents."',
    ]);
  });

  it("rejects copy that claims OSS enforcement or a GA hosted console", () => {
    expect(validateCopy({ ...COPY, long: "Tagline for agents. Enforces every call." })[0]).toMatch(/long claims enforcement or GA/);
    expect(validateCopy({ ...COPY, long: "Tagline for agents. Hosted is GA." })[0]).toMatch(/long claims enforcement or GA/);
  });

  it("rejects long dashes and a tagline without a full stop", () => {
    expect(validateCopy({ ...COPY, long: "Tagline for agents. A \u2014 B." })).toEqual(["channel-copy.json: long contains a long dash"]);
    expect(validateCopy({ ...COPY, short: "Tagline for agents" })).toEqual(['channel-copy.json: short must be a sentence ending in "."']);
  });

  it("enforces the MCP registry 100-char limit and brew audit rules", () => {
    const long = `Tagline for agents. ${"x".repeat(90)}`;
    put("channel-copy.json", JSON.stringify({ ...COPY, variants: { ...COPY.variants, mcp: long }, screenshots: [{ file: "assets/shot.png", sha256: sha(PNG_A), alt: "A" }] }));
    expect(problems().filter((p) => p.startsWith("channel-copy.json"))).toEqual([
      "channel-copy.json: variants.mcp is 110 chars, MCP registry allows 100",
    ]);
    const wide = `Tagline ${"y".repeat(80)}.`;
    put("channel-copy.json", JSON.stringify({ short: wide, long: wide, variants: {}, screenshots: [] }));
    expect(problems()).toContain("channel-copy.json: short is 88 chars, brew audit allows 80");
    const article = { ...COPY, short: "The tagline.", long: "The tagline. Long.", variants: {} };
    put("channel-copy.json", JSON.stringify({ ...article, screenshots: [] }));
    expect(problems()).toContain("channel-copy.json: short starts with an article, brew audit rejects that");
  });
});

describe("CLI", () => {
  it("exits 1 with `path: channel: expected X, found Y`, and --write brings it back to 0", () => {
    cpSync(join(PACKAGE_ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
    edit("server.json", COPY.variants.mcp, "Old words.");
    const script = join(dir, "scripts", "check-channel-copy.mjs");
    let stderr = "";
    try {
      execFileSync(process.execPath, [script], { stdio: "pipe" });
    } catch (e) {
      stderr = String((e as { stderr: Buffer }).stderr);
      expect((e as { status: number }).status).toBe(1);
    }
    expect(stderr).toContain(`server.json: MCP registry: expected ${JSON.stringify(COPY.variants.mcp)}, found "Old words."`);
    const out = execFileSync(process.execPath, [script, "--write", "--require-all"], { encoding: "utf8" });
    expect(out).toContain("rewrote server.json");
    expect(out).toContain("channel copy OK");
  });
});

describe("review fixes", () => {
  const TERMS = [
    "fail-closed", "fail closed", "failclosed", "general availability", "generally available", "GA",
    "production-ready", "production ready", "guarantees", "blocks every", "blocks all", "enforces", "enforcement",
  ];

  it.each(TERMS)("rejects %s in the long copy and in a screenshot alt", (term) => {
    expect(validateCopy({ ...COPY, long: `Tagline for agents. It is ${term} now.` })).toEqual([
      expect.stringMatching(/^channel-copy\.json: long claims enforcement or GA/),
    ]);
    expect(validateCopy({ ...COPY, screenshots: [{ file: "assets/shot.png", sha256: "x", alt: `Dashboard, ${term}` }] })).toEqual([
      expect.stringMatching(/^channel-copy\.json: screenshots assets\/shot\.png alt claims enforcement or GA/),
    ]);
  });

  it("fails a marketplace plugin entry that has no description", () => {
    const m = JSON.parse(read(".claude-plugin/marketplace.json"));
    m.plugins.push({ name: "evil", source: "./x" });
    put(".claude-plugin/marketplace.json", JSON.stringify(m, null, 2));
    expect(problems()).toEqual([
      `.claude-plugin/marketplace.json: Claude marketplace plugin (plugins[2].description): expected ${JSON.stringify(COPY.variants.plugin)}, found no description field`,
    ]);
  });

  it("reads pyproject description from the [project] table only, both directions", () => {
    const py = "../kya-python/pyproject.toml";
    const right = JSON.stringify(COPY.variants.python);
    // A correct description in another table neither satisfies nor hides a wrong [project] one.
    put(py, `[tool.fake]\ndescription = ${right}\n\n[project]\nname = "x"\ndescription = "WRONG copy"\n`);
    expect(problems()).toEqual([
      `${py}: kya-python pyproject (monorepo copy, not the PyPI source): expected ${right}, found "WRONG copy"`,
    ]);
    checkChannelCopy(dir, { write: true });
    expect(read(py)).toBe(`[tool.fake]\ndescription = ${right}\n\n[project]\nname = "x"\ndescription = ${right}\n`);
    // A wrong description in a later table is not the [project] one.
    put(py, `[project]\nname = "x"\ndescription = ${right}\n\n[tool.other]\ndescription = "unrelated"\n`);
    expect(problems()).toEqual([]);
    // [project] without a description fails even when another table has one.
    put(py, `[project]\nname = "x"\n\n[tool.other]\ndescription = ${right}\n`);
    expect(problems()).toEqual([`${py}: kya-python pyproject (monorepo copy, not the PyPI source): expected ${right}, found no description field`]);
  });

  it.each(["shot.webp", "shot.jpg", "shot.jpeg", "shot.gif", "icon.svg"])("requires a listed sha256 for assets/%s", (name) => {
    put(`assets/${name}`, PNG_B);
    expect(problems()).toEqual([
      `assets/${name}: screenshots: expected a channel-copy.json entry, found none (sha256 ${sha(PNG_B)}, add it with an alt text)`,
    ]);
  });

  it("reports web images without a byte-comparable asset as not covered, without failing", () => {
    put(`${WEB_IMG}/shot.jpg`, "re-encoded");
    const r = checkChannelCopy(dir);
    expect(r.problems).toEqual([]);
    expect(r.uncovered).toEqual([
      `${WEB_IMG}/shot.jpg (same name as assets/shot.png, different format: not byte-checked)`,
      `${WEB_IMG}/web-only.jpg (no assets/ counterpart)`,
    ]);
  });

  it("compares exactly: a case-only or whitespace-only difference fails", () => {
    edit("package.json", COPY.long, COPY.long.toLowerCase());
    expect(problems()).toHaveLength(1);
    fixture();
    edit("package.json", COPY.long, COPY.long.replace("Long story", "Long  story"));
    expect(problems()).toHaveLength(1);
    fixture();
    edit("server.json", COPY.variants.mcp, `${COPY.variants.mcp} `);
    expect(problems()).toHaveLength(1);
  });

  it("fails a wrapped winget Description block and --write unwraps it", () => {
    const loc = `${WINGET}/0.10.0/The-Pixel-Boys.ShieldKYA.locale.en-US.yaml`;
    edit(loc, "  Tagline for agents. Long story here.\n", "  Tagline for agents.\n  Long story here.\n");
    expect(problems()).toHaveLength(1);
    checkChannelCopy(dir, { write: true });
    expect(read(loc)).toContain("Description: |\n  Tagline for agents. Long story here.\nMoniker: x\n");
    expect(problems()).toEqual([]);
  });

  it("fails a README image that leaves the package root (it 404s in the public mirror)", () => {
    put(`${WEB_IMG}/x.png`, PNG_A);
    put("README.md", `${read("README.md")}![w](../../web/src/main/resources/static/img/kya/x.png)\n<img src="/etc/x.png">\n`);
    expect(problems()).toEqual([
      "README.md: image: expected a path inside the package, found ../../web/src/main/resources/static/img/kya/x.png (it 404s in the public mirror)",
      "README.md: image: expected a path inside the package, found /etc/x.png (it 404s in the public mirror)",
    ]);
  });
});

// The check must read the files that actually ship to the public mirror. Data-driven against the
// real excludes list (monorepo only; the mirror has no scripts/ci). A path listed in
// EXCLUDED_UNTIL is a known gap: it is printed as a TODO, not failed.
const EXCLUDES = join(PACKAGE_ROOT, "../../scripts/ci/kya-mirror-excludes.txt");
// Empty today: every checked file ships. Add an entry only with the change that will un-exclude it.
const EXCLUDED_UNTIL: Record<string, string> = {};
describe.skipIf(!existsSync(EXCLUDES))("mirror excludes", () => {
  it("every in-package channel file ships to the public mirror", () => {
    const globs = readFileSync(EXCLUDES, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`));
    const copy = JSON.parse(readFileSync(join(PACKAGE_ROOT, COPY_FILE), "utf8"));
    const files = [
      COPY_FILE,
      ...channels(PACKAGE_ROOT, copy).map((c: { path: string }) => c.path),
      ...copy.screenshots.map((s: { file: string }) => s.file),
    ].filter((p: string) => !p.startsWith("../"));
    expect(files.length).toBeGreaterThan(10);
    const excluded = files.filter((p: string) => p.split("/").some((seg) => globs.some((g) => g.test(seg))));
    for (const p of excluded.filter((x: string) => x in EXCLUDED_UNTIL)) console.warn(`TODO: ${p} is mirror-excluded (${EXCLUDED_UNTIL[p]})`);
    for (const p of Object.keys(EXCLUDED_UNTIL).filter((x) => !excluded.includes(x))) console.warn(`TODO: ${p} ships now, drop it from EXCLUDED_UNTIL`);
    expect(excluded.filter((p: string) => !(p in EXCLUDED_UNTIL))).toEqual([]);
  });
});
