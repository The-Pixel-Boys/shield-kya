/**
 * atomicWriteSync: shared by team init, connect, wire-hooks, gate config, telemetry and the certify store.
 * A repo-planted symlink at a guessable temp name must never redirect the write.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteSync } from "../src/fs-atomic.js";

const posix = process.platform !== "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "kya-atomic-"));

describe("atomicWriteSync", () => {
  it.skipIf(!posix)("ignores a symlink planted at the old predictable temp name", () => {
    const dir = tmp();
    const victim = join(tmp(), "victim.txt");
    writeFileSync(victim, "precious\n");
    const target = join(dir, "settings.json");
    symlinkSync(victim, `${target}.kya-tmp-${process.pid}`);
    atomicWriteSync(target, '{"ok":true}\n');
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    expect(lstatSync(target).isFile()).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe('{"ok":true}\n');
  });

  it.skipIf(!posix)("temp names differ per call and never reuse the pid (observed through a failing rename)", () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const dir = tmp();
      const target = join(dir, "t");
      mkdirSync(target); // rename of a file onto a directory fails, leaving us the error path
      try {
        atomicWriteSync(target, "x", () => {
          seen.push(readdirSync(dir).find((n) => n.startsWith("t.kya-tmp-"))!);
        });
      } catch {
        /* expected */
      }
      expect(readdirSync(dir)).toEqual(["t"]); // failure removed the temp file
    }
    expect(seen[0]).toMatch(/^t\.kya-tmp-[0-9a-f]{32}$/);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toContain(String(process.pid));
  });

  it.skipIf(!posix)("carries over an existing 0600 mode", () => {
    const dir = tmp();
    const target = join(dir, "secret.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o600);
    atomicWriteSync(target, '{"a":1}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
  });

  it("a beforeRename refusal leaves the target untouched and no temp file", () => {
    const dir = tmp();
    const target = join(dir, "f.json");
    writeFileSync(target, "old");
    expect(() => atomicWriteSync(target, "new", () => { throw new Error("changed"); })).toThrow("changed");
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["f.json"]);
  });
});
