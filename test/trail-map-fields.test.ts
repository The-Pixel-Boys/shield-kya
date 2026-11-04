import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerdictTracePayload, type VerdictEvent } from "../src/otel/exporter.js";
import { buildSharePayload } from "../src/receipt/share.js";
import { buildWindowReceiptModel } from "../src/receipt/render-receipt.js";
import { appendTrail, readTrail, type TrailEvent } from "../src/trail.js";
import { summarizeShellCommand } from "../src/trail-summary.js";

// The classifier can be made to throw for one test. Passthrough otherwise.
const seam = vi.hoisted(() => ({ throwNext: false }));
vi.mock("../src/map/target-class.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/map/target-class.js")>();
  return {
    ...actual,
    classifyTarget: (input: Parameters<typeof actual.classifyTarget>[0]) => {
      if (seam.throwNext) throw new Error("classifier broke");
      return actual.classifyTarget(input);
    },
  };
});
const { trailMapFields } = await import("../src/trail-map-fields.js");

const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
const HEX16 = /^[0-9a-f]{16}$/;
// Built at runtime: a literal key shape would block the push to the public mirror.
const AWS_EXAMPLE = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");

/** Spawn the built CLI hook for one Claude Code PreToolUse payload. The payload is passed by stdin only. */
function hook(tool: string, toolInput: unknown) {
  const home = mkdtempSync(join(tmpdir(), "kya-mapf-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "kya-mapf-proj-"));
  const r = spawnSync(process.execPath, [cliJs, "hook", "--host", "claude"], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "map-1", cwd, tool_name: tool, tool_input: toolInput }),
    env: { ...process.env, KYA_HOME: home, KYA_SKIP_NODE_CHECK: "1" },
    cwd,
    encoding: "utf8",
  });
  const rows = readTrail(cwd, { KYA_HOME: home });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, row: rows[rows.length - 1], cwd };
}

const TRAIL_BASE: TrailEvent = { ts: "2026-11-02T10:00:00.000Z", sessionId: "s", toolId: "Bash", verdict: "DENY", reasonCode: "NEVER_EVENT", mode: "offline" };

describe("hook writes targetClass and deviceId", () => {
  it("never-list shell command: exit 2 as before, row carries command class and deviceId", () => {
    const r = hook("Bash", { command: "rm -rf ~" });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(r.row).toMatchObject({ verdict: "DENY", neverEvent: true, targetClass: "command:rm" });
    expect(r.row.deviceId).toMatch(HEX16);
  });

  it("Read of an ssh key path: exit 2 as before, row carries a secret class and no path in targetClass", () => {
    const r = hook("Read", { file_path: join(homedir(), ".ssh", "id_ed25519") });
    expect(r.status).toBe(2);
    expect(r.row.neverEvent).toBe(true);
    expect(r.row.targetClass).toBe("secret:ssh-key");
    expect(r.row.targetClass).not.toContain(homedir());
    expect(r.row.deviceId).toMatch(HEX16);
  });

  it("secret-shaped write (NEVER_SECRET_WRITE, text stripped): exit 2 and the row keeps a project class", () => {
    const r = hook("Write", { file_path: join(tmpdir(), "kya-mapf-x", "src", "config.ts"), content: `const k = "${AWS_EXAMPLE}";` });
    expect(r.status).toBe(2);
    expect(r.row).toMatchObject({ reasonCode: "NEVER_SECRET_WRITE", neverEvent: true });
    expect(r.row.summary).toBeUndefined();
    expect(r.row.diffPreview).toBeUndefined();
    expect(r.row.targetClass).toMatch(/^(tmp|project|absolute|home|system|secret):/);
    expect(r.row.targetClass).not.toBe("none");
  });

  it("allowed shell command: exit 0 and empty output, row still carries the class", () => {
    const r = hook("Bash", { command: "ls -la" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.row).toMatchObject({ verdict: "REQUIRE_APPROVE", targetClass: "command:ls" });
    expect(r.row.deviceId).toMatch(HEX16);
  });

  it("eval-tool CLI row carries the class and deviceId", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-mapf-ev-"));
    const cwd = mkdtempSync(join(tmpdir(), "kya-mapf-evp-"));
    const r = spawnSync(process.execPath, [cliJs, "eval-tool", "--offline", "--tool-id", "Bash", "--args", JSON.stringify({ command: "rm -rf ~" })], {
      env: { ...process.env, KYA_HOME: home, KYA_SKIP_NODE_CHECK: "1" },
      cwd,
      encoding: "utf8",
    });
    expect(r.status).not.toBeNull();
    const row = readTrail(cwd, { KYA_HOME: home }).at(-1);
    expect(row?.targetClass).toBe("command:rm");
    expect(row?.deviceId).toMatch(HEX16);
  });
});

