import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("host connectors packaging", () => {
  it("Codex example uses --no-install and pins 0.1.16", () => {
    const toml = readFileSync(join(root, "openai/codex.config.example.toml"), "utf8");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain("--no-install");
    expect(toml).toContain("@shield-agent/kya@0.1.16");
    expect(toml).not.toContain('"-y"');
    expect(toml).not.toMatch(/args = \[[^\]]*"-y"/);
    expect(toml).toContain("KYA_API_KEY");
    expect(toml).toContain('url = "https://shield-agent.com/mcp"');
    expect(toml).toContain("bearer_token_env_var");
  });

  it("Responses example points at hosted /mcp with Bearer placeholder", () => {
    const raw = readFileSync(join(root, "openai/responses-mcp.example.json"), "utf8");
    const j = JSON.parse(raw);
    const tool = j.tools[0];
    expect(tool.type).toBe("mcp");
    expect(tool.server_url).toBe("https://shield-agent.com/mcp");
    expect(tool.authorization).toMatch(/^Bearer /);
    expect(raw).not.toMatch(/sk_live_/);
  });

  it("Gemini settings example covers stdio and hosted httpUrl", () => {
    const j = JSON.parse(
      readFileSync(join(root, "gemini/settings.example.json"), "utf8"),
    );
    const local = j.mcpServers["shield-kya"];
    expect(local.command).toBe("npx");
    expect(local.args).toEqual([
      "--no-install",
      "@shield-agent/kya@0.1.16",
      "serve-mcp",
      "--stdio",
    ]);
    const hosted = j.mcpServers["shield-kya-hosted"];
    expect(hosted.httpUrl).toBe("https://shield-agent.com/mcp");
    expect(hosted.headers.Authorization).toContain("Bearer");
  });

  it("Grok README documents hosted URL and rejects localhost as product path", () => {
    const md = readFileSync(join(root, "grok/README.md"), "utf8");
    expect(md).toContain("https://shield-agent.com/mcp");
    expect(md.toLowerCase()).toContain("localhost");
    expect(md).toMatch(/rejects|cannot reach loopback|not something we ship/i);
    expect(md).toContain("kya.policy_evaluate");
  });
});
