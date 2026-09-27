import { afterEach, describe, expect, it } from "vitest";
import {
  deriveSdkToolId,
  governed,
  KyaDeniedError,
} from "../src/sdk/govern.js";
import { KyaError } from "../src/errors.js";
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

function lastTrailEvent() {
  const events = readTrail("/tmp");
  return events[events.length - 1];
}

describe("governed", () => {
  it("ALLOW runs fn, returns its result, and records the trail", async () => {
    let ran = 0;
    const fn = governed({
      toolId: "org.sample.safe.read",
      config: offlineConfig,
      fn: (args: { q: string }) => {
        ran += 1;
        return { echo: args.q };
      },
    });
    const result = await fn({ q: "hi" });
    expect(result).toEqual({ echo: "hi" });
    expect(ran).toBe(1);
    const event = lastTrailEvent();
    expect(event?.toolId).toBe("org.sample.safe.read");
    expect(event?.verdict).toBe("ALLOW");
    expect(event?.mode).toBe("offline");
  });

  it("REQUIRE_APPROVE runs fn under observe semantics and records the review", async () => {
    let ran = 0;
    const fn = governed({
      toolId: "org.sample.data.write",
      irreversible: true,
      config: offlineConfig,
      fn: () => {
        ran += 1;
        return "done";
      },
    });
    await expect(fn({})).resolves.toBe("done");
    expect(ran).toBe(1);
    const event = lastTrailEvent();
    expect(event?.verdict).toBe("REQUIRE_APPROVE");
    expect(event?.reasonCode).toBe("HIGH_STAKES_WRITE");
  });

  it("DENY throws KyaDeniedError without running fn, and still records the trail", async () => {
    let ran = 0;
    const fn = governed({
      toolId: "org.sample.never.event",
      irreversible: true,
      config: offlineConfig,
      fn: () => {
        ran += 1;
        return "never";
      },
    });
    const err = await fn({}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(ran).toBe(0);
    expect(err).toBeInstanceOf(KyaDeniedError);
    expect(err).toBeInstanceOf(KyaError);
    const denied = err as KyaDeniedError;
    expect(denied.name).toBe("KyaDeniedError");
    expect(denied.code).toBe("KYA_DENIED");
    expect(denied.verdict).toBe("DENY");
    expect(denied.reasonCode).toBe("NEVER_EVENT");
    expect(denied.toolId).toBe("org.sample.never.event");
    const event = lastTrailEvent();
    expect(event?.verdict).toBe("DENY");
    expect(event?.neverEvent).toBe(true);
  });

  it("defaults to config-less offline evaluate (no network, no hosted plane)", async () => {
    const fn = governed({
      toolId: "org.sample.safe.read",
      fn: () => "ok",
    });
    await expect(fn({})).resolves.toBe("ok");
    expect(lastTrailEvent()?.mode).toBe("offline");
  });

  it("derives server-prefixed toolIds so the MCP taxonomy applies", async () => {
    expect(deriveSdkToolId("read_file", "filesystem")).toBe("filesystem__read_file");
    expect(deriveSdkToolId("read_file")).toBe("read_file");
    const fn = governed({
      toolId: "read_file",
      server: "filesystem",
      config: offlineConfig,
      fn: () => "contents",
    });
    await expect(fn({ path: "a.txt" })).resolves.toBe("contents");
    const event = lastTrailEvent();
    expect(event?.toolId).toBe("filesystem__read_file");
    expect(event?.verdict).toBe("ALLOW");
  });

  it("server-prefixed destructive names on known servers deny", async () => {
    let ran = 0;
    const fn = governed({
      toolId: "drop_table",
      server: "github",
      config: offlineConfig,
      fn: () => {
        ran += 1;
      },
    });
    const err = await fn({}).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(ran).toBe(0);
    expect(err).toBeInstanceOf(KyaDeniedError);
    expect((err as KyaDeniedError).toolId).toBe("github__drop_table");
    expect((err as KyaDeniedError).reasonCode).toBe("NEVER_EVENT");
  });

  describe("KYA_SEND_PREVIEWS", () => {
    afterEach(() => {
      delete process.env.KYA_SEND_PREVIEWS;
    });

    it("on (default): change fields land on the trail event", async () => {
      const fn = governed({
        toolId: "Write",
        config: offlineConfig,
        fn: () => "wrote",
      });
      await fn({ path: "src/app.ts", content: "const a = 1;" });
      const event = lastTrailEvent();
      expect(event?.verdict).toBe("REQUIRE_APPROVE");
      expect(event?.summary).toContain("write src/app.ts");
      expect(event?.targetPath).toBe("src/app.ts");
    });

    it("off: change fields stay off the trail event", async () => {
      process.env.KYA_SEND_PREVIEWS = "0";
      const fn = governed({
        toolId: "Write",
        config: offlineConfig,
        fn: () => "wrote",
      });
      await fn({ path: "src/app.ts", content: "const a = 1;" });
      const event = lastTrailEvent();
      expect(event?.verdict).toBe("REQUIRE_APPROVE");
      expect(event?.summary).toBeUndefined();
      expect(event?.targetPath).toBeUndefined();
      expect(event?.diffPreview).toBeUndefined();
    });
  });
});
