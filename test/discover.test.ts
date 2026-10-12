/**
 * Unit tests for the endpoint discovery scanner and snapshot utilities.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { discoveryCatalog, lookupDiscoveryId } from "../src/discover/catalog.js";
import {
  buildEndpointId,
  scanCliBinaries,
  scanDesktopApps,
  scanEndpoint,
  scanIdeExtensions,
  scanMcpServers,
  scanModelRuntimes,
  type DiscoverySnapshot,
  type ScanFs,
} from "../src/discover/scan.js";
import {
  diffDiscoverySnapshots,
  loadDiscoverySnapshot,
  loadLatestDiscoverySnapshot,
  writeDiscoverySnapshot,
} from "../src/discover/snapshot.js";
import { pushDiscoverySnapshot } from "../src/discover/push.js";

function makeFs(_root: string): ScanFs {
  return fs as unknown as ScanFs;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeExecutable(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, "", { mode: 0o755 });
}

function makeDir(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
}

function makeJson(dir: string, name: string, payload: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(payload), "utf8");
}

describe("discovery catalog", () => {
  it("contains required tools", () => {
    const ids = [...discoveryCatalog().keys()];
    for (const id of [
      "claude",
      "cursor-agent",
      "codex",
      "gemini",
      "opencode",
      "kyo",
      "aider",
      "ollama",
      "lm-studio",
      "llama-server",
      "mcpserver",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("known-good defaults are SANCTIONED, unknown defaults are REVIEW", () => {
    expect(lookupDiscoveryId("claude")?.defaultSanction).toBe("SANCTIONED");
    expect(lookupDiscoveryId("ollama")?.defaultSanction).toBe("SANCTIONED");
    expect(lookupDiscoveryId("kyo")?.defaultSanction).toBe("REVIEW");
    expect(lookupDiscoveryId("llama-server")?.defaultSanction).toBe("REVIEW");
    expect(lookupDiscoveryId("mcpserver")?.defaultSanction).toBe("REVIEW");
  });

  it("has no UNSANCTIONED defaults", () => {
    for (const entry of discoveryCatalog().values()) {
      expect(entry.defaultSanction).not.toBe("UNSANCTIONED");
    }
  });
});

describe("scanCliBinaries", () => {
  it("finds claude and ollama on a fake PATH", () => {
    const binDir = tempDir("kya-discover-bin-");
    makeExecutable(binDir, "claude");
    makeExecutable(binDir, "ollama");
    const fs = makeFs(binDir);
    const findings = scanCliBinaries([binDir], fs, "linux");
    const ids = findings.map((f) => f.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("ollama");
    expect(findings.every((f) => f.confidence === "high")).toBe(true);
  });

  it("does not find non-executable files", () => {
    const binDir = tempDir("kya-discover-bin-");
    writeFileSync(join(binDir, "claude"), "", { mode: 0o644 });
    const fs = makeFs(binDir);
    const findings = scanCliBinaries([binDir], fs, "linux");
    expect(findings).toHaveLength(0);
  });
});

describe("scanIdeExtensions", () => {
  it("finds Cursor/anthropic extension directories", () => {
    const root = tempDir("kya-discover-ext-");
    makeDir(root, "anthropic.claude-1.2.3");
    makeDir(root, "unknown.publisher-1.0");
    const fs = makeFs(root);
    const findings = scanIdeExtensions([root], fs);
    expect(findings.some((f) => f.id === "claude")).toBe(true);
    expect(findings.some((f) => f.vendor.toLowerCase() === "anthropic")).toBe(true);
  });
});

describe("scanDesktopApps", () => {
  it("finds macOS /Applications matches", () => {
    const root = tempDir("kya-discover-apps-");
    makeDir(root, "Claude.app");
    makeDir(root, "SomeOtherApp.app");
    const fs = makeFs(root);
    const findings = scanDesktopApps([root], fs, "darwin");
    expect(findings.some((f) => f.id === "claude")).toBe(true);
    expect(findings[0]?.confidence).toBe("high");
  });
});

describe("scanModelRuntimes", () => {
  it("reports ollama with default port", () => {
    const binDir = tempDir("kya-discover-runtime-");
    makeExecutable(binDir, "ollama");
    const fs = makeFs(binDir);
    const findings = scanModelRuntimes([binDir], fs, "linux");
    const ollama = findings.find((f) => f.id === "ollama");
    expect(ollama).toBeDefined();
    expect(ollama?.evidence.port).toBe(11434);
  });
});

describe("scanMcpServers", () => {
  it("reads configured servers from mcp.json", () => {
    const dir = tempDir("kya-discover-mcp-");
    makeJson(dir, "mcp.json", {
      mcpServers: {
        "filesystem": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
        "github": { command: "docker", args: ["run", "mcp/github"] },
      },
    });
    const fs = makeFs(dir);
    const findings = scanMcpServers([join(dir, "mcp.json")], fs);
    expect(findings).toHaveLength(2);
    expect(findings[0]?.category).toBe("mcp-server");
    expect(findings[0]?.evidence.command).toBe("npx");
  });
});

describe("scanEndpoint", () => {
  it("redacts home directory in evidence paths", () => {
    const home = tempDir("kya-discover-home-");
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    makeExecutable(binDir, "claude");
    const snapshot = scanEndpoint({
      env: { PATH: binDir },
      cwd: home,
      homeDir: home,
      platform: "linux",
    });
    const claude = snapshot.inventory.find((f) => f.id === "claude");
    expect(claude).toBeDefined();
    expect(claude?.evidence.path).toMatch(/^~\/bin\/claude/);
    expect(snapshot.os).toBe("linux");
  });

  it("produces the contract payload shape", () => {
    const home = tempDir("kya-discover-home-");
    const snapshot = scanEndpoint({
      env: { PATH: "/usr/bin" },
      cwd: home,
      homeDir: home,
      platform: "darwin",
    });
    expect(snapshot.endpointUid).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.hostnameHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.os).toBe("darwin");
    expect(typeof snapshot.capturedAt).toBe("string");
    expect(Array.isArray(snapshot.inventory)).toBe(true);
    expect(snapshot.coverage.attempted).toContain("cli-binaries");
    expect(snapshot.coverage.attempted).toContain("mcp-servers");
    expect(snapshot.coverage.truncated).toBe(false);
  });
});

describe("buildEndpointId", () => {
  it("is stable and redacts hostname/user", () => {
    const first = buildEndpointId("darwin", "/home/user");
    const second = buildEndpointId("darwin", "/home/user");
    expect(first.endpointUid).toBe(second.endpointUid);
    expect(first.endpointUid).not.toContain("user");
    expect(first.hostnameHash).not.toContain(hostname());
  });
});

describe("snapshot persistence", () => {
  it("writes timestamped and latest.json snapshots", () => {
    const home = tempDir("kya-discover-snap-");
    const snapshot: DiscoverySnapshot = {
      endpointUid: "abc123",
      hostnameHash: "def456",
      os: "linux",
      capturedAt: "2026-10-12T10:00:00.000Z",
      inventory: [],
      coverage: { attempted: ["cli-binaries"], unavailable: [], truncated: false },
    };
    const { path: written, latestPath } = writeDiscoverySnapshot(snapshot, { KYA_HOME: home });
    expect(written).toContain("2026-10-12T10-00-00-000Z");
    const loaded = loadDiscoverySnapshot(written);
    expect(loaded?.endpointUid).toBe("abc123");
    const latest = loadLatestDiscoverySnapshot({ KYA_HOME: home });
    expect(latest?.endpointUid).toBe("abc123");
    expect(latestPath).toContain("latest.json");
  });
});

describe("diffDiscoverySnapshots", () => {
  it("detects added and removed findings", () => {
    const previous: DiscoverySnapshot = {
      endpointUid: "a",
      hostnameHash: "b",
      os: "linux",
      capturedAt: "2026-10-12T09:00:00.000Z",
      inventory: [
        {
          id: "ollama",
          name: "Ollama",
          vendor: "Ollama",
          category: "model-runtime",
          source: "PATH:/usr/local/bin/ollama",
          confidence: "high",
          evidence: { path: "/usr/local/bin/ollama" },
        },
      ],
      coverage: { attempted: [], unavailable: [], truncated: false },
    };
    const current: DiscoverySnapshot = {
      ...previous,
      capturedAt: "2026-10-12T10:00:00.000Z",
      inventory: [
        {
          id: "claude",
          name: "Claude Code",
          vendor: "Anthropic",
          category: "cli-agent",
          source: "PATH:/usr/local/bin/claude",
          confidence: "high",
          evidence: { path: "/usr/local/bin/claude" },
        },
        {
          id: "ollama",
          name: "Ollama",
          vendor: "Ollama",
          category: "model-runtime",
          source: "PATH:/usr/local/bin/ollama",
          confidence: "high",
          evidence: { path: "/usr/local/bin/ollama" },
        },
      ],
    };
    const diff = diffDiscoverySnapshots(current, previous);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.id).toBe("claude");
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });
});

describe("pushDiscoverySnapshot", () => {
  it("POSTs the expected payload shape", async () => {
    const snapshot: DiscoverySnapshot = {
      endpointUid: "uid",
      hostnameHash: "hash",
      os: "linux",
      capturedAt: "2026-10-12T10:00:00.000Z",
      inventory: [
        {
          id: "claude",
          name: "Claude Code",
          vendor: "Anthropic",
          category: "cli-agent",
          source: "PATH:/usr/local/bin/claude",
          confidence: "high",
          evidence: { path: "/usr/local/bin/claude" },
        },
      ],
      coverage: { attempted: [], unavailable: [], truncated: false },
    };
    let captured: { url: string; body: unknown; headers: Record<string, string> } | undefined;
    const fetchFn = async (url: string, init: RequestInit) => {
      captured = {
        url,
        body: JSON.parse(init.body as string),
        headers: init.headers as Record<string, string>,
      };
      return new Response("", { status: 202 });
    };
    const result = await pushDiscoverySnapshot(snapshot, {
      baseUrl: "https://shield-agent.com",
      apiKey: "sk_test",
      fetchFn,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(captured?.url).toBe("https://shield-agent.com/api/v1/kya/endpoints");
    expect(captured?.headers["Authorization"]).toBe("Bearer sk_test");
    expect((captured?.body as { endpointUid: string }).endpointUid).toBe("uid");
  });

  it("surfaces network errors without throwing", async () => {
    const snapshot: DiscoverySnapshot = {
      endpointUid: "uid",
      hostnameHash: "hash",
      os: "linux",
      capturedAt: "2026-10-12T10:00:00.000Z",
      inventory: [],
      coverage: { attempted: [], unavailable: [], truncated: false },
    };
    const fetchFn = async () => {
      throw new Error("offline");
    };
    const result = await pushDiscoverySnapshot(snapshot, {
      baseUrl: "https://shield-agent.com",
      apiKey: "sk_test",
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("offline");
  });
});
