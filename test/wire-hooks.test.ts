import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "../src/errors.js";
import { wireHook, wireHooks, kimiHooksBlockText } from "../src/commands/wire-hooks.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-wire-hooks-"));
}

describe("wireHooks", () => {
  it("wires all three hook hosts by default", () => {
    const home = tmp();
    try {
      const results = wireHooks({ home });
      expect(results.map((r) => r.host).sort()).toEqual(["claude", "grok", "kimi"]);
      for (const r of results) {
        expect(r.status).toBe("created");
        expect(existsSync(r.path)).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("wireHook claude", () => {
  it("creates ~/.claude/settings.json with a PreToolUse hook entry", () => {
    const home = tmp();
    try {
      const r = wireHook({ host: "claude", home });
      expect(r.status).toBe("created");
      expect(r.path).toBe(join(home, ".claude", "settings.json"));
      const raw = JSON.parse(readFileSync(r.path, "utf8")) as {
        hooks: {
          PreToolUse: Array<{
            matcher: string;
            hooks: Array<{ type: string; command: string; timeout: number }>;
          }>;
        };
      };
      expect(raw.hooks.PreToolUse).toHaveLength(1);
      const entry = raw.hooks.PreToolUse[0]!;
      expect(entry.matcher).toBe("");
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0]!.type).toBe("command");
      expect(entry.hooks[0]!.command).toContain("hook --host claude");
      expect(entry.hooks[0]!.timeout).toBe(5);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent: second run skips with byte-identical file", () => {
    const home = tmp();
    try {
      const first = wireHook({ host: "claude", home });
      const before = readFileSync(first.path, "utf8");
      const second = wireHook({ host: "claude", home });
      expect(second.status).toBe("skipped");
      expect(readFileSync(first.path, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("merges into an existing settings.json preserving other hooks and keys", () => {
    const home = tmp();
    try {
      const target = join(home, ".claude", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        JSON.stringify({
          theme: "dark",
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
            ],
            PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo post" }] }],
          },
        }),
        "utf8",
      );
      const r = wireHook({ host: "claude", home });
      expect(r.status).toBe("wired");
      const raw = JSON.parse(readFileSync(target, "utf8")) as {
        theme: string;
        hooks: {
          PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
          PostToolUse: unknown[];
        };
      };
      expect(raw.theme).toBe("dark");
      expect(raw.hooks.PostToolUse).toHaveLength(1);
      expect(raw.hooks.PreToolUse).toHaveLength(2);
      expect(raw.hooks.PreToolUse[0]!.matcher).toBe("Bash");
      expect(raw.hooks.PreToolUse[1]!.hooks[0]!.command).toContain("hook --host claude");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses malformed settings.json JSON and leaves the file untouched", () => {
    const home = tmp();
    try {
      const target = join(home, ".claude", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "{ not json", "utf8");
      const before = readFileSync(target, "utf8");
      expect(() => wireHook({ host: "claude", home })).toThrow(UsageError);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses settings.json whose hooks key is not an object", () => {
    const home = tmp();
    try {
      const target = join(home, ".claude", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ hooks: "yes" }), "utf8");
      const before = readFileSync(target, "utf8");
      expect(() => wireHook({ host: "claude", home })).toThrow(UsageError);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses settings.json whose hooks.PreToolUse is not an array", () => {
    const home = tmp();
    try {
      const target = join(home, ".claude", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ hooks: { PreToolUse: {} } }), "utf8");
      const before = readFileSync(target, "utf8");
      expect(() => wireHook({ host: "claude", home })).toThrow(UsageError);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--force replaces only the kya entry, preserving other entries", () => {
    const home = tmp();
    try {
      const target = join(home, ".claude", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "", hooks: [{ type: "command", command: "old hook --host claude", timeout: 99 }] },
              { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
            ],
          },
        }),
        "utf8",
      );
      const r = wireHook({ host: "claude", home, force: true });
      expect(r.status).toBe("wired");
      const raw = JSON.parse(readFileSync(target, "utf8")) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }> };
      };
      expect(raw.hooks.PreToolUse).toHaveLength(2);
      const kya = raw.hooks.PreToolUse.find((e) =>
        e.hooks.some((h) => h.command.includes("hook --host claude")),
      )!;
      expect(kya.hooks[0]!.timeout).toBe(5);
      const other = raw.hooks.PreToolUse.find((e) => e.matcher === "Bash")!;
      expect(other.hooks[0]!.command).toBe("echo hi");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("wireHook grok", () => {
  it("creates ~/.grok/hooks/shield-kya.json with the expected shape", () => {
    const home = tmp();
    try {
      const r = wireHook({ host: "grok", home });
      expect(r.status).toBe("created");
      expect(r.path).toBe(join(home, ".grok", "hooks", "shield-kya.json"));
      const raw = JSON.parse(readFileSync(r.path, "utf8")) as {
        hooks: {
          PreToolUse: Array<{
            matcher: string;
            hooks: Array<{ type: string; command: string; timeout: number }>;
          }>;
        };
      };
      expect(raw.hooks.PreToolUse).toHaveLength(1);
      const entry = raw.hooks.PreToolUse[0]!;
      expect(entry.matcher).toBe("");
      expect(entry.hooks).toEqual([
        {
          type: "command",
          command: expect.stringContaining("hook --host grok"),
          timeout: 5,
        },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent: second run skips with identical content", () => {
    const home = tmp();
    try {
      const first = wireHook({ host: "grok", home });
      const before = readFileSync(first.path, "utf8");
      const second = wireHook({ host: "grok", home });
      expect(second.status).toBe("skipped");
      expect(readFileSync(first.path, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rewires stale content with status wired", () => {
    const home = tmp();
    try {
      const first = wireHook({ host: "grok", home });
      writeFileSync(first.path, JSON.stringify({ hooks: { PreToolUse: [] } }), "utf8");
      const r = wireHook({ host: "grok", home });
      expect(r.status).toBe("wired");
      const raw = JSON.parse(readFileSync(r.path, "utf8")) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      expect(raw.hooks.PreToolUse[0]!.hooks[0]!.command).toContain("hook --host grok");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("wireHook kimi", () => {
  it("appends a [[hooks]] block to an existing config.toml, preserving content", () => {
    const home = tmp();
    try {
      const target = join(home, ".kimi-code", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'model = "k2"\n', "utf8");
      const r = wireHook({ host: "kimi", home });
      expect(r.status).toBe("wired");
      const text = readFileSync(target, "utf8");
      expect(text.startsWith('model = "k2"\n')).toBe(true);
      expect(text).toContain("[[hooks]]");
      expect(text).toContain('event = "PreToolUse"');
      expect(text).toContain("timeout = 5");
      const cmdLine = text.split("\n").find((l) => l.startsWith("command = "))!;
      expect(cmdLine.startsWith("command = '")).toBe(true);
      expect(cmdLine.endsWith("'")).toBe(true);
      expect(cmdLine).toContain("hook --host kimi");
      const second = wireHook({ host: "kimi", home });
      expect(second.status).toBe("skipped");
      expect(readFileSync(target, "utf8")).toBe(text);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("creates config.toml in a fresh home with just the block", () => {
    const home = tmp();
    try {
      const r = wireHook({ host: "kimi", home });
      expect(r.status).toBe("created");
      expect(r.path).toBe(join(home, ".kimi-code", "config.toml"));
      const text = readFileSync(r.path, "utf8");
      expect(text.startsWith("[[hooks]]\n")).toBe(true);
      expect(text).toContain('event = "PreToolUse"');
      expect(text).toContain("hook --host kimi");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--force replaces the existing kya [[hooks]] block, preserving other config", () => {
    const home = tmp();
    try {
      const target = join(home, ".kimi-code", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        [
          'model = "k2"',
          "",
          "[[hooks]]",
          'event = "PreToolUse"',
          'command = "old hook --host kimi"',
          "timeout = 99",
          "",
          "[[hooks]]",
          'event = "PostToolUse"',
          'command = "other"',
          "",
        ].join("\n"),
        "utf8",
      );
      const r = wireHook({ host: "kimi", home, force: true });
      expect(r.status).toBe("wired");
      const text = readFileSync(target, "utf8");
      expect(text).toContain('model = "k2"');
      expect(text).not.toContain("timeout = 99");
      expect(text).not.toContain("old hook --host kimi");
      expect(text).toContain('command = "other"');
      expect(text).toContain("hook --host kimi");
      expect(text.match(/\[\[hooks\]\]/g)).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("wireHook unknown host", () => {
  it("throws UsageError", () => {
    const home = tmp();
    try {
      expect(() => wireHook({ host: "emacs", home })).toThrow(UsageError);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("kimiHooksBlockText TOML literal-string guard", () => {
  it("refuses a command containing a single quote (TOML literal string cannot hold one)", () => {
    expect(() =>
      kimiHooksBlockText(`"/Users/o'brien/.nvm/node" "/app/dist/cli.js" hook --host kimi`),
    ).toThrow(UsageError);
  });

  it("refuses a command containing a newline", () => {
    expect(() => kimiHooksBlockText("node cli.js\nmalicious = true")).toThrow(UsageError);
    expect(() => kimiHooksBlockText("node cli.js\rhook --host kimi")).toThrow(UsageError);
  });

  it("builds the block for a safe command", () => {
    const text = kimiHooksBlockText('"/usr/bin/node" "/app/dist/cli.js" hook --host kimi');
    expect(text.startsWith("[[hooks]]\n")).toBe(true);
    expect(text).toContain(`command = '"/usr/bin/node" "/app/dist/cli.js" hook --host kimi'`);
    expect(text).toContain('event = "PreToolUse"');
    expect(text).toContain("timeout = 5");
  });
});

describe("wireHook kimi pre-existing hooks guard", () => {
  it("refuses to append when config.toml has a plain [hooks] table, leaving the file untouched", () => {
    const home = tmp();
    try {
      const target = join(home, ".kimi-code", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      const before = '[hooks]\nevent = "PreToolUse"\ncommand = "mine"\n';
      writeFileSync(target, before, "utf8");
      expect(() => wireHook({ host: "kimi", home })).toThrow(UsageError);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to append when config.toml has a top-level hooks scalar, leaving the file untouched", () => {
    const home = tmp();
    try {
      const target = join(home, ".kimi-code", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      const before = 'model = "k2"\nhooks = "https://example.invalid/hooks.json"\n';
      writeFileSync(target, before, "utf8");
      expect(() => wireHook({ host: "kimi", home })).toThrow(UsageError);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to append when config.toml has an indented [hooks] table, leaving the file untouched", () => {
    const home = tmp();
    try {
      const target = join(home, ".kimi-code", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      const before = 'model = "k2"\n\n  [hooks]\n  command = "mine"\n';
      writeFileSync(target, before, "utf8");
      expect(() => wireHook({ host: "kimi", home })).toThrow(UsageError);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still wires when the only [[hooks]] blocks are array-of-tables", () => {
    const home = tmp();
    try {
      const target = join(home, ".kimi-code", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      const before = '[[hooks]]\nevent = "PostToolUse"\ncommand = "other"\n';
      writeFileSync(target, before, "utf8");
      const r = wireHook({ host: "kimi", home });
      expect(r.status).toBe("wired");
      const text = readFileSync(target, "utf8");
      expect(text.startsWith(before)).toBe(true);
      expect(text.match(/\[\[hooks\]\]/g)).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("wireClaudeSettings non-object root guard", () => {
  it("refuses settings.json that is a JSON array, leaving the file byte-identical", () => {
    const home = tmp();
    try {
      const target = join(home, ".claude", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "[1, 2, 3]", "utf8");
      const before = readFileSync(target, "utf8");
      expect(() => wireHook({ host: "claude", home })).toThrow(UsageError);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses settings.json that is a JSON string or null, leaving the file byte-identical", () => {
    const home = tmp();
    try {
      const target = join(home, ".claude", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      for (const content of ['"str"', "null"]) {
        writeFileSync(target, content, "utf8");
        expect(() => wireHook({ host: "claude", home })).toThrow(UsageError);
        expect(readFileSync(target, "utf8")).toBe(content);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
