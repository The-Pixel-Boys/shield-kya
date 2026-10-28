/**
 * User-visible output must never link to the private monorepo (The-Pixel-Boys/shield-agent):
 * it opens a 404 for everyone outside the company. Public links point at shield-kya.
 * Scans the source strings under src/ (the only place output text is built).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
// The private repo name, not followed by a word char, dot or dash (so shield-kya never matches).
const PRIVATE_REPO = /The-Pixel-Boys\/shield-agent(?![\w.-])/;

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((p) => /\.(ts|tsx|js|mjs|cjs|html)$/.test(p))
    .map((p) => join(SRC, p))
    .filter((p) => statSync(p).isFile());
}

describe("public links in kya output", () => {
  it("the scan regex matches the private repo and not the public mirror", () => {
    expect(PRIVATE_REPO.test("https://github.com/The-Pixel-Boys/shield-agent")).toBe(true);
    expect(PRIVATE_REPO.test("https://github.com/The-Pixel-Boys/shield-agent/issues")).toBe(true);
    expect(PRIVATE_REPO.test("https://github.com/The-Pixel-Boys/shield-kya")).toBe(false);
    expect(PRIVATE_REPO.test("https://github.com/The-Pixel-Boys/shield-agent-docs")).toBe(false);
  });

  it("no file under sdks/kya/src links to the private monorepo", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    const hits = files.filter((f) => PRIVATE_REPO.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
