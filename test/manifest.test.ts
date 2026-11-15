/**
 * Feature kya-uninstall (manifest and write journal units): diffChange, isTracked, journal dry mode.
 * The CLI paths are covered end to end in start-consent.test.ts and start-gate.test.ts.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteSync } from "../src/fs-atomic.js";
import path from "node:path";
import { diffChange, isTracked, parseManifest } from "../src/manifest.js";
import { WriteJournal, journalMkdir, withJournal } from "../src/write-journal.js";

describe("diffChange", () => {
  it("a created JSON file lists keys to depth two", () => {
    const c = diffChange("/x/.mcp.json", undefined, JSON.stringify({ mcpServers: { "shield-kya": { command: "n" } } }));
    expect(c.keys).toEqual(["mcpServers.shield-kya"]);
    expect(c.added).toEqual([{ kind: "key", path: ["mcpServers", "shield-kya"] }]);
  });

  it("a merge into an existing object adds only the new key", () => {
    const c = diffChange("/x/c.json", JSON.stringify({ mcpServers: { mine: {} } }), JSON.stringify({ mcpServers: { mine: {}, "shield-kya": { a: 1 } } }));
    expect(c.keys).toEqual(["mcpServers.shield-kya"]);
    expect(c.removed).toEqual([]);
  });

  it("an appended array item is recorded as an item, not the whole array", () => {
    const item = { matcher: "", hooks: [{ type: "command", command: '"/h/.kya/bin/kya-hook" hook --host claude' }] };
    const c = diffChange("/x/s.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "a" }] } }), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "a" }, item] } }));
    expect(c.added).toEqual([{ kind: "item", path: ["hooks", "PreToolUse"], value: item }]);
    expect(c.keys[0]).toContain("hooks.PreToolUse[+] hook --host claude");
  });

  it("a new nested array becomes item adds under the created parents", () => {
    const c = diffChange("/x/s.json", JSON.stringify({ model: "x" }), JSON.stringify({ model: "x", hooks: { PreToolUse: [{ a: 1 }] } }));
    expect(c.added).toEqual([{ kind: "item", path: ["hooks", "PreToolUse"], value: { a: 1 } }]);
  });

  it("keys removed from the file are recorded (gateway routing)", () => {
    const c = diffChange("/x/c.json", JSON.stringify({ mcpServers: { github: { a: 1 }, k: {} } }), JSON.stringify({ mcpServers: { k: {} } }));
    expect(c.removed).toEqual([["mcpServers", "github"]]);
  });

  it("a replaced value (--force) is recorded so undo restores it from the backup", () => {
    const c = diffChange("/x/c.json", JSON.stringify({ mcpServers: { "shield-kya": { command: "old" } } }), JSON.stringify({ mcpServers: { "shield-kya": { command: "new" } } }));
    expect(c.keys[0]).toContain("(replaced)");
  });

  it("TOML: new tables and hook blocks are recorded, existing tables are not", () => {
    const before = 'model = "g"\n[mine]\na = 1\n';
    const after = `${before}[mcp_servers.shield-kya]\ncommand = "n"\n[[hooks]]\nevent = "PreToolUse"\ncommand = 'x hook --host kimi'\n`;
    const c = diffChange("/x/config.toml", before, after);
    expect(c.added).toEqual([
      { kind: "toml-table", name: "mcp_servers.shield-kya" },
      { kind: "toml-hook", identity: "hook --host kimi" },
    ]);
  });

  it(".gitignore: the appended line is recorded", () => {
    const c = diffChange("/p/.gitignore", "node_modules/\n", "node_modules/\n.kya/\n");
    expect(c.added).toEqual([{ kind: "line", text: ".kya/" }]);
  });

  it("a created plain file is labelled as a new file", () => {
    expect(diffChange("/h/.kya/bin/kya-hook", undefined, "#!/bin/sh\n").keys).toEqual(["(new file)"]);
  });
});

describe("diffChange TOML removals", () => {
  it("a table that is gone after the write is recorded as removed", () => {
    const before = 'model = "g"\n[mcp_servers.github]\ncommand = "npx"\n[mine]\na = 1\n';
    const after = 'model = "g"\n[mine]\na = 1\n[mcp_servers.shield-kya-gate]\nurl = "u"\n';
    const c = diffChange("/x/config.toml", before, after);
    expect(c.removedToml).toEqual(["mcp_servers.github"]);
    expect(c.added).toEqual([{ kind: "toml-table", name: "mcp_servers.shield-kya-gate" }]);
  });
});

describe("parseManifest", () => {
  const entry = { path: "/h/.claude.json", action: "merged", scope: "home", keys: [], added: [], removed: [], sha256: "a".repeat(64), at: "t" };
  it("accepts a valid manifest", () => {
    expect(parseManifest({ version: 1, entries: [entry], dirs: ["/h/.claude"] }).entries).toHaveLength(1);
  });
  it.each([
    ["not an object", []],
    ["wrong version", { version: 2, entries: [] }],
    ["entries not an array", { version: 1, entries: {} }],
    ["relative path", { version: 1, entries: [{ ...entry, path: "rel" }] }],
    ["bad action", { version: 1, entries: [{ ...entry, action: "x" }] }],
    ["bad sha", { version: 1, entries: [{ ...entry, sha256: "zz" }] }],
    ["bad added kind", { version: 1, entries: [{ ...entry, added: [{ kind: "rm-rf" }] }] }],
    ["added key without a path", { version: 1, entries: [{ ...entry, added: [{ kind: "key" }] }] }],
    ["removed not string lists", { version: 1, entries: [{ ...entry, removed: [[1]] }] }],
    ["backup not a string", { version: 1, entries: [{ ...entry, backup: 5 }] }],
    ["dirs not strings", { version: 1, entries: [], dirs: [1] }],
  ])("rejects %s", (_n, raw) => {
    expect(() => parseManifest(raw)).toThrow();
  });
});

describe("isTracked on Windows paths", () => {
  const ctx = { globalDir: "C:\\Users\\u\\.kya", cwd: "C:\\proj" };
  it("uses path.win32 rules: drive letters, backslashes, other drives", () => {
    expect(isTracked("C:\\Users\\u\\.kya\\bin\\kya-hook", ctx, path.win32)).toBe(true);
    expect(isTracked("C:\\Users\\u\\.kya\\gateways.json", ctx, path.win32)).toBe(true);
    expect(isTracked("C:\\Users\\u\\.kya\\trail.jsonl", ctx, path.win32)).toBe(false);
    expect(isTracked("C:\\proj\\.kya\\config.json", ctx, path.win32)).toBe(true);
    expect(isTracked("C:\\proj\\.kya\\trail.jsonl", ctx, path.win32)).toBe(false);
    expect(isTracked("C:\\proj\\.mcp.json", ctx, path.win32)).toBe(true);
    // Another drive is never "under" the global dir, even when the tail matches.
    expect(isTracked("D:\\Users\\u\\.kya\\trail.jsonl", ctx, path.win32)).toBe(true);
    expect(isTracked("D:\\.claude.json", ctx, path.win32)).toBe(true);
  });
});

describe("isTracked", () => {
  const ctx = { globalDir: "/h/.kya", cwd: "/p" };
  it("tracks wiring, not KYA's own state", () => {
    expect(isTracked("/h/.claude.json", ctx)).toBe(true);
    expect(isTracked("/p/.mcp.json", ctx)).toBe(true);
    expect(isTracked("/p/.kya/config.json", ctx)).toBe(true);
    expect(isTracked("/h/.kya/bin/kya-hook", ctx)).toBe(true);
    expect(isTracked("/h/.kya/gateways.json", ctx)).toBe(true);
    expect(isTracked("/p/.kya/trail.jsonl", ctx)).toBe(false);
    expect(isTracked("/p/.kya/receipts/last-3d.html", ctx)).toBe(false);
    expect(isTracked("/h/.kya/telemetry.json", ctx)).toBe(false);
  });
});

describe("write journal", () => {
  it("a dry journal records the write and creates no file or directory", async () => {
    const d = mkdtempSync(join(tmpdir(), "kya-journal-"));
    try {
      const j = new WriteJournal(true);
      await withJournal(j, () => {
        journalMkdir(join(d, "a", "b"));
        atomicWriteSync(join(d, "a", "b", "f.txt"), "hi");
      });
      expect(existsSync(join(d, "a"))).toBe(false);
      expect(j.touched().map((t) => t.after.toString())).toEqual(["hi"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("a live journal writes, records the directories it created and the first before-bytes", async () => {
    const d = mkdtempSync(join(tmpdir(), "kya-journal-"));
    try {
      const j = new WriteJournal(false);
      await withJournal(j, () => {
        journalMkdir(join(d, "a", "b"));
        atomicWriteSync(join(d, "a", "b", "f.txt"), "one");
        atomicWriteSync(join(d, "a", "b", "f.txt"), "two");
      });
      expect(j.dirs).toEqual([join(d, "a", "b"), join(d, "a")]);
      const t = j.touched()[0]!;
      expect(t.before).toBeUndefined();
      expect(t.after.toString()).toBe("two");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("writes outside a journal are untouched by it", () => {
    const d = mkdtempSync(join(tmpdir(), "kya-journal-"));
    try {
      atomicWriteSync(join(d, "f.txt"), "x");
      expect(existsSync(join(d, "f.txt"))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
