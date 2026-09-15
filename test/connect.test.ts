import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
      expect(entry.environment.KYA_SESSION_ID).toBe("mcp:opencode");
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

describe("kya connect claude", () => {
  it("touches only mcpServers in a big ~/.claude.json", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".claude.json");
      writeFileSync(
        target,
        JSON.stringify({
          numStartups: 42,
          theme: "dark",
          projects: { "/repo": { allowedTools: ["Bash(ls:*)"] } },
          oauthAccount: { emailAddress: "dev@example.com" },
          mcpServers: { "other-server": { command: "x", args: ["y"] } },
        }),
        "utf8",
      );
      const r = await runConnect(
        cfg(cwd),
        { host: "claude", procs: new Set(["claude"]) },
        { KYA_HOME: home },
      );
      expect(r.path).toBe(target);
      expect(r.status).toBe("wired");
      expect(r.next).toMatch(/claude --resume keeps the conversation/);

      const raw = JSON.parse(readFileSync(target, "utf8")) as Record<
        string,
        unknown
      >;
      expect(raw.numStartups).toBe(42);
      expect(raw.theme).toBe("dark");
      expect(raw.projects).toEqual({ "/repo": { allowedTools: ["Bash(ls:*)"] } });
      expect(raw.oauthAccount).toEqual({ emailAddress: "dev@example.com" });
      const servers = raw.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers["other-server"]).toEqual({ command: "x", args: ["y"] });
      const entry = servers["shield-kya"]!;
      expect(entry.args).toContain("serve-mcp");
      expect((entry.env as Record<string, string>).KYA_SESSION_ID).toBe(
        "mcp:claude",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("project scope writes <cwd>/.mcp.json", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const r = await runConnect(
        cfg(cwd),
        { host: "claude", scope: "project" },
        { KYA_HOME: home },
      );
      expect(r.path).toBe(join(cwd, ".mcp.json"));
      expect(r.status).toBe("created");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "writes through a symlinked ~/.claude.json to the resolved regular file",
    async () => {
      const home = tmp();
      const dotfiles = tmp();
      const cwd = tmp();
      try {
        const real = join(dotfiles, "claude.json");
        writeFileSync(real, JSON.stringify({ theme: "dark" }), "utf8");
        symlinkSync(real, join(home, ".claude.json"));
        const r = await runConnect(cfg(cwd), { host: "claude" }, { KYA_HOME: home });
        expect(r.status).toBe("wired");
        const raw = JSON.parse(readFileSync(real, "utf8")) as Record<string, unknown>;
        expect(raw.theme).toBe("dark");
        expect(
          (raw.mcpServers as Record<string, unknown>)["shield-kya"],
        ).toBeDefined();
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(dotfiles, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to write when ~/.claude.json resolves to a non-regular file",
    async () => {
      const home = tmp();
      const cwd = tmp();
      try {
        mkdirSync(join(home, ".claude.json.dir"));
        symlinkSync(join(home, ".claude.json.dir"), join(home, ".claude.json"));
        await expect(
          runConnect(cfg(cwd), { host: "claude" }, { KYA_HOME: home }),
        ).rejects.toThrow(/regular file/);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("writes atomically: no *.kya-tmp* file remains, content correct", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".claude.json");
      writeFileSync(target, JSON.stringify({ theme: "dark" }), "utf8");
      await runConnect(cfg(cwd), { host: "claude" }, { KYA_HOME: home });
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(home).filter((f) => f.includes("kya-tmp"))).toEqual([]);
      const raw = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
      expect(raw.theme).toBe("dark");
      expect(
        (raw.mcpServers as Record<string, unknown>)["shield-kya"],
      ).toBeDefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves the original file mode across the atomic write",
    async () => {
      const home = tmp();
      const cwd = tmp();
      try {
        const target = join(home, ".claude.json");
        writeFileSync(target, JSON.stringify({ theme: "dark" }), "utf8");
        const { chmodSync, statSync } = await import("node:fs");
        chmodSync(target, 0o600);
        await runConnect(cfg(cwd), { host: "claude" }, { KYA_HOME: home });
        expect(statSync(target).mode & 0o777).toBe(0o600);
        const raw = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
        expect(
          (raw.mcpServers as Record<string, unknown>)["shield-kya"],
        ).toBeDefined();
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "create path materializes a dangling symlink's target, keeping the link",
    async () => {
      const home = tmp();
      const cwd = tmp();
      try {
        // Relative dangling link: resolution is against the link's dir, and
        // the missing parent dir must be created.
        const linkPath = join(home, ".claude.json");
        const realPath = join(home, "dotfiles", "claude.json");
        symlinkSync(join("dotfiles", "claude.json"), linkPath);
        const r = await runConnect(cfg(cwd), { host: "claude" }, { KYA_HOME: home });
        expect(r.status).toBe("created");
        const { lstatSync, readlinkSync } = await import("node:fs");
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(linkPath)).toBe(join("dotfiles", "claude.json"));
        const raw = JSON.parse(readFileSync(realPath, "utf8")) as Record<
          string,
          unknown
        >;
        expect(
          (raw.mcpServers as Record<string, unknown>)["shield-kya"],
        ).toBeDefined();
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it("treats an existing shield-kya key (even null) as wired — no overwrite without --force", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".claude.json");
      const before = JSON.stringify({ mcpServers: { "shield-kya": null } }) + "\n";
      writeFileSync(target, before, "utf8");
      const r = await runConnect(cfg(cwd), { host: "claude" }, { KYA_HOME: home });
      expect(r.status).toBe("skipped");
      expect(readFileSync(target, "utf8")).toBe(before);

      const forced = await runConnect(
        cfg(cwd),
        { host: "claude", force: true },
        { KYA_HOME: home },
      );
      expect(forced.status).toBe("wired");
      const raw = JSON.parse(readFileSync(target, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(raw.mcpServers["shield-kya"]).not.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("kya connect grok", () => {
  const header = "[mcp_servers.shield-kya]";

  it("creates ~/.grok/config.toml with the shield-kya table", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const r = await runConnect(cfg(cwd), { host: "grok" }, { KYA_HOME: home });
      expect(r.path).toBe(join(home, ".grok", "config.toml"));
      expect(r.status).toBe("created");
      expect(r.next).toMatch(/\/mcps/);
      const text = readFileSync(r.path, "utf8");
      expect(text).toContain(header);
      expect(text).toMatch(/command = ".+"/);
      expect(text).toMatch(/args = \[".+", "serve-mcp", "--stdio"\]/);
      expect(text).toContain(
        'env = { KYA_HOST = "ide", KYA_OFFLINE = "1", KYA_SESSION_ID = "mcp:grok" }',
      );
      expect(text).toContain("enabled = true");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("appends to an existing config.toml and preserves its content", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".grok", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      const before = '[defaults]\nmodel = "grok-4"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
      writeFileSync(target, before, "utf8");
      const r = await runConnect(cfg(cwd), { host: "grok" }, { KYA_HOME: home });
      expect(r.status).toBe("wired");
      const text = readFileSync(target, "utf8");
      expect(text.startsWith(before)).toBe(true);
      expect(text).toContain(header);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is idempotent: second run skips, --force replaces just the table", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      await runConnect(cfg(cwd), { host: "grok" }, { KYA_HOME: home });
      const target = join(home, ".grok", "config.toml");
      const once = readFileSync(target, "utf8");

      const second = await runConnect(cfg(cwd), { host: "grok" }, { KYA_HOME: home });
      expect(second.status).toBe("skipped");
      expect(readFileSync(target, "utf8")).toBe(once);

      // Corrupt the table, add a neighbouring table, then force-replace.
      writeFileSync(
        target,
        `${once.replace("enabled = true", "enabled = false")}[mcp_servers.other]\ncommand = "x"\n`,
        "utf8",
      );
      const forced = await runConnect(
        cfg(cwd),
        { host: "grok", force: true },
        { KYA_HOME: home },
      );
      expect(forced.status).toBe("wired");
      const text = readFileSync(target, "utf8");
      expect(text.match(/\[mcp_servers\.shield-kya\]/g)).toHaveLength(1);
      expect(text).toContain("enabled = true");
      expect(text).toContain("[mcp_servers.other]\ncommand = \"x\"");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses an inline shield-kya definition it cannot merge as text", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".grok", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      const before = '[mcp_servers]\nshield-kya = { command = "old" }\n';
      writeFileSync(target, before, "utf8");
      await expect(
        runConnect(cfg(cwd), { host: "grok" }, { KYA_HOME: home }),
      ).rejects.toThrow(/inline/);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses a quoted [mcp_servers.\"shield-kya\"] header instead of duplicating it", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const target = join(home, ".grok", "config.toml");
      mkdirSync(dirname(target), { recursive: true });
      const before = '[mcp_servers."shield-kya"]\ncommand = "old"\n';
      writeFileSync(target, before, "utf8");
      await expect(
        runConnect(cfg(cwd), { host: "grok" }, { KYA_HOME: home }),
      ).rejects.toThrow(/quoted/);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes the TOML atomically: no *.kya-tmp* file remains", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      mkdirSync(join(home, ".grok"), { recursive: true });
      const r = await runConnect(cfg(cwd), { host: "grok" }, { KYA_HOME: home });
      expect(r.status).toBe("created");
      const { readdirSync } = await import("node:fs");
      expect(
        readdirSync(join(home, ".grok")).filter((f) => f.includes("kya-tmp")),
      ).toEqual([]);
      expect(readFileSync(r.path, "utf8")).toContain(header);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("has no project scope", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      await expect(
        runConnect(cfg(cwd), { host: "grok", scope: "project" }, { KYA_HOME: home }),
      ).rejects.toThrow(/no project-scope config/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
