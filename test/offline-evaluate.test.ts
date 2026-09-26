import { describe, expect, it } from "vitest";
import { applySessionRisk, evaluateOffline } from "../src/offline-evaluate.js";

describe("offline-evaluate", () => {
  it("DENY never.event", () => {
    const r = evaluateOffline({
      toolId: "org.sample.never.event",
      irreversible: true,
      actionClass: "EXTERNAL_SIDE_EFFECT",
    });
    expect(r.verdict).toBe("DENY");
    expect(r.reasonCode).toBe("NEVER_EVENT");
  });

  it("REQUIRE_APPROVE data.write", () => {
    const r = evaluateOffline({
      toolId: "org.sample.data.write",
      irreversible: true,
      actionClass: "WRITE",
    });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
  });

  it("ALLOW safe.read", () => {
    const r = evaluateOffline({
      toolId: "org.sample.safe.read",
      irreversible: false,
      actionClass: "READ",
    });
    expect(r.verdict).toBe("ALLOW");
  });

  it("session risk raises ALLOW only", () => {
    expect(
      applySessionRisk({ verdict: "ALLOW", reasonCode: "ALLOW" }, "HIGH"),
    ).toEqual({ verdict: "REQUIRE_APPROVE", reasonCode: "SESSION_RISK_HIGH" });
    expect(
      applySessionRisk({ verdict: "DENY", reasonCode: "NEVER_EVENT" }, "HIGH"),
    ).toEqual({ verdict: "DENY", reasonCode: "NEVER_EVENT" });
  });

  it("unknown irreversible requires approve", () => {
    const r = evaluateOffline({
      toolId: "org.custom.mystery.write",
      irreversible: true,
      actionClass: "WRITE",
    });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
  });

  it("case-folded never.event is still DENY", () => {
    const r = evaluateOffline({
      toolId: "ORG.SAMPLE.NEVER.EVENT",
      irreversible: false,
    });
    expect(r.verdict).toBe("DENY");
    expect(r.opaAllow).toBe(false);
  });

  it("unknown tool without irreversible is REQUIRE_APPROVE not ALLOW", () => {
    const r = evaluateOffline({ toolId: "shell.exec" });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("UNKNOWN_TOOL");
    expect(r.opaAllow).toBe(false);
  });

  it("DENY sets opaAllow false", () => {
    const r = evaluateOffline({
      toolId: "org.sample.never.event",
      irreversible: true,
    });
    expect(r.opaAllow).toBe(false);
  });

  it("sandbox exec without sandboxId is DENY MISSING_SANDBOX_ID", () => {
    const r = evaluateOffline({
      toolId: "org.sample.sandbox.exec",
      irreversible: true,
      actionClass: "EXTERNAL_SIDE_EFFECT",
      env: { host: "runtime" },
    });
    expect(r.verdict).toBe("DENY");
    expect(r.reasonCode).toBe("MISSING_SANDBOX_ID");
  });

  it("sandbox exec with sandboxId is REQUIRE_APPROVE", () => {
    const r = evaluateOffline({
      toolId: "org.sample.sandbox.exec",
      irreversible: true,
      actionClass: "EXTERNAL_SIDE_EFFECT",
      env: { host: "runtime", sandboxId: "sbx-1" },
    });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).not.toBe("MISSING_SANDBOX_ID");
  });

  it("MCP read tools from known servers are ALLOW", () => {
    for (const toolId of [
      "mcp__github__get_issue",
      "mcp__playwright__browser_snapshot",
      "mcp__filesystem__read_file",
      "mcp__context7__resolve-library-id",
      "mcp__slack__list_channels",
      "exa__web_search_exa",
    ]) {
      const r = evaluateOffline({ toolId });
      expect(r.verdict, toolId).toBe("ALLOW");
      expect(r.reasonCode, toolId).toBe("LOW_RISK_READ");
    }
  });

  it("MCP write tools from known servers are REQUIRE_APPROVE", () => {
    for (const toolId of [
      "mcp__github__create_issue",
      "mcp__playwright__browser_navigate",
      "mcp__notion__create_page",
      "mcp__postgresql__execute_sql",
      "mcp__n8n__trigger_webhook_workflow",
    ]) {
      const r = evaluateOffline({ toolId });
      expect(r.verdict, toolId).toBe("REQUIRE_APPROVE");
      expect(r.reasonCode, toolId).toBe("HIGH_STAKES_WRITE");
    }
  });

  it("clearly destructive MCP admin tools are DENY NEVER_EVENT", () => {
    for (const toolId of [
      "mcp__postgresql__drop_table",
      "mcp__postgresql__truncate_table",
    ]) {
      const r = evaluateOffline({ toolId });
      expect(r.verdict, toolId).toBe("DENY");
      expect(r.reasonCode, toolId).toBe("NEVER_EVENT");
    }
  });

  it("non-destructive MCP admin tools are REQUIRE_APPROVE HIGH_STAKES_ADMIN", () => {
    for (const toolId of [
      "mcp__github__merge_pull_request",
      "mcp__github__delete_branch",
      "mcp__slack__delete_message",
    ]) {
      const r = evaluateOffline({ toolId });
      expect(r.verdict, toolId).toBe("REQUIRE_APPROVE");
      expect(r.reasonCode, toolId).toBe("HIGH_STAKES_ADMIN");
    }
  });

  it("explicit irreversible still wins over the MCP registry", () => {
    const r = evaluateOffline({ toolId: "mcp__github__get_issue", irreversible: true });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("UNKNOWN_IRREVERSIBLE");
  });

  it("explicit actionClass still wins over the MCP registry", () => {
    const r = evaluateOffline({
      toolId: "mcp__github__get_issue",
      actionClass: "EXTERNAL_SIDE_EFFECT",
    });
    expect(r.verdict).toBe("DENY");
    expect(r.reasonCode).toBe("UNKNOWN_EXTERNAL_SIDE_EFFECT");
  });

  it("unknown MCP servers stay UNKNOWN_TOOL", () => {
    const r = evaluateOffline({ toolId: "mcp__acme-internal__get_thing" });
    expect(r.verdict).toBe("REQUIRE_APPROVE");
    expect(r.reasonCode).toBe("UNKNOWN_TOOL");
  });

  it("destructive MCP admin names DENY even under explicit risk flags", () => {
    const irreversible = evaluateOffline({
      toolId: "mcp__postgresql__drop_table",
      irreversible: true,
    });
    expect(irreversible.verdict).toBe("DENY");
    expect(irreversible.reasonCode).toBe("NEVER_EVENT");
    const withClass = evaluateOffline({
      toolId: "mcp__postgresql__truncate_table",
      actionClass: "WRITE",
    });
    expect(withClass.verdict).toBe("DENY");
    expect(withClass.reasonCode).toBe("NEVER_EVENT");
  });

  it("single-dot MCP syntax tiers like the others; multi-segment stays UNKNOWN", () => {
    const r = evaluateOffline({ toolId: "github.get_repo" });
    expect(r.verdict).toBe("ALLOW");
    expect(r.reasonCode).toBe("LOW_RISK_READ");
    const bogus = evaluateOffline({ toolId: "github.get_repo.stuff" });
    expect(bogus.verdict).toBe("REQUIRE_APPROVE");
    expect(bogus.reasonCode).toBe("UNKNOWN_TOOL");
  });

  it("tightened defaults keep mutating/unknown MCP tools at REQUIRE_APPROVE", () => {
    for (const toolId of [
      "atlassian__jira_link_to_epic",
      "atlassian__jira_remove_issue_link",
      "sentry__analyze_issue_with_seer",
      "filesystem__edit_many_files",
      "fetch__http_post",
    ]) {
      const r = evaluateOffline({ toolId });
      expect(r.verdict, toolId).toBe("REQUIRE_APPROVE");
      expect(r.reasonCode, toolId).toBe("HIGH_STAKES_WRITE");
    }
  });
});
