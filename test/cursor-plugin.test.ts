import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("Cursor marketplace plugin", () => {
  it("manifest name is kebab-case and points at public repo", () => {
    const plugin = JSON.parse(
      readFileSync(join(root, ".cursor-plugin/plugin.json"), "utf8"),
    );
    expect(plugin.name).toBe("shield-kya");
    expect(plugin.name).toMatch(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
    expect(plugin.repository).toBe(
      "https://github.com/The-Pixel-Boys/shield-kya",
    );
    expect(plugin.logo).toBe("assets/logo.svg");
    expect(plugin.variables.required).toEqual(["KYA_BASE_URL", "KYA_API_KEY"]);
  });

  it("mcp.json uses npx gate and variable placeholders only", () => {
    const mcp = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
    const server = mcp.mcpServers["shield-kya"];
    expect(server.command).toBe("npx");
    expect(server.args).toEqual([
      "--no-install",
      "@shield-agent/kya@0.1.19",
      "serve-mcp",
      "--stdio",
    ]);
    expect(server.env.KYA_BASE_URL).toBe("${KYA_BASE_URL}");
    expect(server.env.KYA_API_KEY).toBe("${KYA_API_KEY}");
    expect(JSON.stringify(server)).not.toMatch(/sk_live_|rk_live_|whsec_/);
  });

  it("ships wrap skill, sole-PEP rule, and plated logo", () => {
    const skill = readFileSync(join(root, "skills/kya-wrap/SKILL.md"), "utf8");
    const rule = readFileSync(join(root, "rules/kya-sole-pep.mdc"), "utf8");
    const logo = readFileSync(join(root, "assets/logo.svg"), "utf8");
    expect(skill).toMatch(/^---\nname: kya-wrap/m);
    expect(skill).toContain("sole PEP");
    expect(rule).toContain("alwaysApply: false");
    expect(logo).toContain('fill="#0A0A0A"');
  });
});
