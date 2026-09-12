import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};
const pin = `@shield-agent/kya@${pkg.version}`;

describe("host connectors packaging", () => {
  it("Codex example uses --no-install, inherits API key, no inline secret", () => {
    const toml = readFileSync(join(root, "openai/codex.config.example.toml"), "utf8");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain("--no-install");
    expect(toml).toContain(pin);
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
      pin,
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

describe("new host examples (herdr parity)", () => {
  const stdioExamples: ReadonlyArray<readonly [string, string, "standard" | "opencode"]> = [
    ["opencode/opencode.example.json", "mcp", "opencode"],
    ["kilo/kilo.example.json", "mcp", "opencode"],
    ["kiro/mcp.example.json", "mcpServers", "standard"],
    ["qwen/settings.example.json", "mcpServers", "standard"],
    ["kimi/mcp.example.json", "mcpServers", "standard"],
    ["mastracode/mcp.example.json", "mcpServers", "standard"],
    ["amp/settings.example.json", "amp.mcpServers", "standard"],
    ["copilot/mcp-config.example.json", "mcpServers", "standard"],
    ["cline/cline_mcp_settings.example.json", "mcpServers", "standard"],
    ["droid/mcp.example.json", "mcpServers", "standard"],
  ];

  for (const [file, rootKey, shape] of stdioExamples) {
    it(`${file}: parses, pins ${pin}, no secrets, correct dialect`, () => {
      const raw = readFileSync(join(root, file), "utf8");
      expect(raw).not.toMatch(/sk_live_|rk_live_|whsec_/);
      expect(raw).toContain(pin);
      const j = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(Object.keys(j[rootKey] ?? {})).toEqual(["shield-kya"]);
      const entry = (j[rootKey] as Record<string, Record<string, unknown>>)[
        "shield-kya"
      ]!;
      if (shape === "opencode") {
        expect(entry["type"]).toBe("local");
        expect(entry["command"]).toEqual([
          "npx",
          "--no-install",
          pin,
          "serve-mcp",
          "--stdio",
        ]);
        expect(entry["enabled"]).toBe(true);
        const env = entry["environment"] as Record<string, string>;
        expect(env["KYA_API_KEY"]).toBe("${KYA_API_KEY}");
      } else {
        expect(entry["command"]).toBe("npx");
        expect(entry["args"]).toEqual([
          "--no-install",
          pin,
          "serve-mcp",
          "--stdio",
        ]);
        const env = entry["env"] as Record<string, string>;
        expect(env["KYA_API_KEY"]).toBe("${KYA_API_KEY}");
        expect(env["KYA_BASE_URL"]).toBe("https://shield-agent.com");
      }
    });
  }

  it("qwen hosted example is HTTP-only with Bearer placeholder", () => {
    const raw = readFileSync(join(root, "qwen/settings.hosted.example.json"), "utf8");
    expect(raw).not.toMatch(/sk_live_|rk_live_|whsec_/);
    const j = JSON.parse(raw) as {
      mcpServers: { "shield-kya": Record<string, unknown> };
    };
    const entry = j.mcpServers["shield-kya"];
    expect(entry["httpUrl"]).toBe("https://shield-agent.com/mcp");
    expect((entry["headers"] as Record<string, string>)["Authorization"]).toBe(
      "Bearer ${KYA_API_KEY}",
    );
    expect(entry["command"]).toBeUndefined();
  });

  it("every connectable host ships a matching example dir README", () => {
    for (const dir of [
      "opencode",
      "kilo",
      "kiro",
      "qwen",
      "kimi",
      "mastracode",
      "amp",
      "copilot",
      "cline",
      "droid",
    ]) {
      const md = readFileSync(join(root, dir, "README.md"), "utf8");
      expect(md.length, dir).toBeGreaterThan(0);
      expect(md, dir).toContain(`docs/hosts/${dir}.md`);
    }
  });
});
