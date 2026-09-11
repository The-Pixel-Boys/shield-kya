import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { runStart } from "../src/commands/start.js";

describe("kya start", () => {
  it("inits, wires MCP configs, does not hang without open", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-start-"));
    try {
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      const r = await runStart(config, { open: false });
      expect(existsSync(join(cwd, ".kya", "config.json"))).toBe(true);
      expect(r.wired.length).toBeGreaterThanOrEqual(3);
      for (const p of [".mcp.json", "mcp.json", join(".cursor", "mcp.json")]) {
        const full = join(cwd, p);
        expect(existsSync(full)).toBe(true);
        const raw = JSON.parse(readFileSync(full, "utf8")) as {
          mcpServers: { "shield-kya": { args: string[] } };
        };
        expect(raw.mcpServers["shield-kya"].args).toContain("serve-mcp");
      }
      expect(existsSync(join(cwd, ".kya", "trail.jsonl"))).toBe(true);
      expect(r.keepAlive).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
