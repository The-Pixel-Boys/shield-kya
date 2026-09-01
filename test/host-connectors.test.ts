import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("host connectors packaging", () => {
  it("Codex example uses --no-install, inherits API key, no inline secret", () => {
    const toml = readFileSync(join(root, "openai/codex.config.example.toml"), "utf8");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain("--no-install");
    expect(toml).toContain("@shield-agent/kya@0.1.23");
    expect(toml).not.toContain('"-y"');
    expect(toml).not.toMatch(/args = \[[^\]]*"-y"/);
    expect(toml).toContain("env_vars");
    expect(toml).toContain("KYA_API_KEY");
    expect(toml).not.toMatch(/KYA_API_KEY\s*=\s*"[^$"]+"/);
    expect(toml).toContain('url = "https://shield-agent.com/mcp"');
    expect(toml).toContain("bearer_token_env_var");
  });

  it("Responses example uses env placeholder and does not disable OpenAI-side approval", () => {
    const raw = readFileSync(join(root, "openai/responses-mcp.example.json"), "utf8");
    const j = JSON.parse(raw);
    const tool = j.tools[0];
    expect(tool.type).toBe("mcp");
    expect(tool.server_url).toBe("https://shield-agent.com/mcp");
    expect(tool.authorization).toBe("Bearer ${KYA_API_KEY}");
    expect(tool.require_approval).toBeUndefined();
    expect(tool.allowed_tools).toEqual(["kya.policy_evaluate"]);
    expect(raw).not.toMatch(/sk_live_/);
  });

  it("Gemini stdio example is stdio-only; hosted is a separate file", () => {
    const local = JSON.parse(
      readFileSync(join(root, "gemini/settings.example.json"), "utf8"),
    );
    expect(Object.keys(local.mcpServers)).toEqual(["shield-kya"]);
    expect(local.mcpServers["shield-kya"].command).toBe("npx");
    expect(local.mcpServers["shield-kya"].args).toEqual([
      "--no-install",
      "@shield-agent/kya@0.1.23",
      "serve-mcp",
      "--stdio",
    ]);
    expect(local.mcpServers["shield-kya"].trust).toBe(false);

    const hosted = JSON.parse(
      readFileSync(join(root, "gemini/settings.hosted.example.json"), "utf8"),
    );
    expect(Object.keys(hosted.mcpServers)).toEqual(["shield-kya"]);
    expect(hosted.mcpServers["shield-kya"].httpUrl).toBe("https://shield-agent.com/mcp");
    expect(hosted.mcpServers["shield-kya"].headers.Authorization).toBe(
      "Bearer ${KYA_API_KEY}",
    );
    expect(hosted.mcpServers["shield-kya"].command).toBeUndefined();
    expect(hosted.mcpServers["shield-kya"].trust).toBe(false);
  });

  it("Grok README requires Bearer on hosted URL and does not productize tunnels", () => {
    const md = readFileSync(join(root, "grok/README.md"), "utf8");
    expect(md).toContain("https://shield-agent.com/mcp");
    expect(md.toLowerCase()).toContain("localhost");
    expect(md.toLowerCase()).not.toMatch(/tunnel|ngrok|localtunnel/);
    expect(md).toContain("os.environ[\"KYA_API_KEY\"]");
    expect(md).toContain("kya.policy_evaluate");
  });
});
