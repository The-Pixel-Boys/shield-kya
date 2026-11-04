// The collector: minimised fields only, golden file for the whole report, nothing planted leaks.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectReport } from "../src/posture/collect.js";
import { checkReport, forbiddenContext } from "../src/posture/validate.js";
import { readIocResult } from "../src/ioc/result.js";
import { DEVICE_ID, LABEL, NOW, PLANTED_ENV_VALUE, makePostureHome } from "./support/posture-home.js";

function build(home: string, env: NodeJS.ProcessEnv) {
  return collectReport({
    deviceId: DEVICE_ID,
    label: LABEL,
    now: NOW,
    home,
    pathDirs: [join(home, "..", "bin")],
    platform: process.platform,
    arch: process.arch,
    ioc: readIocResult(env),
    iocExtensionIds: ["anthropic.claude-code"],
    hosted: false,
  });
}

describe("posture collector", () => {
  it("reports agent hosts, allowlisted extensions, minimal MCP entries and the stored IoC result", () => {
    const fx = makePostureHome();
    const r = build(fx.home, fx.env);
    // The Copilot Chat extension maps to the copilot host, so both hosts are listed.
    expect(r["hosts"]).toEqual([
      { id: "claude-code", version: null, kyaHook: false },
      { id: "copilot", version: null, kyaHook: false },
    ]);
    expect(r["extensions"]).toEqual([
      { id: "anthropic.claude-code", version: "2.1.313", editor: "vscode" },
      { id: "anthropic.claude-code", version: "2.1.314", editor: "vscode" },
      { id: "github.copilot-chat", version: "0.22.0", editor: "cursor" },
    ]);
    expect(r["mcpServers"]).toEqual([
      { name: "docs", transport: "http", command: null },
      { name: "fs", transport: "stdio", command: "mcp-filesystem" },
    ]);
    expect((r["ioc"] as { findings: unknown[] }).findings).toHaveLength(1);
    expect(r["never"]).toEqual({ listActive: true, mode: "advisory" });
  });

  it("produces a report that passes the gate, with no planted value, path or name in it", () => {
    const fx = makePostureHome();
    const r = build(fx.home, fx.env);
    const ctx = forbiddenContext(fx.env, "nobody-planted-user", "nobody-planted-host", fx.home);
    expect(checkReport(r, ctx)).toEqual([]);
    const text = JSON.stringify(r);
    expect(text).not.toContain(PLANTED_ENV_VALUE);
    expect(text).not.toContain("planted-url-secret");
    expect(text).not.toContain("/Users/alice");
    expect(text).not.toContain(fx.home);
  });

  it("matches the golden report (file snapshot)", async () => {
    const fx = makePostureHome();
    const r = build(fx.home, fx.env);
    // Platform, arch and kya version belong to the machine and the release, so the golden holds placeholders.
    expect(r["kyaVersion"]).toMatch(/^\d+\.\d+\.\d+/);
    const golden = { ...r, os: "<host-os>", arch: "<host-arch>", kyaVersion: "<kya-version>" };
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(join(import.meta.dirname, "fixtures", "posture", "report.golden.json"));
    expect(readFileSync(join(import.meta.dirname, "fixtures", "posture", "report.golden.json"), "utf8")).toContain(DEVICE_ID);
  });
});
