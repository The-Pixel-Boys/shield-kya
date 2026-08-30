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
});
