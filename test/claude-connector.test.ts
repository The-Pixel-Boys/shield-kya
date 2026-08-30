import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, unknown>;
}

describe("Claude connector packaging", () => {
  it("mcp.json and Claude examples use npx stdio with placeholders only", () => {
    for (const path of [
      "mcp.json",
      ".mcp.json",
      "claude/claude_desktop_config.example.json",
    ]) {
      const raw = readFileSync(join(root, path), "utf8");
      expect(raw).not.toMatch(/sk_live_|rk_live_|whsec_/);
      const mcp = JSON.parse(raw) as {
        mcpServers: { "shield-kya": { command: string; args: string[]; env: Record<string, string> } };
      };
      const server = mcp.mcpServers["shield-kya"];
      expect(server.command).toBe("npx");
      expect(server.args).toContain("--no-install");
      expect(server.args).not.toContain("-y");
      expect(server.args).toContain("@shield-agent/kya@0.1.18");
      expect(server.args).toContain("serve-mcp");
      expect(server.args).toContain("--stdio");
      expect(server.env.KYA_BASE_URL).toBeTruthy();
      expect(server.env.KYA_API_KEY).toContain("KYA_API_KEY");
    }
  });

  it("MCPB manifest launches packed dist/cli.js with user_config for base URL and API key", () => {
    const manifest = readJson("manifest.json") as {
      manifest_version: string;
      name: string;
      server: { mcp_config: { command: string; args: string[]; env: Record<string, string> } };
      user_config: Record<string, { sensitive?: boolean; required?: boolean }>;
      tools: { name: string }[];
    };
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe("shield-kya");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toEqual([
      "${__dirname}/dist/cli.js",
      "serve-mcp",
      "--stdio",
    ]);
    expect(manifest.user_config.api_key.sensitive).toBe(true);
    expect(manifest.user_config.api_key.required).toBe(true);
    expect(manifest.user_config.base_url.required).toBe(true);
    expect(manifest.tools.map((t) => t.name).sort()).toEqual([
      "kya.policy_evaluate",
      "kya.request_approval",
      "kya.session_ingest",
    ]);
  });
});
