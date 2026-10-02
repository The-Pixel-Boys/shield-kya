import { describe, expect, it, beforeEach } from "vitest";
import {
  buildHostedGatewayPayload,
  resetHostedSyncHash,
  syncGatewayToHosted,
  lastHostedSyncResult,
} from "../src/gate/hosted-sync.js";
import type { GatewaysConfig } from "../src/gate/config.js";

function cfg(overrides: Partial<GatewaysConfig> = {}): GatewaysConfig {
  return {
    port: 3930,
    otlpPort: 3931,
    failureMode: "failOpen",
    instanceId: "test-instance-id",
    servers: [],
    ...overrides,
  };
}

function sampleServers(): GatewaysConfig["servers"] {
  return [
    { id: "github", transport: "stdio", cmd: ["npx", "-y", "gh-mcp"] },
    { id: "exa", transport: "http", url: "https://mcp.exa.ai/mcp" },
  ];
}

describe("buildHostedGatewayPayload", () => {
  it("produces the hosted API contract shape from config + supervisor state", () => {
    const payload = buildHostedGatewayPayload({
      cwd: "/home/user/project",
      gatewaysConfig: cfg({ servers: sampleServers(), failureMode: "failClosed" }),
      supervisorState: {
        state: "running",
        url: "http://127.0.0.1:3930",
        port: 3930,
        startedAt: "2026-10-02T12:00:00.000Z",
        binaryVersion: "1.5.0",
      },
      baseUrl: "https://shield-agent.com",
      apiKey: "secret",
    });

    expect(payload.gatewayUid).toBe("test-instance-id");
    expect(payload.name).toBe("project");
    expect(payload.state).toBe("running");
    expect(payload.port).toBe(3930);
    expect(payload.otlpPort).toBe(3931);
    expect(payload.failureMode).toBe("failClosed");
    expect(payload.bindDetail).toContain("loopback-only");
    expect(payload.binaryVersion).toBe("1.5.0");
    expect(payload.startedAt).toBe("2026-10-02T12:00:00.000Z");

    expect(payload.config).toMatchObject({
      port: 3930,
      otlpPort: 3931,
      failureMode: "failClosed",
    });
    expect(payload.config.servers).toHaveLength(2);
    expect(payload.config.servers[0]).toMatchObject({
      id: "github",
      transport: "stdio",
      cmd: ["npx", "-y", "gh-mcp"],
    });
    expect(payload.config.servers[1]).toMatchObject({
      id: "exa",
      transport: "http",
      url: "https://mcp.exa.ai/mcp",
    });
  });

  it("falls back to cwd-basename name and config port when supervisor state is absent", () => {
    const payload = buildHostedGatewayPayload({
      cwd: "/tmp",
      gatewaysConfig: cfg({ port: 4100 }),
      baseUrl: "https://shield-agent.com",
      apiKey: "secret",
    });
    expect(payload.name).toBe("tmp");
    expect(payload.port).toBe(4100);
    expect(payload.state).toBe("not-set-up");
  });
});

describe("syncGatewayToHosted", () => {
  beforeEach(() => {
    resetHostedSyncHash();
  });

  it("POSTs the payload and short-circuits identical subsequent payloads", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const opts = {
      cwd: "/tmp",
      gatewaysConfig: cfg({ servers: sampleServers() }),
      supervisorState: { state: "running" as const, port: 3930 },
      baseUrl: "https://shield-agent.com",
      apiKey: "secret",
      fetchFn,
    };

    await syncGatewayToHosted(opts);
    await syncGatewayToHosted(opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://shield-agent.com/api/v1/kya/gateways");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(lastHostedSyncResult()?.ok).toBe(true);
  });

  it("sends again when the config changes", async () => {
    let calls = 0;
    const fetchFn = (): Promise<Response> => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const base = {
      cwd: "/tmp",
      gatewaysConfig: cfg(),
      supervisorState: { state: "configured-stopped" as const },
      baseUrl: "https://shield-agent.com",
      apiKey: "secret",
      fetchFn,
    };

    await syncGatewayToHosted(base);
    await syncGatewayToHosted(base);
    expect(calls).toBe(1);

    await syncGatewayToHosted({
      ...base,
      gatewaysConfig: cfg({ servers: sampleServers() }),
    });
    expect(calls).toBe(2);
  });

  it("is a no-op when baseUrl or apiKey is missing", async () => {
    let calls = 0;
    const fetchFn = (): Promise<Response> => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await syncGatewayToHosted({
      cwd: "/tmp",
      gatewaysConfig: cfg(),
      baseUrl: "",
      apiKey: "secret",
      fetchFn,
    });
    await syncGatewayToHosted({
      cwd: "/tmp",
      gatewaysConfig: cfg(),
      baseUrl: "https://shield-agent.com",
      apiKey: "",
      fetchFn,
    });
    expect(calls).toBe(0);
    expect(lastHostedSyncResult()).toBeUndefined();
  });

  it("swallows network errors and records the failure", async () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m) };
    await syncGatewayToHosted({
      cwd: "/tmp",
      gatewaysConfig: cfg(),
      supervisorState: { state: "running" as const },
      baseUrl: "https://shield-agent.com",
      apiKey: "secret",
      fetchFn: () => Promise.reject(new Error("network down")),
      logger,
    });
    expect(lastHostedSyncResult()?.ok).toBe(false);
    expect(lastHostedSyncResult()?.error).toContain("network down");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("network down");
  });

  it("logs a non-2xx response as a failure", async () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m) };
    await syncGatewayToHosted({
      cwd: "/tmp",
      gatewaysConfig: cfg(),
      supervisorState: { state: "running" as const },
      baseUrl: "https://shield-agent.com",
      apiKey: "secret",
      fetchFn: () => Promise.resolve(new Response("bad request", { status: 400 })),
      logger,
    });
    expect(lastHostedSyncResult()?.ok).toBe(false);
    expect(lastHostedSyncResult()?.error).toContain("HTTP 400");
    expect(warnings[0]).toContain("HTTP 400");
  });
});
