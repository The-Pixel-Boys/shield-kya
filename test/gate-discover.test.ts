import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverGateServers,
  importGateCandidates,
  removeHostServerEntries,
  sanitizeServerId,
} from "../src/gate/discover.js";
import { readGateways, validateGateways } from "../src/gate/config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-discover-"));
}

function env(home: string): NodeJS.ProcessEnv {
  return { KYA_HOME: home };
}

function writeJson(path: string, doc: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
}

describe("sanitizeServerId", () => {
  it("normalizes to the gateway target-id shape", () => {
    expect(sanitizeServerId("github")).toBe("github");
    expect(sanitizeServerId("My_Server")).toBe("my-server");
    expect(sanitizeServerId("Brave Search")).toBe("brave-search");
    expect(sanitizeServerId("-weird-")).toBe("weird");
    expect(sanitizeServerId("___")).toBeUndefined();
  });

  it("rejects kya-prefixed ids even after sanitization", () => {
    expect(sanitizeServerId("shield-kya")).toBeUndefined();
    expect(sanitizeServerId("Shield-KYA-Gate")).toBeUndefined();
    expect(sanitizeServerId("kya")).toBeUndefined();
    expect(sanitizeServerId("kya tools")).toBeUndefined();
  });
});

describe("discoverGateServers", () => {
  it("discovers JSON stdio entries with args and env", () => {
    const home = tmp();
    try {
      writeJson(join(home, ".claude.json"), {
        mcpServers: {
          github: { command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "x" } },
        },
      });
      const found = discoverGateServers(home);
      expect(found).toEqual([
        {
          id: "github",
          transport: "stdio",
          cmd: ["npx", "-y", "gh-mcp"],
          env: { GH_TOKEN: "x" },
          foundIn: ["claude"],
        },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("discovers the JSON url shapes (bare url, type:http, httpUrl)", () => {
    const home = tmp();
    try {
      writeJson(join(home, ".cursor", "mcp.json"), {
        mcpServers: { context7: { url: "https://mcp.context7.com/mcp" } },
      });
      writeJson(join(home, ".kimi-code", "mcp.json"), {
        mcpServers: { exa: { type: "http", url: "https://mcp.exa.ai/mcp" } },
      });
      writeJson(join(home, ".qwen", "settings.json"), {
        mcpServers: { figma: { httpUrl: "https://mcp.figma.com/mcp" } },
      });
      const found = discoverGateServers(home);
      const byId = new Map(found.map((c) => [c.id, c]));
      expect(byId.get("context7")).toMatchObject({
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        foundIn: ["cursor"],
      });
      expect(byId.get("exa")).toMatchObject({ transport: "http", foundIn: ["kimi"] });
      expect(byId.get("figma")).toMatchObject({ transport: "http", foundIn: ["qwen"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("discovers opencode-shaped array commands and remote entries", () => {
    const home = tmp();
    try {
      writeJson(join(home, ".config", "opencode", "opencode.json"), {
        mcp: {
          filesystem: { type: "local", command: ["bun", "x", "fs-mcp"], enabled: true },
          notion: { type: "remote", url: "https://mcp.notion.com/mcp", enabled: true },
        },
      });
      const found = discoverGateServers(home);
      const byId = new Map(found.map((c) => [c.id, c]));
      expect(byId.get("filesystem")).toMatchObject({
        transport: "stdio",
        cmd: ["bun", "x", "fs-mcp"],
      });
      expect(byId.get("notion")).toMatchObject({
        transport: "http",
        url: "https://mcp.notion.com/mcp",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("discovers TOML command and url tables (grok/codex)", () => {
    const home = tmp();
    try {
      mkdirSync(join(home, ".grok"), { recursive: true });
      writeFileSync(
        join(home, ".grok", "config.toml"),
        [
          "[mcp_servers.filesystem]",
          'command = "npx"',
          'args = ["-y", "@modelcontextprotocol/server-filesystem", "."]',
          'env = { ROOT = "/tmp" }',
          "enabled = true",
          "",
          "[mcp_servers.context7]",
          'url = "https://mcp.context7.com/mcp"',
          "",
        ].join("\n"),
        "utf8",
      );
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(
        join(home, ".codex", "config.toml"),
        ['[mcp_servers.exa]', 'url = "https://mcp.exa.ai/mcp"', ""].join("\n"),
        "utf8",
      );
      const found = discoverGateServers(home);
      const byId = new Map(found.map((c) => [c.id, c]));
      expect(byId.get("filesystem")).toMatchObject({
        transport: "stdio",
        cmd: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
        env: { ROOT: "/tmp" },
        foundIn: ["grok"],
      });
      expect(byId.get("context7")).toMatchObject({ transport: "http", foundIn: ["grok"] });
      expect(byId.get("exa")).toMatchObject({ transport: "http", foundIn: ["codex"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("excludes shield-kya/kya-prefixed entries", () => {
    const home = tmp();
    try {
      writeJson(join(home, ".claude.json"), {
        mcpServers: {
          "shield-kya": { command: "node", args: ["cli.js", "serve-mcp"] },
          "shield-kya-gate": { type: "http", url: "http://127.0.0.1:3930/mcp" },
          kya: { command: "kya" },
          github: { command: "npx", args: ["gh-mcp"] },
        },
      });
      const found = discoverGateServers(home);
      expect(found.map((c) => c.id)).toEqual(["github"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("dedupes the same server across hosts into one candidate", () => {
    const home = tmp();
    try {
      const entry = { command: "npx", args: ["-y", "gh-mcp"] };
      writeJson(join(home, ".claude.json"), { mcpServers: { github: entry } });
      writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { GitHub: entry } });
      const found = discoverGateServers(home);
      expect(found).toHaveLength(1);
      expect(found[0]!.id).toBe("github");
      expect(found[0]!.foundIn).toEqual(["claude", "cursor"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips an unparseable host config silently and keeps the rest", () => {
    const home = tmp();
    try {
      writeFileSync(join(home, ".claude.json"), "{ not json", "utf8");
      writeJson(join(home, ".cursor", "mcp.json"), {
        mcpServers: { github: { command: "npx", args: ["gh-mcp"] } },
      });
      const found = discoverGateServers(home);
      expect(found.map((c) => c.id)).toEqual(["github"]);
      expect(found[0]!.foundIn).toEqual(["cursor"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("importGateCandidates", () => {
  it("merges candidates into gateways.json, preserving hand-configured entries", () => {
    const home = tmp();
    try {
      const path = join(home, ".kya", "gateways.json");
      writeJson(path, {
        port: 3930,
        servers: [{ id: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" }],
        recipes: [{ id: "keep-me" }],
      });
      const r = importGateCandidates(
        [
          { id: "github", transport: "stdio", cmd: ["npx", "gh-mcp"], foundIn: ["claude"] },
          { id: "exa", transport: "http", url: "https://mcp.exa.ai/mcp", foundIn: ["cursor", "qwen"] },
        ],
        env(home),
      );
      expect(r.imported.map((s) => s.id)).toEqual(["github", "exa"]);
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        servers: Array<Record<string, unknown>>;
        recipes: unknown;
      };
      expect(raw.recipes).toEqual([{ id: "keep-me" }]);
      expect(raw.servers[0]).toEqual({ id: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" });
      expect(raw.servers[1]).toMatchObject({ id: "github", importedFrom: ["claude"] });
      expect(raw.servers[2]).toMatchObject({ id: "exa", importedFrom: ["cursor", "qwen"] });
      // The validated config tolerates importedFrom.
      const cfg = readGateways(env(home));
      expect(cfg.servers.map((s) => s.id)).toEqual(["sentry", "github", "exa"]);
      expect(cfg.servers[1]!.importedFrom).toEqual(["claude"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips ids already present and unions new hosts into an existing importedFrom", () => {
    const home = tmp();
    try {
      const path = join(home, ".kya", "gateways.json");
      writeJson(path, {
        servers: [
          { id: "github", transport: "stdio", cmd: ["npx", "gh-mcp"], importedFrom: ["claude"] },
          { id: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" },
        ],
      });
      const r = importGateCandidates(
        [
          { id: "github", transport: "stdio", cmd: ["npx", "gh-mcp"], foundIn: ["cursor"] },
          { id: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp", foundIn: ["cursor"] },
        ],
        env(home),
      );
      expect(r.imported).toEqual([]);
      const raw = JSON.parse(readFileSync(path, "utf8")) as { servers: Array<Record<string, unknown>> };
      // Auto-imported entry picks up the new host; the hand-configured one is untouched.
      expect(raw.servers[0]!["importedFrom"]).toEqual(["claude", "cursor"]);
      expect(raw.servers[1]).toEqual({ id: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("validateGateways tolerates importedFrom and rejects malformed values", () => {
    const cfg = validateGateways({
      servers: [{ id: "github", transport: "stdio", cmd: ["npx"], importedFrom: ["claude"] }],
    });
    expect(cfg.servers[0]!.importedFrom).toEqual(["claude"]);
    expect(() =>
      validateGateways({
        servers: [{ id: "github", transport: "stdio", cmd: ["npx"], importedFrom: "claude" }],
      }),
    ).toThrow(/importedFrom/);
  });
});

describe("removeHostServerEntries", () => {
  it("backs up a JSON host config and removes only the listed ids", () => {
    const home = tmp();
    try {
      const path = join(home, ".claude.json");
      writeJson(path, {
        theme: "dark",
        mcpServers: {
          "shield-kya": { command: "node", args: ["serve-mcp"] },
          "shield-kya-gate": { type: "http", url: "http://127.0.0.1:3930/mcp" },
          github: { command: "npx", args: ["gh-mcp"] },
          filesystem: { command: "npx", args: ["fs-mcp"] },
        },
      });
      const r = removeHostServerEntries({
        host: "claude",
        ids: ["github"],
        home,
        env: env(home),
        ts: "2026-09-28T10-00-00",
      });
      expect(r).toBeDefined();
      expect(r!.removed).toEqual(["github"]);
      const backup = JSON.parse(readFileSync(r!.backup, "utf8")) as Record<string, unknown>;
      expect(backup).toMatchObject({ theme: "dark" });
      expect(r!.backup).toContain(join(".kya", "backups"));
      const after = JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(after.mcpServers).sort()).toEqual([
        "filesystem",
        "shield-kya",
        "shield-kya-gate",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("backs up a TOML host config and slices out only the listed tables", () => {
    const home = tmp();
    try {
      mkdirSync(join(home, ".grok"), { recursive: true });
      const path = join(home, ".grok", "config.toml");
      const text = [
        "[mcp_servers.shield-kya]",
        'command = "node"',
        "",
        "[mcp_servers.github]",
        'command = "npx"',
        'args = ["gh-mcp"]',
        "",
        "[mcp_servers.filesystem]",
        'command = "bun"',
        "",
      ].join("\n");
      writeFileSync(path, text, "utf8");
      const r = removeHostServerEntries({
        host: "grok",
        ids: ["github"],
        home,
        env: env(home),
        ts: "2026-09-28T10-00-00",
      });
      expect(r!.removed).toEqual(["github"]);
      expect(readFileSync(r!.backup, "utf8")).toBe(text);
      const after = readFileSync(path, "utf8");
      expect(after).toContain("[mcp_servers.shield-kya]");
      expect(after).toContain("[mcp_servers.filesystem]");
      expect(after).not.toContain("github");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns undefined for an unparseable host config and touches nothing", () => {
    const home = tmp();
    try {
      const path = join(home, ".claude.json");
      writeFileSync(path, "{ not json", "utf8");
      const r = removeHostServerEntries({ host: "claude", ids: ["github"], home, env: env(home) });
      expect(r).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe("{ not json");
      expect(existsSync(join(home, ".kya", "backups"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
