import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("MCP registry artifacts", () => {
  it("package.json mcpName matches public server name", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
    expect(pkg.mcpName).toBe("io.github.the-pixel-boys/shield-kya");
    expect(server.name).toBe(pkg.mcpName);
    expect(pkg.version).toBe(server.version);
    expect(server.packages[0].identifier).toBe("@shield-agent/kya");
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it("server.json repository points at public shield-kya (not private monorepo)", () => {
    const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
    expect(server.repository.url).toBe(
      "https://github.com/The-Pixel-Boys/shield-kya",
    );
    expect(server.repository.url).not.toMatch(/shield-agent$/);
  });
});