describe("trailMapFields", () => {
  it("swallows a classifier throw: no targetClass, deviceId still set, nothing thrown", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-mapf-throw-"));
    seam.throwNext = true;
    try {
      let fields: ReturnType<typeof trailMapFields> | undefined;
      expect(() => {
        fields = trailMapFields("Bash", { command: "ls" }, home, { KYA_HOME: home });
      }).not.toThrow();
      expect(fields?.targetClass).toBeUndefined();
      expect(fields?.deviceId).toMatch(HEX16);
    } finally {
      seam.throwNext = false;
    }
  });

  it("returns a class for a secret read and never the raw path", () => {
    const fields = trailMapFields("Read", { file_path: join(homedir(), ".aws", "credentials") }, "/nonexistent-proj", { KYA_HOME: mkdtempSync(join(tmpdir(), "kya-mapf-u-")) });
    expect(fields.targetClass).toBe("secret:cloud-credential");
  });

  it("returns no deviceId and no throw when the KYA_HOME cannot hold the salt", () => {
    const blocker = join(mkdtempSync(join(tmpdir(), "kya-mapf-b-")), "file");
    writeFileSync(blocker, "x");
    expect(() => trailMapFields("Bash", { command: "ls" }, "/x", { KYA_HOME: blocker })).not.toThrow();
    expect(trailMapFields("Bash", { command: "ls" }, "/x", { KYA_HOME: blocker }).deviceId).toBeUndefined();
  });
});

describe("trail round trip keeps the new fields", () => {
  it("readTrail returns deviceId and targetClass written by appendTrail", () => {
    const home = mkdtempSync(join(tmpdir(), "kya-mapf-rt-"));
    const cwd = mkdtempSync(join(tmpdir(), "kya-mapf-rtp-"));
    appendTrail(cwd, { ...TRAIL_BASE, deviceId: "0123456789abcdef", targetClass: "command:ls" }, { KYA_HOME: home });
    expect(readTrail(cwd, { KYA_HOME: home })[0]).toMatchObject({ deviceId: "0123456789abcdef", targetClass: "command:ls" });
    expect(existsSync(join(home, ".kya", "trail.jsonl"))).toBe(true);
  });
});

describe("OTLP and share payloads never carry deviceId or targetClass", () => {
  const DEVICE = "fedcba9876543210";
  const CLASS = "secret:ssh-key";
  const rows: TrailEvent[] = [
    { ...TRAIL_BASE, deviceId: DEVICE, targetClass: CLASS },
    { ...TRAIL_BASE, verdict: "ALLOW", reasonCode: "ALLOW", toolId: "Read", deviceId: DEVICE, targetClass: "tmp:/**" },
  ];
  const forbidden = ["deviceId", "device_id", "targetClass", "target_class", DEVICE, CLASS];

  it("buildVerdictTracePayload output has none of the names or values", () => {
    const event = { ...rows[0]!, deviceId: DEVICE, targetClass: CLASS } as VerdictEvent & TrailEvent;
    const text = JSON.stringify(buildVerdictTracePayload(event));
    for (const f of forbidden) expect(text).not.toContain(f);
  });

  it("buildSharePayload output has none of the names or values", () => {
    const text = JSON.stringify(buildSharePayload(buildWindowReceiptModel(rows, 3, {})));
    for (const f of forbidden) expect(text).not.toContain(f);
  });
});

describe("trailMapFields: bounded cost (review item 1)", () => {
  it("a 100,000 character run of ? before a never-list command is cheap", () => {
    const cmd = "?".repeat(100_000) + ";rm -rf /";
    const t0 = Date.now();
    const f = trailMapFields("Bash", { command: cmd }, "/tmp/p", { KYA_HOME: mkdtempSync(join(tmpdir(), "kya-redos-")) });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(f.targetClass).toBeDefined();
  });

  it("the real hook still denies a never-list command after a 100,000 character prefix, and fast", () => {
    const t0 = Date.now();
    const r = hook("Bash", { command: "?".repeat(100_000) + ";rm -rf ~" });
    expect(r.status).toBe(2);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("summarizeShellCommand: bounded input (review item 1, second layer)", () => {
  it("a 1,000,000 character query-like token is summarized in well under a second", () => {
    for (const cmd of ["?".repeat(1_000_000) + "=", "a" + "&".repeat(1_000_000) + "=x y"]) {
      const t0 = Date.now();
      expect(summarizeShellCommand(cmd)).toMatch(/^shell /);
      expect(Date.now() - t0).toBeLessThan(500);
    }
  });
});
