import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_RELOAD,
  hostReload,
  hostRunning,
  reloadMessage,
} from "../src/host-reload.js";
import { knownHosts, runConnect } from "../src/commands/connect.js";
import { runStart } from "../src/commands/start.js";
import { resolveConfig } from "../src/config.js";

const MCP_HOSTS = [
  "cursor", "opencode", "qwen", "kimi", "kiro", "kilo", "mastracode", "amp",
  "copilot", "claude", "codex", "gemini", "grok", "cline", "droid",
];

describe("host reload registry", () => {
  it("classifies every MCP host — no host silently falls back to restart copy", () => {
    for (const id of MCP_HOSTS) {
      const info = hostReload(id);
      expect(info, `missing reload behavior for ${id}`).toBeDefined();
      expect(["auto", "session", "restart"]).toContain(info!.reload);
      expect(info!.detail.length).toBeGreaterThan(10);
      expect(info!.processNames.length).toBeGreaterThan(0);
    }
  });

  it("every connect-registry host has a reload entry", () => {
    for (const id of knownHosts()) {
      expect(hostReload(id), `connect host ${id} missing from HOST_RELOAD`).toBeDefined();
    }
  });

  it("auto-class hosts never tell the user to restart", () => {
    for (const info of Object.values(HOST_RELOAD)) {
      if (info.reload !== "auto") continue;
      for (const running of [true, false]) {
        const msg = reloadMessage(info, "X", running).toLowerCase();
        expect(msg).not.toContain("relaunch");
        expect(msg).toContain("no restart");
      }
    }
  });

  it("restart-class hosts only ask for a relaunch when actually running", () => {
    const claude = hostReload("claude")!;
    expect(reloadMessage(claude, "Claude Code", true)).toContain("relaunch");
    expect(reloadMessage(claude, "Claude Code", true)).toContain("--resume");
    const notRunning = reloadMessage(claude, "Claude Code", false);
    expect(notRunning).toContain("not running");
    expect(notRunning).not.toContain("relaunch");
  });

  it("session-class hosts distinguish running vs not", () => {
    const kimi = hostReload("kimi")!;
    expect(reloadMessage(kimi, "Kimi Code", true)).toContain("new session");
    expect(reloadMessage(kimi, "Kimi Code", false)).toContain("no restart needed");
  });

  it("hostRunning matches basenames", () => {
    const cursor = hostReload("cursor")!;
    expect(hostRunning(cursor, new Set(["cursor", "node"]))).toBe(true);
    expect(hostRunning(cursor, new Set(["node"]))).toBe(false);
  });
});

describe("messaging integration", () => {
  it("connect output is per-host accurate", async () => {
    const home = mkdtempSync(join(tmpdir(), "kya-reload-home-"));
    try {
      const config = resolveConfig({
        cwd: home,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      // Qwen: auto-reload — no restart wording even when running.
      const qwen = await runConnect(
        config,
        { host: "qwen", procs: new Set(["qwen"]) },
        { ...process.env, KYA_HOME: home },
      );
      expect(qwen.next).toContain("No restart needed");
      expect(qwen.next).not.toContain("Restart Qwen");

      // OpenCode: restart class, but nothing running → no relaunch demand.
      const opencode = await runConnect(
        config,
        { host: "opencode", procs: new Set() },
        { ...process.env, KYA_HOME: home },
      );
      expect(opencode.next).toContain("not running");
      expect(opencode.next).not.toContain("relaunch");

      // OpenCode running → honest relaunch instruction.
      const opencodeRunning = await runConnect(
        config,
        { host: "opencode", force: true, procs: new Set(["opencode"]) },
        { ...process.env, KYA_HOME: home },
      );
      expect(opencodeRunning.next).toContain("relaunch");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("start next-steps speak per host (cursor auto, claude resume tip)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-reload-start-"));
    const home = mkdtempSync(join(tmpdir(), "kya-reload-start-home-"));
    try {
      const config = resolveConfig({
        cwd,
        offline: true,
        allowMissingApiKey: true,
        flags: { offline: true },
      });
      const r = await runStart(config, {
        open: false,
        home,
        procs: new Set(["claude"]),
      });
      expect(r.next).toContain("No restart needed"); // Cursor
      expect(r.next).toContain("Claude Code is running");
      expect(r.next).toContain("--resume");
      expect(r.next).toContain("kya stop");
      expect(r.next).not.toContain("Codex"); // start never wires Codex
      expect(existsSync(join(cwd, ".kya", "config.json"))).toBe(true);
      const wired = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(wired.mcpServers["shield-kya"]).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
