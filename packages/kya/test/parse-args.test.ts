import { describe, expect, it } from "vitest";
import { flagBool, flagInt, flagString, parseArgs } from "../src/parse-args.js";

describe("parseArgs", () => {
  it("parses command and long flags with values", () => {
    const p = parseArgs([
      "eval-tool",
      "--tool-id",
      "org.sample.never.event",
      "--args",
      '{"target":"x"}',
      "--irreversible",
    ]);
    expect(p.command).toBe("eval-tool");
    expect(flagString(p.flags, "tool-id")).toBe("org.sample.never.event");
    expect(flagString(p.flags, "args")).toBe('{"target":"x"}');
    expect(flagBool(p.flags, "irreversible")).toBe(true);
  });

  it("parses --key=value form", () => {
    const p = parseArgs(["register-agent", "--name=solo-builder", "--version-hash=abc"]);
    expect(p.command).toBe("register-agent");
    expect(flagString(p.flags, "name")).toBe("solo-builder");
    expect(flagString(p.flags, "version-hash")).toBe("abc");
  });

  it("parses boolean --stdio without value", () => {
    const p = parseArgs(["serve-mcp", "--stdio", "--port", "4000"]);
    expect(p.command).toBe("serve-mcp");
    expect(flagBool(p.flags, "stdio")).toBe(true);
    expect(flagInt(p.flags, "port", 3920)).toBe(4000);
  });

  it("parses --json machine flag", () => {
    const p = parseArgs(["eval-tool", "--tool-id", "x", "--json"]);
    expect(flagBool(p.flags, "json")).toBe(true);
  });

  it("returns undefined command when empty", () => {
    expect(parseArgs([]).command).toBeUndefined();
  });

  it("collects positionals after command", () => {
    const p = parseArgs(["init", "extra", "args"]);
    expect(p.command).toBe("init");
    expect(p.positionals).toEqual(["extra", "args"]);
  });

  it("flagString prefers first matching name", () => {
    const p = parseArgs(["x", "--toolId", "a"]);
    expect(flagString(p.flags, "tool-id", "toolId")).toBe("a");
  });
});
