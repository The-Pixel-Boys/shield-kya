import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { runConnect } from "../src/commands/connect.js";
import { gateMcpUrl } from "../src/commands/gate.js";
import { UsageError } from "../src/errors.js";

const GATE_URL = "http://127.0.0.1:3930/mcp";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-connect-gate-"));
}

function cfg(cwd: string) {
  return resolveConfig({
    cwd,
    offline: true,
    allowMissingApiKey: true,
    flags: { offline: true },
  });
}

async function wireGate(host: string, home: string, cwd: string) {
  return runConnect(cfg(cwd), { host, gateUrl: GATE_URL }, { KYA_HOME: home });
}

describe("kya connect --gate per-host shapes", () => {
  it("claude-derived hosts get an explicit {type: \"http\", url} entry", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      for (const host of ["claude", "kimi", "kiro", "copilot", "mastracode", "amp"]) {
        const r = await wireGate(host, home, cwd);
        expect(r.status, host).toBe("created");
        const raw = JSON.parse(readFileSync(r.path, "utf8")) as Record<string, unknown>;
        const rootKey = host === "amp" ? "amp.mcpServers" : "mcpServers";
        const servers = raw[rootKey] as Record<string, unknown>;
        expect(servers["shield-kya-gate"], host).toEqual({ type: "http", url: GATE_URL });
        expect(r.next).toContain("shield-kya-gate");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cursor keeps the bare url shape", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const r = await wireGate("cursor", home, cwd);
      const raw = JSON.parse(readFileSync(r.path, "utf8")) as { mcpServers: Record<string, unknown> };
      expect(raw.mcpServers["shield-kya-gate"]).toEqual({ url: GATE_URL });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("qwen uses the documented httpUrl field", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const r = await wireGate("qwen", home, cwd);
      const raw = JSON.parse(readFileSync(r.path, "utf8")) as { mcpServers: Record<string, unknown> };
      expect(raw.mcpServers["shield-kya-gate"]).toEqual({ httpUrl: GATE_URL });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("opencode-shaped hosts get a remote server block", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      for (const host of ["opencode", "kilo"]) {
        const r = await wireGate(host, home, cwd);
        expect(r.status, host).toBe("created");
        const raw = JSON.parse(readFileSync(r.path, "utf8")) as { mcp: Record<string, unknown> };
        expect(raw.mcp["shield-kya-gate"], host).toEqual({
          type: "remote",
          url: GATE_URL,
          enabled: true,
        });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("grok refuses gate wiring explicitly (remote TOML shape unverified)", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      await expect(wireGate("grok", home, cwd)).rejects.toThrow(
        /gate wiring is not supported for grok yet/,
      );
      expect(existsSync(join(home, ".grok", "config.toml"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("codex writes a [mcp_servers.shield-kya-gate] url table, idempotent with --force replace", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const first = await wireGate("codex", home, cwd);
      expect(first.status).toBe("created");
      const path = join(home, ".codex", "config.toml");
      const text = readFileSync(path, "utf8");
      expect(text).toContain("[mcp_servers.shield-kya-gate]");
      expect(text).toContain(`url = "${GATE_URL}"`);
      expect(text).not.toContain("enabled = true"); // codex has no enabled key

      const second = await wireGate("codex", home, cwd);
      expect(second.status).toBe("skipped");

      const forced = await runConnect(
        cfg(cwd),
        { host: "codex", gateUrl: "http://127.0.0.1:4000/mcp", force: true },
        { KYA_HOME: home },
      );
      expect(forced.status).toBe("wired");
      const replaced = readFileSync(path, "utf8");
      expect(replaced).toContain('url = "http://127.0.0.1:4000/mcp"');
      expect(replaced).not.toContain(GATE_URL);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("codex stdio wiring lands in ~/.codex/config.toml without an enabled key", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const r = await runConnect(cfg(cwd), { host: "codex" }, { KYA_HOME: home });
      expect(r.status).toBe("created");
      const text = readFileSync(r.path, "utf8");
      expect(text).toContain("[mcp_servers.shield-kya]");
      expect(text).toContain("serve-mcp");
      expect(text).not.toContain("enabled");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("merges beside an existing shield-kya stdio entry without touching it", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      const plain = await runConnect(cfg(cwd), { host: "qwen" }, { KYA_HOME: home });
      expect(plain.status).toBe("created");
      const gated = await wireGate("qwen", home, cwd);
      expect(gated.status).toBe("wired");
      const raw = JSON.parse(readFileSync(gated.path, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(raw.mcpServers["shield-kya"]).toBeDefined();
      expect(raw.mcpServers["shield-kya-gate"]).toEqual({ httpUrl: GATE_URL });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("gateMcpUrl falls back to the configured port when no gateway is running", () => {
    const home = tmp();
    try {
      const path = join(home, ".kya", "gateways.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ port: 4123, servers: [] }), "utf8");
      expect(gateMcpUrl({ KYA_HOME: home })).toBe("http://127.0.0.1:4123/mcp");
      expect(existsSync(join(home, ".kya", "gate-server.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("unknown host errors name the supported hosts, including codex", async () => {
    const home = tmp();
    const cwd = tmp();
    try {
      await expect(
        runConnect(cfg(cwd), { host: "emacs" }, { KYA_HOME: home }),
      ).rejects.toThrow(UsageError);
      await expect(
        runConnect(cfg(cwd), { host: "emacs" }, { KYA_HOME: home }),
      ).rejects.toThrow(/codex/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
