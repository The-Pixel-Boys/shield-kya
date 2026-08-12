import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initFromArgs, runInit } from "../src/commands/init.js";
import { parseArgs } from "../src/parse-args.js";
import { SAMPLE_TOOLS } from "../src/sample-tools.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-init-"));
  dirs.push(d);
  return d;
}

describe("init", () => {
  it("creates .kya/config.json, tools.sample.json, .env.example", () => {
    const cwd = tmp();
    const result = runInit({
      cwd,
      baseUrl: "https://api.example.com",
      host: "ide",
    });
    expect(result.created).toHaveLength(3);
    expect(existsSync(result.configPath)).toBe(true);
    expect(existsSync(result.toolsPath)).toBe(true);
    expect(existsSync(result.envExamplePath)).toBe(true);

    const cfg = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(cfg.baseUrl).toBe("https://api.example.com");
    expect(cfg.host).toBe("ide");

    const tools = JSON.parse(readFileSync(result.toolsPath, "utf8"));
    expect(tools.packsRequired).toBe(false);
    expect(tools.tools).toHaveLength(SAMPLE_TOOLS.length);
    expect(tools.tools.map((t: { toolId: string }) => t.toolId)).toContain(
      "org.sample.never.event",
    );

    const envEx = readFileSync(result.envExamplePath, "utf8");
    expect(envEx).toContain("KYA_BASE_URL");
    expect(envEx).toContain("KYA_API_KEY");
    expect(envEx).toContain("KYA_HOST");
    expect(envEx).toContain("KYA_MCP_PORT");
  });

  it("skips existing files unless --force", () => {
    const cwd = tmp();
    runInit({ cwd });
    const second = runInit({ cwd });
    expect(second.skipped.length).toBeGreaterThan(0);
    expect(second.created).toHaveLength(0);

    const forced = runInit({ cwd, force: true, baseUrl: "http://forced" });
    expect(forced.created.length).toBeGreaterThan(0);
    const cfg = JSON.parse(
      readFileSync(join(cwd, ".kya", "config.json"), "utf8"),
    );
    expect(cfg.baseUrl).toBe("http://forced");
  });

  it("initFromArgs reads --base-url and --host", () => {
    const cwd = tmp();
    const parsed = parseArgs([
      "init",
      "--base-url",
      "http://127.0.0.1:8090",
      "--host",
      "runtime",
    ]);
    const result = initFromArgs(parsed, cwd);
    const cfg = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(cfg.host).toBe("runtime");
  });
});
