/**
 * Deterministic TOCTOU regression for writeProjectFile: the parent dir is
 * swapped for a link out of the project after the first check (inside the
 * mkdir that precedes the temp file), so only the re-check right before the
 * rename can stop the write. A live race of the same swap (rename .kya + link
 * in a loop against writeProjectFile) was run in the PR #424 review.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const swap: { at?: string; to?: string } = {};

vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return {
    ...fs,
    mkdirSync: (p: string, o?: unknown) => {
      const r = fs.mkdirSync(p, o as never);
      if (swap.at && p === swap.at && swap.to) {
        fs.renameSync(swap.at, `${swap.at}-real`);
        fs.symlinkSync(swap.to, swap.at);
        swap.at = undefined;
      }
      return r;
    },
  };
});

const { ProjectPathError, writeProjectFile } = await import("../src/fs-atomic.js");

describe.skipIf(process.platform === "win32")("writeProjectFile TOCTOU re-check", () => {
  it("refuses when .kya becomes a link out of the project between the check and the rename", () => {
    const base = mkdtempSync(join(tmpdir(), "kya-toctou-"));
    try {
      const cwd = join(base, "repo");
      const outside = join(base, "outside");
      mkdirSync(join(cwd, ".kya"), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, "victim"), "v\n");
      swap.at = join(cwd, ".kya");
      swap.to = outside;
      expect(() => writeProjectFile(join(cwd, ".kya", "x.json"), "W\n", cwd)).toThrow(ProjectPathError);
      expect(swap.at).toBeUndefined(); // the swap really happened
      expect(readdirSync(outside)).toEqual(["victim"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
