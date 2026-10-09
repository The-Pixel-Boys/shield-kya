import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "../src/config.js";
import { runStart } from "../src/commands/start.js";
import type { EnsureBinaryResult } from "../src/gate/binary.js";
import type { GateRunResult } from "../src/commands/gate.js";

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

function writeJson(path: string, doc: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
}

const GATE_URL = "http://127.0.0.1:3930";

function fakeGateDeps(calls: { ensure: number; run: number }, opts: { ensureFails?: boolean } = {}) {
  return {
    ensureBinary: async (): Promise<EnsureBinaryResult> => {
      calls.ensure++;
      if (opts.ensureFails) throw new Error("network unreachable");
      return { path: "/fake/kya-gate", installed: true, version: "1.5.0" };
    },
    runGate: async (): Promise<GateRunResult> => {
      calls.run++;
      return {
        pid: 424242,
        url: GATE_URL,
        port: 3930,
        otlpPort: 3931,
        servers: [],
        configPath: "/fake/gate.yaml",
        logPath: "/fake/gate.log",
        reused: false,
        next: "",
      };
    },
  };
}

describe("kya start - gateway auto-bootstrap", () => {
  it("servers>0: imports, installs, starts, rewires only the imported ids, backs up originals", async () => {
    const cwd = tmp("kya-startgate-");
    const home = tmp("kya-startgate-home-");
    try {
      writeJson(join(home, ".claude.json"), {
        theme: "dark",
        mcpServers: {
          github: { command: "npx", args: ["-y", "gh-mcp"] },
          filesystem: { command: "npx", args: ["fs-mcp"] },
        },
      });
      const calls = { ensure: 0, run: 0 };
      const r = await runStart(cfg(cwd), {
        open: false,
        home,
        gateDeps: fakeGateDeps(calls),
      });

      expect(calls.ensure).toBe(1);
      expect(calls.run).toBe(1);
      expect(r.gate).toBeDefined();
      expect(r.gate!.imported.sort()).toEqual(["filesystem", "github"]);
      expect(r.gate!.running).toBe(true);
      expect(r.gate!.summary).toContain("2 servers imported (github, filesystem)");
      expect(r.gate!.summary).toContain("gateway running on 127.0.0.1:3930");
      expect(r.gate!.summary).toContain(".kya/backups/");

      // gateways.json carries the imports with provenance.
      const gateways = JSON.parse(
        readFileSync(join(home, ".kya", "gateways.json"), "utf8"),
      ) as { servers: Array<Record<string, unknown>> };
      const ids = gateways.servers.map((s) => s["id"]).sort();
      expect(ids).toEqual(["filesystem", "github"]);
      for (const s of gateways.servers) expect(s["importedFrom"]).toEqual(["claude"]);

      // Host config: imported ids replaced by the gate entry; shield-kya untouched.
      const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(claude.theme).toBe("dark");
      expect(claude.mcpServers["github"]).toBeUndefined();
      expect(claude.mcpServers["filesystem"]).toBeUndefined();
      expect(claude.mcpServers["shield-kya"]).toBeDefined();
      expect(claude.mcpServers["shield-kya-gate"]).toEqual({
        type: "http",
        url: `${GATE_URL}/mcp`,
      });

      // Original backed up before removal.
      const backups = readdirSync(join(home, ".kya", "backups"));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^claude-.*\.json$/);
      const backup = JSON.parse(
        readFileSync(join(home, ".kya", "backups", backups[0]!), "utf8"),
      ) as { mcpServers: Record<string, unknown> };
      expect(backup.mcpServers["github"]).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("servers=0: no download, no listener, report-panel guidance line", async () => {
    const cwd = tmp("kya-startgate-");
    const home = tmp("kya-startgate-home-");
    try {
      const calls = { ensure: 0, run: 0 };
      const r = await runStart(cfg(cwd), { open: false, home, gateDeps: fakeGateDeps(calls) });
      expect(calls.ensure).toBe(0);
      expect(calls.run).toBe(0);
      expect(existsSync(join(home, ".kya", "gateways.json"))).toBe(true);
      expect(r.gate!.running).toBe(false);
      expect(r.gate!.summary).toContain("no third-party MCP servers found");
      expect(r.gate!.summary).toContain("kya start");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("download failure degrades gracefully: start succeeds, hosts untouched", async () => {
    const cwd = tmp("kya-startgate-");
    const home = tmp("kya-startgate-home-");
    try {
      writeJson(join(home, ".claude.json"), {
        mcpServers: { github: { command: "npx", args: ["gh-mcp"] } },
      });
      const calls = { ensure: 0, run: 0 };
      const r = await runStart(cfg(cwd), {
        open: false,
        home,
        gateDeps: fakeGateDeps(calls, { ensureFails: true }),
      });
      expect(calls.ensure).toBe(1);
      expect(calls.run).toBe(0);
      expect(r.gate!.running).toBe(false);
      expect(r.gate!.warnings.length).toBeGreaterThan(0);
      expect(r.gate!.warnings[0]).toContain("gateway binary");
      // Direct entries stay - removing them without a gateway would break the user.
      const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(claude.mcpServers["github"]).toBeDefined();
      expect(existsSync(join(home, ".kya", "backups"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("--no-gate skips everything, KYA_GATE=off too", async () => {
    const cwd = tmp("kya-startgate-");
    const home = tmp("kya-startgate-home-");
    try {
      writeJson(join(home, ".claude.json"), {
        mcpServers: { github: { command: "npx", args: ["gh-mcp"] } },
      });
      const calls = { ensure: 0, run: 0 };
      const r = await runStart(cfg(cwd), {
        open: false,
        home,
        gate: false,
        gateDeps: fakeGateDeps(calls),
      });
      expect(r.gate).toBeUndefined();
      expect(calls.ensure).toBe(0);
      expect(existsSync(join(home, ".kya", "gateways.json"))).toBe(false);

      const prev = process.env.KYA_GATE;
      process.env.KYA_GATE = "off";
      try {
        const r2 = await runStart(cfg(cwd), {
          open: false,
          home,
          gateDeps: fakeGateDeps(calls),
        });
        expect(r2.gate).toBeUndefined();
        expect(calls.ensure).toBe(0);
        expect(existsSync(join(home, ".kya", "gateways.json"))).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.KYA_GATE;
        else process.env.KYA_GATE = prev;
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never removes direct entries for hand-configured servers not imported from that host", async () => {
    const cwd = tmp("kya-startgate-");
    const home = tmp("kya-startgate-home-");
    try {
      // Hand-configured gateways.json entry (no importedFrom) + direct host entry.
      writeJson(join(home, ".kya", "gateways.json"), {
        servers: [{ id: "github", transport: "stdio", cmd: ["npx", "gh-mcp"] }],
      });
      writeJson(join(home, ".claude.json"), {
        mcpServers: { github: { command: "npx", args: ["gh-mcp"] } },
      });
      const calls = { ensure: 0, run: 0 };
      const r = await runStart(cfg(cwd), { open: false, home, gateDeps: fakeGateDeps(calls) });
      expect(calls.run).toBe(1);
      expect(r.gate!.imported).toEqual([]);
      const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(claude.mcpServers["github"]).toBeDefined();
      expect(claude.mcpServers["shield-kya-gate"]).toBeUndefined();
      expect(existsSync(join(home, ".kya", "backups"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("second run: nothing new to import, gateway ensured, no duplicate backups", async () => {
    const cwd = tmp("kya-startgate-");
    const home = tmp("kya-startgate-home-");
    try {
      writeJson(join(home, ".claude.json"), {
        mcpServers: { github: { command: "npx", args: ["gh-mcp"] } },
      });
      const calls = { ensure: 0, run: 0 };
      const deps = fakeGateDeps(calls);
      const first = await runStart(cfg(cwd), { open: false, home, gateDeps: deps });
      expect(first.gate!.imported).toEqual(["github"]);

      const second = await runStart(cfg(cwd), { open: false, home, gateDeps: deps });
      expect(second.gate!.imported).toEqual([]);
      expect(second.gate!.running).toBe(true);
      expect(second.gate!.summary).toContain("1 server");
      expect(readdirSync(join(home, ".kya", "backups"))).toHaveLength(1);
      const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(claude.mcpServers["github"]).toBeUndefined();
      expect(claude.mcpServers["shield-kya-gate"]).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rewires TOML hosts: tables sliced, gate url table appended, original backed up", async () => {
    const cwd = tmp("kya-startgate-");
    const home = tmp("kya-startgate-home-");
    try {
      mkdirSync(join(home, ".grok"), { recursive: true });
      const toml = [
        "[mcp_servers.filesystem]",
        'command = "npx"',
        'args = ["-y", "fs-mcp"]',
        "enabled = true",
        "",
      ].join("\n");
      writeFileSync(join(home, ".grok", "config.toml"), toml, "utf8");
      const calls = { ensure: 0, run: 0 };
      const r = await runStart(cfg(cwd), { open: false, home, gateDeps: fakeGateDeps(calls) });
      expect(r.gate!.imported).toEqual(["filesystem"]);
      const after = readFileSync(join(home, ".grok", "config.toml"), "utf8");
      expect(after).not.toContain("[mcp_servers.filesystem]");
      expect(after).toContain("[mcp_servers.shield-kya]");
      expect(after).toContain("[mcp_servers.shield-kya-gate]");
      expect(after).toContain(`url = "${GATE_URL}/mcp"`);
      const backups = readdirSync(join(home, ".kya", "backups"));
      expect(backups.some((b) => b.startsWith("grok-") && b.endsWith(".toml"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
