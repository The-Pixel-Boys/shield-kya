import { describe, expect, it, vi } from "vitest";
import {
  buildInstallCommand,
  detectPackageManager,
  manualUpdateCommand,
  runUpdate,
  type PackageManager,
} from "../src/commands/update.js";

const cases: { path: string; expected: PackageManager }[] = [
  { path: "/Users/foo/.volta/bin/kya", expected: "volta" },
  { path: "/Users/foo/.npm/_npx/abc/node_modules/kya/dist/cli.js", expected: "npx" },
  { path: "/Users/foo/Library/pnpm/global/5/node_modules/kya/dist/cli.js", expected: "pnpm" },
  { path: "/Users/foo/.pnpm-store/v3/files/.../kya/dist/cli.js", expected: "pnpm" },
  { path: "/Users/foo/.config/yarn/global/node_modules/kya/dist/cli.js", expected: "yarn" },
  { path: "/usr/local/lib/node_modules/@shield-agent/kya/dist/cli.js", expected: "npm" },
  { path: "/opt/shield-agent/kya", expected: "unknown" },
];

describe("detectPackageManager", () => {
  it.each(cases)("detects $expected from $path", ({ path, expected }) => {
    expect(detectPackageManager(path)).toBe(expected);
  });

  it("falls back to unknown when path does not exist", () => {
    expect(detectPackageManager("/nonexistent/path")).toBe("unknown");
  });
});

describe("buildInstallCommand", () => {
  it("returns null for unknown package manager", () => {
    expect(buildInstallCommand("unknown")).toBeNull();
  });

  it("builds npm command", () => {
    expect(buildInstallCommand("npm")).toEqual({
      command: "npm",
      args: ["i", "-g", "@shield-agent/kya@latest"],
    });
  });

  it("builds pnpm command", () => {
    expect(buildInstallCommand("pnpm")).toEqual({
      command: "pnpm",
      args: ["add", "-g", "@shield-agent/kya@latest"],
    });
  });

  it("builds yarn command", () => {
    expect(buildInstallCommand("yarn")).toEqual({
      command: "yarn",
      args: ["global", "add", "@shield-agent/kya@latest"],
    });
  });

  it("builds volta command", () => {
    expect(buildInstallCommand("volta")).toEqual({
      command: "volta",
      args: ["install", "@shield-agent/kya@latest"],
    });
  });

  it("builds npx command with a hint", () => {
    const cmd = buildInstallCommand("npx");
    expect(cmd).toBeDefined();
    expect(cmd!.command).toBe("npm");
    expect(cmd!.hint).toBeDefined();
  });
});

describe("manualUpdateCommand", () => {
  it("returns the npm global install string", () => {
    expect(manualUpdateCommand()).toBe("npm i -g @shield-agent/kya@latest");
  });
});

describe("runUpdate", () => {
  it("runs the detected install command and reports success", async () => {
    const io = { log: vi.fn(), error: vi.fn() };
    const run = vi.fn().mockResolvedValue(0);
    const code = await runUpdate({
      execPath: "/usr/local/lib/node_modules/@shield-agent/kya/dist/cli.js",
      run,
      io,
    });

    expect(code).toBe(0);
    expect(run).toHaveBeenCalledWith("npm", ["i", "-g", "@shield-agent/kya@latest"]);
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("Running:"));
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("updated"));
    expect(io.error).not.toHaveBeenCalled();
  });

  it("reports failure when the install command returns non-zero", async () => {
    const io = { log: vi.fn(), error: vi.fn() };
    const run = vi.fn().mockResolvedValue(1);
    const code = await runUpdate({
      execPath: "/usr/local/lib/node_modules/@shield-agent/kya/dist/cli.js",
      run,
      io,
    });

    expect(code).toBe(1);
    expect(io.error).toHaveBeenCalledWith(expect.stringContaining("exited with code 1"));
  });

  it("prints manual fallback when package manager is unknown", async () => {
    const io = { log: vi.fn(), error: vi.fn() };
    const run = vi.fn();
    const code = await runUpdate({ execPath: "/opt/shield-agent/kya", run, io });

    expect(code).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("Could not detect"));
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("npm i -g"));
  });
});
