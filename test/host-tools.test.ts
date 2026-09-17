import { describe, expect, it } from "vitest";
import { findHostToolTier } from "../src/host-tools.js";
import { evaluateOffline } from "../src/offline-evaluate.js";

describe("findHostToolTier", () => {
  it("classifies shell, write, and read names", () => {
    expect(findHostToolTier("Bash")).toBe("SHELL");
    expect(findHostToolTier("run_terminal_command")).toBe("SHELL");
    expect(findHostToolTier("Edit")).toBe("WRITE");
    expect(findHostToolTier("search_replace")).toBe("WRITE");
    expect(findHostToolTier("Read")).toBe("READ");
    expect(findHostToolTier("Grep")).toBe("READ");
  });

  it("is case-insensitive", () => {
    expect(findHostToolTier("read")).toBe("READ");
    expect(findHostToolTier("READ")).toBe("READ");
    expect(findHostToolTier("Search_Replace")).toBe("WRITE");
  });

  it("keeps MCP-qualified and unknown names unknown", () => {
    expect(findHostToolTier("mcp__linear__save")).toBeUndefined();
    expect(findHostToolTier("server__tool")).toBeUndefined();
    expect(findHostToolTier("TotallyUnknown")).toBeUndefined();
    expect(findHostToolTier("")).toBeUndefined();
    expect(findHostToolTier("  ")).toBeUndefined();
  });
});

describe("evaluateOffline host tool vocabulary", () => {
  it("Bash is REQUIRE_APPROVE / SHELL_EXEC", () => {
    const r = evaluateOffline({ toolId: "Bash" });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("SHELL_EXEC");
    expect(r.opaAllow).toBe(false);
  });

  it("Read is ALLOW / LOW_RISK_READ", () => {
    const r = evaluateOffline({ toolId: "Read" });
    expect(r.verdict).toBe("ALLOW");
    expect(r.reasonCode).toBe("LOW_RISK_READ");
    expect(r.opaAllow).toBe(true);
  });

  it("Write is REQUIRE_APPROVE / HIGH_STAKES_WRITE", () => {
    const r = evaluateOffline({ toolId: "Write" });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("HIGH_STAKES_WRITE");
  });

  it("grok-style search_replace is REQUIRE_APPROVE / HIGH_STAKES_WRITE", () => {
    const r = evaluateOffline({ toolId: "search_replace" });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("HIGH_STAKES_WRITE");
  });

  it("MCP-qualified names stay UNKNOWN_TOOL", () => {
    const r = evaluateOffline({ toolId: "mcp__linear__save" });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("UNKNOWN_TOOL");
  });

  it("unrecognized names stay UNKNOWN_TOOL", () => {
    const r = evaluateOffline({ toolId: "TotallyUnknown" });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("UNKNOWN_TOOL");
  });

  it("sample tools still win over the host vocabulary", () => {
    const r = evaluateOffline({
      toolId: "org.sample.never.event",
      irreversible: true,
      actionClass: "EXTERNAL_SIDE_EFFECT",
    });
    expect(r.verdict).toBe("DENY");
    expect(r.reasonCode).toBe("NEVER_EVENT");
  });

  it("host vocabulary never weakens an explicit irreversible signal", () => {
    const r = evaluateOffline({ toolId: "Read", irreversible: true });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("UNKNOWN_IRREVERSIBLE");
  });

  it("host vocabulary never weakens an explicit EXTERNAL_SIDE_EFFECT", () => {
    const r = evaluateOffline({
      toolId: "fetchurl",
      actionClass: "EXTERNAL_SIDE_EFFECT",
    });
    expect(r.verdict).toBe("DENY");
    expect(r.reasonCode).toBe("UNKNOWN_EXTERNAL_SIDE_EFFECT");
  });

  it("Edit with irreversible uses the irreversible path, not the vocabulary path", () => {
    const r = evaluateOffline({ toolId: "Edit", irreversible: true });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("UNKNOWN_IRREVERSIBLE");
  });
});
