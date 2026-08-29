import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readFileConfig,
  resolveConfig,
  writeFileConfig,
} from "../src/config.js";
import { AuthRequiredError, UsageError } from "../src/errors.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-cfg-"));
  dirs.push(d);
  return d;
}

describe("resolveConfig fail-closed", () => {
  it("throws AuthRequiredError when API key empty (network cmds)", () => {
    const cwd = tmp();
    expect(() =>
      resolveConfig({
        cwd,
        env: { KYA_BASE_URL: "http://127.0.0.1:8090", KYA_API_KEY: "" },
        requireApiKey: true,
      }),
    ).toThrow(AuthRequiredError);
  });

  it("throws when API key missing entirely", () => {
    const cwd = tmp();
    expect(() =>
      resolveConfig({
        cwd,
        env: { KYA_BASE_URL: "http://127.0.0.1:8090" },
        requireApiKey: true,
      }),
    ).toThrow(/KYA_API_KEY/);
  });

  it("allows missing key when allowMissingApiKey", () => {
    const cwd = tmp();
    const cfg = resolveConfig({
      cwd,
      env: { KYA_BASE_URL: "http://example.com" },
      allowMissingApiKey: true,
      requireApiKey: false,
    });
    expect(cfg.baseUrl).toBe("http://example.com");
    expect(cfg.apiKey).toBe("");
    expect(cfg.offline).toBe(false);
  });

  it("allows missing key in offline mode", () => {
    const cwd = tmp();
    const cfg = resolveConfig({
      cwd,
      env: {},
      offline: true,
      flags: { offline: true },
    });
    expect(cfg.offline).toBe(true);
    expect(cfg.apiKey).toBe("");
  });

  it("prefers flags over env over file", () => {
    const cwd = tmp();
    writeFileConfig(cwd, { baseUrl: "http://file", host: "runtime", agentId: "file-agent" });
    const cfg = resolveConfig({
      cwd,
      env: {
        KYA_BASE_URL: "http://env",
        KYA_API_KEY: "sk_env",
        KYA_HOST: "ide",
        KYA_AGENT_ID: "env-agent",
        KYA_MCP_PORT: "3911",
      },
      flags: {
        "base-url": "http://flag",
        "api-key": "sk_flag",
        host: "runtime",
        "agent-id": "flag-agent",
        port: "3999",
        json: true,
      },
      requireApiKey: true,
    });
    expect(cfg.baseUrl).toBe("http://flag");
    expect(cfg.apiKey).toBe("sk_flag");
    expect(cfg.host).toBe("runtime");
    expect(cfg.agentId).toBe("flag-agent");
    expect(cfg.mcpPort).toBe(3999);
    expect(cfg.json).toBe(true);
  });

  it("rejects invalid host", () => {
    const cwd = tmp();
    expect(() =>
      resolveConfig({
        cwd,
        env: { KYA_API_KEY: "sk", KYA_HOST: "laptop" },
        requireApiKey: true,
      }),
    ).toThrow(UsageError);
  });

  it("ignores non-loopback file baseUrl so a cloned repo cannot steal KYA_API_KEY", () => {
    const cwd = tmp();
    writeFileConfig(cwd, { baseUrl: "http://attacker.example" });
    const cfg = resolveConfig({
      cwd,
      env: { KYA_API_KEY: "sk_env" },
      requireApiKey: true,
    });
    expect(cfg.baseUrl).toBe("http://127.0.0.1:8090");
  });

  it("round-trips file config", () => {
    const cwd = tmp();
    writeFileConfig(cwd, { baseUrl: "http://x", host: "ide", agentId: "a1" });
    expect(readFileConfig(cwd)).toMatchObject({
      baseUrl: "http://x",
      host: "ide",
      agentId: "a1",
    });
  });
});
