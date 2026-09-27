import { describe, expect, it } from "vitest";
import { governA2aSend } from "../src/sdk/a2a.js";
import type { ResolvedConfig } from "../src/config.js";
import { readTrail } from "../src/trail.js";

const offlineConfig: ResolvedConfig = {
  baseUrl: "http://127.0.0.1:8090",
  apiKey: "",
  host: "ide",
  agentId: undefined,
  mcpPort: 3920,
  tenantHint: undefined,
  cwd: "/tmp",
  configPath: "/tmp/.kya/config.json",
  json: false,
  allowMissingApiKey: true,
  offline: true,
  holdEnabled: false,
};

describe("governA2aSend", () => {
  it("registry-unknown a2a server falls to the safe REQUIRE_APPROVE/UNKNOWN path", async () => {
    const result = await governA2aSend({
      peerId: "researcher-7",
      action: "summarize",
      payloadSummary: "weekly digest draft",
      config: offlineConfig,
    });
    expect(result.verdict).toBe("REQUIRE_APPROVE");
    expect(result.reasonCode).toBe("UNKNOWN_TOOL");
    expect(result.allow).toBe(true);
    const events = readTrail("/tmp");
    const event = events[events.length - 1];
    expect(event?.toolId).toBe("a2a__researcher-7__summarize");
    expect(event?.verdict).toBe("REQUIRE_APPROVE");
    expect(event?.mode).toBe("offline");
  });

  it("irreversible sends stay on the REQUIRE_APPROVE path", async () => {
    const result = await governA2aSend({
      peerId: "payments-agent",
      peerUrl: "https://a2a.example/payments",
      action: "refund",
      irreversible: true,
      config: offlineConfig,
    });
    expect(result.verdict).toBe("REQUIRE_APPROVE");
    expect(result.reasonCode).toBe("UNKNOWN_IRREVERSIBLE");
    expect(result.allow).toBe(true);
  });

  it("works config-less (offline default, caller still owns the send)", async () => {
    const result = await governA2aSend({
      peerId: "helper-1",
      action: "ping",
    });
    expect(result.allow).toBe(true);
    expect(result.verdict).toBe("REQUIRE_APPROVE");
  });
});
