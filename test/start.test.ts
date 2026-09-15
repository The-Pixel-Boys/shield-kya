import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { runStart } from "../src/commands/start.js";
import { trailPath } from "../src/trail.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cfg(cwd: string) {
  return resolveConfig({
    cwd,
    offline: true,
    allowMissingApiKey: true,
    flags: { offline: true },
  });
}

describe("kya start", () => {
  it("inits, wires MCP configs, does not hang without open", async () => {
    const cwd = tmp("kya-start-");
    const home = tmp("kya-start-home-");
    try {
      const r = await runStart(cfg(cwd), { open: false, home });
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
      expect(existsSync(trailPath(cwd))).toBe(true);
      expect(r.reportPid).toBeUndefined();
      expect(r.next).toContain("kya stop");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("tags the wired env block with a per-host session id", async () => {
    const cwd = tmp("kya-start-");
    const home = tmp("kya-start-home-");
    try {
      await runStart(cfg(cwd), { open: false, home });
      const claude = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")) as {
        mcpServers: { "shield-kya": { env: Record<string, string> } };
      };
      expect(claude.mcpServers["shield-kya"].env.KYA_SESSION_ID).toBe(
        "mcp:claude",
      );
      const cursor = JSON.parse(
        readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
      ) as { mcpServers: { "shield-kya": { env: Record<string, string> } } };
      expect(cursor.mcpServers["shield-kya"].env.KYA_SESSION_ID).toBe(
        "mcp:cursor",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("wires user-level configs only for hosts with install evidence", async () => {
    const cwd = tmp("kya-start-");
    const home = tmp("kya-start-home-");
    try {
      // Evidence: dirs for kimi/grok/cursor, the config file itself for claude.
      mkdirSync(join(home, ".kimi-code"));
      mkdirSync(join(home, ".grok"));
      mkdirSync(join(home, ".cursor"));
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ theme: "dark" }), "utf8");
      // No evidence for qwen/kiro/opencode/etc. — they must stay unwired.

      const r = await runStart(cfg(cwd), {
        open: false,
        home,
        procs: new Set(["claude"]),
      });
      const wiredIds = r.wiredHosts.map((h) => h.host).sort();
      expect(wiredIds).toEqual(["claude", "cursor", "grok", "kimi"]);

      const claude = JSON.parse(
        readFileSync(join(home, ".claude.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(claude.theme).toBe("dark");
      expect(
        (claude.mcpServers as Record<string, unknown>)["shield-kya"],
      ).toBeDefined();
      expect(readFileSync(join(home, ".grok", "config.toml"), "utf8")).toContain(
        "[mcp_servers.shield-kya]",
      );
      expect(existsSync(join(home, ".qwen", "settings.json"))).toBe(false);
      // Reload messaging covers the wired user-level hosts.
      expect(r.next).toMatch(/claude --resume/);
      expect(r.next).toMatch(/\/mcps/);
      expect(r.next).toMatch(/Kimi Code/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is idempotent: a second run wires nothing new", async () => {
    const cwd = tmp("kya-start-");
    const home = tmp("kya-start-home-");
    try {
      mkdirSync(join(home, ".grok"));
      const first = await runStart(cfg(cwd), { open: false, home });
      expect(first.wiredHosts.map((h) => h.host)).toEqual(["grok"]);

      const second = await runStart(cfg(cwd), { open: false, home });
      expect(second.wiredHosts).toHaveLength(0);
      expect(second.wired).toHaveLength(0);
      expect(second.skipped).toContain(join(home, ".grok", "config.toml"));
      expect(second.skipped).toContain(join(cwd, ".mcp.json"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("survives a broken project config without clobbering it", async () => {
    const cwd = tmp("kya-start-");
    const home = tmp("kya-start-home-");
    try {
      writeFileSync(join(cwd, ".mcp.json"), "{ not json", "utf8");
      const r = await runStart(cfg(cwd), {
        open: false,
        home,
        procs: new Set(["claude"]),
      });
      expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe("{ not json");
      expect(r.skipped.some((s) => s.includes("not valid JSON"))).toBe(true);
      // The other project files still wire.
      expect(existsSync(join(cwd, "mcp.json"))).toBe(true);
      expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(true);
      // A host whose wiring failed must not claim a shield-kya load.
      expect(r.next).not.toMatch(/[Cc]laude/);
      expect(r.next).toContain("No restart needed"); // Cursor wired fine
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("env-level KYA_HOME alone redirects user-level wiring off the real home", async () => {
    const cwd = tmp("kya-start-");
    const fakeHome = tmp("kya-start-envhome-");
    const prev = process.env.KYA_HOME;
    process.env.KYA_HOME = fakeHome;
    try {
      mkdirSync(join(fakeHome, ".grok"));
      const r = await runStart(cfg(cwd), { open: false });
      expect(r.wiredHosts.map((h) => h.host)).toEqual(["grok"]);
      for (const h of r.wiredHosts) {
        expect(h.path.startsWith(fakeHome)).toBe(true);
      }
      expect(existsSync(join(fakeHome, ".grok", "config.toml"))).toBe(true);
      // The real home was never in play.
      expect(fakeHome.startsWith(homedir())).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KYA_HOME;
      else process.env.KYA_HOME = prev;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
