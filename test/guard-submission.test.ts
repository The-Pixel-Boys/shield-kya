/**
 * Feature kya-plugin-guard-hosts, submission pack (plugins/kya-guard/submission): the listing texts equal channel-copy.json,
 * the screenshots are real captures of the bundle, the plugin has its icon, and the two-minute reviewer script passes on
 * a clean profile and fails on a bundle that misbehaves (the script is run with GUARD_BUNDLE set to a broken bundle).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { checkChannelCopy, validateCopy } from "../scripts/check-channel-copy.mjs";
// @ts-expect-error plain .mjs script, no type declarations
import { capture, captureCard, mask, maskDate, SHOTS } from "../scripts/guard-screenshots.mjs";

const PKG = join(import.meta.dirname, "..");
const PLUGIN = join(PKG, "plugins", "kya-guard");
const SUB = join(PLUGIN, "submission");
const COPY = JSON.parse(readFileSync(join(PKG, "channel-copy.json"), "utf8"));
const ONE_LINER = "Stops your coding agent from deleting, leaking or dropping things. No network, one file, fails open.";
const posix = process.platform !== "win32";
const read = (p: string): string => readFileSync(p, "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "kya-guard-sub-"));
  dirs.push(d);
  return d;
};

describe("kya-plugin-guard-hosts: listing texts", () => {
  it("description-50/150/500.txt equal channel-copy.json guardListing and stay within their limits", () => {
    for (const n of [50, 150, 500]) {
      const text = read(join(SUB, `description-${n}.txt`));
      expect(text).toBe(`${COPY.guardListing[`chars${n}`]}\n`);
      expect(text.trimEnd().length).toBeLessThanOrEqual(n);
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("the canonical one-liner is variants.guard, on every plugin manifest, and inside the 150 and 500 texts", () => {
    expect(COPY.variants.guard).toBe(ONE_LINER);
    expect(COPY.guardListing.chars150.startsWith(ONE_LINER)).toBe(true);
    expect(COPY.guardListing.chars500.startsWith(ONE_LINER)).toBe(true);
    const manifests = [
      "plugins/kya-guard/.claude-plugin/plugin.json", "plugins/kya-guard/.codex-plugin/plugin.json",
      "plugins/kya-guard-cursor/.cursor-plugin/plugin.json", "plugins/kya-guard-copilot/plugin.json", "plugins/kya-guard-gemini/gemini-extension.json",
    ];
    for (const m of manifests) expect(JSON.parse(read(join(PKG, m))).description, m).toBe(ONE_LINER);
  });

  it("the channel-copy check passes for every kya-guard channel (parity holds)", () => {
    const r = checkChannelCopy(PKG, { requireAll: false });
    expect(r.problems.filter((p: string) => /kya-guard|guardListing/.test(p))).toEqual([]);
  });

  it("the channel-copy check catches a changed text file (mutation)", () => {
    const root = tmp();
    mkdirSync(join(root, "plugins/kya-guard/submission"), { recursive: true });
    writeFileSync(join(root, "channel-copy.json"), JSON.stringify({ ...COPY, screenshots: [] }));
    writeFileSync(join(root, "plugins/kya-guard/submission/description-150.txt"), "Something else.\n");
    const r = checkChannelCopy(root, {});
    expect(r.problems.join("\n")).toMatch(/description-150\.txt: kya-guard directory form \(150 characters\): expected/);
  });

  it("validateCopy rejects a listing text that is too long, lacks the tagline or claims enforcement", () => {
    const bad = (g: Record<string, string>) => validateCopy({ ...COPY, guardListing: { ...COPY.guardListing, ...g } }).join("\n");
    expect(bad({ chars50: "x".repeat(51) })).toMatch(/guardListing\.chars50 is 51 chars, the limit is 50/);
    expect(bad({ chars150: "Something else entirely." })).toMatch(/chars150 must start with the tagline/);
    expect(bad({ chars150: `${COPY.short} This enforces everything. ${ONE_LINER}`.slice(0, 150) })).toMatch(/claims enforcement/);
    expect(bad({ chars500: `${COPY.short} Different text, not the one-liner.` })).toMatch(/chars500 must contain variants.guard/);
    expect(validateCopy(COPY)).toEqual([]);
  });
});

describe("kya-plugin-guard-hosts: screenshots and pack files", () => {
  it("has three PNGs (real image data, wider than 600 px) and the near-miss card as SVG, made from the PocketOS replay", () => {
    for (const f of ["01-deny.png", "02-status.png", "03-card.png"]) {
      const b = readFileSync(join(SHOTS, f));
      expect(b.subarray(0, 8).toString("hex"), f).toBe("89504e470d0a1a0a");
      expect(b.readUInt32BE(16), `${f} width`).toBeGreaterThan(600);
      expect(b.length).toBeGreaterThan(5_000);
    }
    const card = readFileSync(join(SHOTS, "03-card.png"));
    expect([card.readUInt32BE(16), card.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(readdirSync(SHOTS).filter((f) => f.startsWith("03-")).sort()).toEqual(["03-card.png", "03-card.svg"]);
    const svg = read(join(SHOTS, "03-card.svg"));
    const lines = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    expect(lines.slice(0, 2)).toEqual(["My coding agent tried to delete a cloud volume.", "KYA Guard stopped it."]);
    expect(lines[2]).toMatch(/^Rule railway-volume-delete \| Claude Code \| \d{4}-\d\d-\d\d$/);
    expect(lines[3]).toBe("Install: npx @shield-agent/kya@latest start");
  });

  it("the card SVG equals a fresh run of the bundle on the PocketOS replay (date masked): it is a real card, not a mock-up", () => {
    expect(maskDate(read(join(SHOTS, "03-card.svg")))).toBe(maskDate(captureCard()));
  });

  it("the text captures equal a fresh run of the bundle (dates masked): the screenshots show real output", () => {
    const fresh = capture() as Record<string, string>;
    for (const [name, text] of Object.entries(fresh)) expect(mask(read(join(SHOTS, `${name}.txt`)).trimEnd()), name).toBe(mask(text));
    expect(fresh["01-deny"]).toContain("KYA denied Bash: NEVER_SHELL (terraform-destroy)");
    expect(fresh["02-status"]).toMatch(/Calls blocked in 7 days: 2/);
  });

  it("the plugin has its icon: a square PNG from 512 to 2048 px, under 2 MB, equal to the kya plugin icon", () => {
    const icon = readFileSync(join(PLUGIN, ".claude-plugin", "icon.png"));
    expect(icon.subarray(1, 4).toString()).toBe("PNG");
    const [w, h] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
    expect(w).toBe(h);
    expect(w).toBeGreaterThanOrEqual(512);
    expect(w).toBeLessThanOrEqual(2048);
    expect(icon.length).toBeLessThan(2 * 1024 * 1024);
    expect(icon.equals(readFileSync(join(PKG, "plugins", "kya", ".claude-plugin", "icon.png")))).toBe(true);
  });

  it("the submission README links the reviewer sheet, the scoreboard, the descriptions, the script and lists the owner steps", () => {
    const t = read(join(SUB, "README.md"));
    for (const needle of ["../SECURITY.md", "https://shield-agent.com/replays", "description-50.txt", "description-150.txt", "description-500.txt", "review-test.sh", "03-card.svg", "03-card.png", "claude.ai/directory/manage", "Codex", "Cursor", "Gemini"]) {
      expect(t, needle).toContain(needle);
    }
    expect(statSync(join(PLUGIN, "SECURITY.md")).isFile()).toBe(true);
    expect(t).not.toMatch(/[\u2013\u2014]/);
  });
});

// Each run starts about 14 node processes; under a loaded full suite that can pass 5 s.
describe.skipIf(!posix)("kya-plugin-guard-hosts: the two-minute reviewer script (e2e)", { timeout: 60_000 }, () => {
  /** Run the script with a clean profile: its own temp HOME is made by the script, our HOME is a decoy that must stay empty. */
  function review(bundle?: string) {
    const decoy = tmp();
    const r = spawnSync("bash", [join(SUB, "review-test.sh")], {
      encoding: "utf8", timeout: 120_000,
      env: { PATH: process.env.PATH ?? "", HOME: decoy, TMPDIR: tmp(), ...(bundle ? { GUARD_BUNDLE: bundle } : {}) },
    });
    return { code: r.status, out: r.stdout, decoy };
  }
  const bundleOf = (js: string): string => {
    const p = join(tmp(), "guard.mjs");
    writeFileSync(p, js);
    return p;
  };

  it("passes on the shipped bundle, runs 3 denies and 3 allows, and leaves the real HOME empty", () => {
    const r = review();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("PASS: KYA Guard behaved as documented");
    expect(r.out.match(/^ok   /gm)!.length).toBeGreaterThanOrEqual(10);
    expect(readdirSync(r.decoy)).toEqual([]);
  });

  it("also passes on every variant copy of the bundle", () => {
    for (const d of ["kya-guard-cursor", "kya-guard-copilot", "kya-guard-gemini"]) {
      const r = review(join(PKG, "plugins", d, "dist", "guard.mjs"));
      expect(r.code, `${d}\n${r.out}`).toBe(0);
    }
  });

  it("fails (exit 1) on a bundle that allows everything: the 3 deny checks fail", () => {
    const r = review(bundleOf("process.exit(0);\n"));
    expect(r.code).toBe(1);
    expect(r.out.match(/^FAIL .*wanted exit 2, got 0/gm)!.length).toBeGreaterThanOrEqual(3);
  });

  it("fails on a bundle that denies everything: the 3 allow checks fail", () => {
    const r = review(bundleOf("process.exit(2);\n"));
    expect(r.code).toBe(1);
    expect(r.out.match(/^FAIL .*wanted exit 0, got 2/gm)!.length).toBeGreaterThanOrEqual(3);
  });

  it("fails when the bundle is missing, and when it does not exist as a file", () => {
    const r = review(join(tmp(), "nope.mjs"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: no bundle at");
  });

  it("fails on a bundle that blocks a payload that is not JSON (it must fail open)", () => {
    const r = review(bundleOf('let s = "";\nprocess.stdin.on("data", (c) => (s += c));\nprocess.stdin.on("end", () => { try { JSON.parse(s); } catch { process.exit(2); } });\n'));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL bad payload: wanted exit 0, got 2/);
  });
});
