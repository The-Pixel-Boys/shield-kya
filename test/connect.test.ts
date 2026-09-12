import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "../src/config.js";
import {
  connectableHosts,
  knownHosts,
  runConnect,
} from "../src/commands/connect.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-connect-"));
}

function cfg(cwd: string) {
  return resolveConfig({
    cwd,
    offline: true,
    allowMissingApiKey: true,
    flags: { offline: true },
  });
}

describe("kya connect", () => {
  it("creates a global config for every connectable host", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      for (const host of connectableHosts()) {
        const r = await runConnect(cfg(cwd), { host }, { KYA_HOME: home });
        expect(r.status, host).toBe("created");
        expect(existsSync(r.path), host).toBe(true);
        const raw = readFileSync(r.path, "utf8");
        expect(raw).toContain("shield-kya");
        expect(raw).toContain("serve-mcp");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent: second run skips, --force rewires", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const first = await runConnect(cfg(cwd), { host: "qwen" }, { KYA_HOME: home });
      expect(first.status).toBe("created");
      const second = await runConnect(cfg(cwd), { host: "qwen" }, { KYA_HOME: home });
      expect(second.status).toBe("skipped");
      const forced = await runConnect(
        cfg(cwd),
        { host: "qwen", force: true },
        { KYA_HOME: home },
      );
      expect(forced.status).toBe("wired");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("merges into an existing config and preserves other keys and servers", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".qwen", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        JSON.stringify({
          theme: "dark",
          mcpServers: { "other-server": { command: "x" } },
        }),
        "utf8",
      );
      const r = await runConnect(cfg(cwd), { host: "qwen" }, { KYA_HOME: home });
      expect(r.status).toBe("wired");
      const raw = JSON.parse(readFileSync(target, "utf8")) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(raw.theme).toBe("dark");
      expect(raw.mcpServers["other-server"]).toEqual({ command: "x" });
      expect(raw.mcpServers["shield-kya"]).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes the opencode dialect: mcp root, type local, command array", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const r = await runConnect(cfg(cwd), { host: "opencode" }, { KYA_HOME: home });
      const raw = JSON.parse(readFileSync(r.path, "utf8")) as {
        mcp: {
          "shield-kya": {
            type: string;
            command: string[];
            enabled: boolean;
            environment: Record<string, string>;
          };
        };
      };
      const entry = raw.mcp["shield-kya"];
      expect(entry.type).toBe("local");
      expect(Array.isArray(entry.command)).toBe(true);
      expect(entry.command.slice(-2)).toEqual(["serve-mcp", "--stdio"]);
      expect(entry.enabled).toBe(true);
      expect(entry.environment.KYA_OFFLINE).toBe("1");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes amp under the prefixed amp.mcpServers root key", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const r = await runConnect(cfg(cwd), { host: "amp" }, { KYA_HOME: home });
      const raw = JSON.parse(readFileSync(r.path, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(raw["amp.mcpServers"]?.["shield-kya"]).toBeDefined();
      expect(raw["mcpServers"]).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("project scope writes into the cwd for hosts that support it", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const r = await runConnect(
        cfg(cwd),
        { host: "kimi", scope: "project" },
        { KYA_HOME: home },
      );
      expect(r.path).toBe(join(cwd, ".kimi-code", "mcp.json"));
      expect(existsSync(r.path)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects project scope for hosts without a project config", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      await expect(
        runConnect(cfg(cwd), { host: "amp", scope: "project" }, { KYA_HOME: home }),
      ).rejects.toThrow(/no project-scope config/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("points recipe-only hosts at their docs page instead of wiring", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      await expect(
        runConnect(cfg(cwd), { host: "cline" }, { KYA_HOME: home }),
      ).rejects.toThrow(/docs\/hosts\/cline\.md/);
      await expect(
        runConnect(cfg(cwd), { host: "droid" }, { KYA_HOME: home }),
      ).rejects.toThrow(/docs\/hosts\/droid\.md/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown hosts and lists the supported set", async () => {
    const cwd = tmp();
    try {
      await expect(
        runConnect(cfg(cwd), { host: "not-a-host" }, { KYA_HOME: tmp() }),
      ).rejects.toThrow(new RegExp(knownHosts().join(", ")));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("never clobbers a config it cannot parse", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".qwen", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "{ not json", "utf8");
      await expect(
        runConnect(cfg(cwd), { host: "qwen" }, { KYA_HOME: home }),
      ).rejects.toThrow(/not valid JSON/);
      expect(readFileSync(target, "utf8")).toBe("{ not json");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a non-object root key rather than clobbering it", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".qwen", "settings.json");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ mcpServers: ["oops"] }), "utf8");
      await expect(
        runConnect(cfg(cwd), { host: "qwen" }, { KYA_HOME: home }),
      ).rejects.toThrow(/not an object/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
