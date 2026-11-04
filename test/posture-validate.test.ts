// Posture report gate: the hosted rules plus the local checks. Every violation must block a send.
import { describe, expect, it } from "vitest";
import { checkReport, forbiddenContext, MAX_REPORT_BYTES } from "../src/posture/validate.js";

const ctx = forbiddenContext(
  { PLANTED_POSTURE_NAME_TOKEN: "planted-posture-value-9f8e7d6c" },
  "alice",
  "build-box-7",
  "/Users/alice",
);

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    reportedAt: "2026-10-30T12:00:00.000Z",
    kyaVersion: "0.32.7",
    deviceId: "dev-golden-0001",
    deviceLabel: "golden-desk",
    os: "darwin",
    arch: "arm64",
    hosts: [{ id: "claude-code", version: null, kyaHook: false }],
    extensions: [{ id: "anthropic.claude-code", version: "2.1.314", editor: "vscode" }],
    mcpServers: [{ name: "docs", transport: "http", command: null }],
    ioc: { listVersion: "2026-10-30.1", checkedAt: "2026-10-30T12:00:00.000Z", skipped: 0, findings: [] },
    never: { listActive: true, mode: "advisory" },
    ...over,
  };
}

const paths = (r: Record<string, unknown>): string[] => checkReport(r, ctx).map((v) => v.path);

describe("posture report gate", () => {
  it("passes a clean v1 report", () => {
    expect(checkReport(report(), ctx)).toEqual([]);
  });

  it("refuses unknown top-level and nested fields", () => {
    expect(paths(report({ env: {} }))).toContain("env");
    expect(paths(report({ hosts: [{ id: "codex", version: null, kyaHook: false, args: [] }] }))).toContain("hosts[0].args");
  });

  it("refuses a user name, a host name and a home path in any string", () => {
    expect(paths(report({ deviceLabel: "alice-laptop" }))).toContain("deviceLabel");
    expect(paths(report({ deviceLabel: "build-box-7" }))).toContain("deviceLabel");
    expect(paths(report({ mcpServers: [{ name: "/Users/alice/tool", transport: "stdio", command: null }] }))).toContain("mcpServers[0].name");
  });

  it("refuses absolute paths, Windows paths, file URLs and e-mail addresses", () => {
    for (const bad of ["/var/folders/x/y", "/tmp/a", " /opt/tool", "C:\\Program Files\\x", "file:///a", "dev@example.com"]) {
      expect(paths(report({ deviceLabel: bad })), bad).toContain("deviceLabel");
    }
    expect(paths(report({ ioc: { ...(report().ioc as object), findings: [{ ioc: "a", check: "extension", severity: "high", evidence: "~/.vscode/extensions/x", hint: "see /usr/bin/x" }] } }))).toContain("ioc.findings[0].hint");
  });

  it("refuses IP addresses", () => {
    expect(paths(report({ deviceLabel: "10.0.0.5" }))).toContain("deviceLabel");
    expect(paths(report({ deviceLabel: "fe80::1ff" }))).toContain("deviceLabel");
  });

  it("refuses an environment variable name or a planted secret value", () => {
    expect(paths(report({ mcpServers: [{ name: "PLANTED_POSTURE_NAME_TOKEN", transport: "stdio", command: null }] }))).toContain("mcpServers[0].name");
    expect(paths(report({ deviceLabel: "planted-posture-value-9f8e7d6c" }))).toContain("deviceLabel");
  });

  it("refuses a command that carries a directory", () => {
    expect(paths(report({ mcpServers: [{ name: "fs", transport: "stdio", command: "/usr/bin/npx" }] }))).toContain("mcpServers[0].command");
  });

  it("refuses wrong schema, bad enums, a missing IoC block and a report over 64 KB", () => {
    expect(paths(report({ schema: 2 }))).toContain("schema");
    expect(paths(report({ os: "freebsd" }))).toContain("os");
    expect(paths(report({ never: { listActive: true, mode: "loose" } }))).toContain("never.mode");
    const noIoc = report();
    delete noIoc.ioc;
    expect(paths(noIoc)).toContain("ioc");
    expect(MAX_REPORT_BYTES).toBe(64 * 1024);
    const bulky = report({
      extensions: Array.from({ length: 200 }, (_, i) => ({ id: `vendor.${i}-${"x".repeat(110)}`, version: "1.0.0", editor: "vscode" })),
      ioc: {
        listVersion: "2026-10-30.1",
        checkedAt: "2026-10-30T12:00:00.000Z",
        skipped: 0,
        findings: Array.from({ length: 50 }, () => ({ ioc: "a", check: "net_indicator", severity: "high", evidence: `~/${"a".repeat(500)}`, hint: "b".repeat(300) })),
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(bulky)).length).toBeGreaterThan(MAX_REPORT_BYTES);
    expect(paths(bulky)).toContain("report");
  });

  it("never echoes the offending value in a violation", () => {
    const v = checkReport(report({ deviceLabel: "alice-laptop" }), ctx);
    expect(JSON.stringify(v)).not.toContain("alice-laptop");
  });
});
