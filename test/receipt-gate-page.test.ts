// test/receipt-gate-page.test.ts
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateGatewayTool, loadGatePage, type GatePage } from "../src/receipt/gate-page.js";
import { writeGateState } from "../src/gate/daemon.js";
import { buildWindowReceiptModel, renderReceiptHtml } from "../src/receipt/render-receipt.js";
import type { TrailEvent } from "../src/trail.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-gate-page-"));
}

function env(home: string): NodeJS.ProcessEnv {
  return { KYA_HOME: home };
}

function writeGateways(home: string, servers: unknown[]): void {
  const path = join(home, ".kya", "gateways.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ port: 3930, servers }), "utf8");
}

function fakeBinary(home: string, version = "1.5.0"): void {
  const path = join(home, ".kya", "bin", "kya-gate");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      `if (process.argv.includes("--version")) { console.log(JSON.stringify({ version: "${version}" })); process.exit(0); }`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
}

function ev(partial: Partial<TrailEvent>): TrailEvent {
  return {
    ts: new Date().toISOString(),
    sessionId: "sess-gate",
    toolId: "github__get_issue",
    verdict: "ALLOW",
    reasonCode: "ALLOW",
    mode: "observe",
    ...partial,
  };
}

const GITHUB = { id: "github", transport: "stdio", cmd: ["npx", "-y", "gh-mcp"] };
const ACME = { id: "acme", transport: "http", url: "https://mcp.example.com/mcp" };

describe("evaluateGatewayTool", () => {
  it("denies destructive tool names on every server", () => {
    const r = evaluateGatewayTool("github", "drop_table");
    expect(r.verdict).toBe("deny");
    expect(r.reason).toContain("destructive/admin pattern");
  });

  it("denies admin-tier registry patterns", () => {
    const r = evaluateGatewayTool("github", "delete_repo");
    expect(r.verdict).toBe("deny");
  });

  it("allows read tools", () => {
    const r = evaluateGatewayTool("github", "get_issue");
    expect(r.verdict).toBe("allow");
    expect(r.reason).toContain("observe mode");
  });

  it("allows write tools (observed, not blocked)", () => {
    const r = evaluateGatewayTool("github", "create_issue");
    expect(r.verdict).toBe("allow");
  });

  it("matches the gateway's case-sensitive CEL behavior", () => {
    // The gateway's mcp.tool.name.matches(...) is case-sensitive, so the
    // dry-run evaluator mirrors that exactly.
    expect(evaluateGatewayTool("github", "DROP_TABLE").verdict).toBe("allow");
    expect(evaluateGatewayTool("github", "drop_table").verdict).toBe("deny");
    expect(evaluateGatewayTool("github", "get_issue").verdict).toBe("allow");
  });
});

describe("loadGatePage", () => {
  it("extends GateCard with config-derived policy and bind scope", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB, ACME]);
      fakeBinary(home, "1.2.3");
      const page = loadGatePage([], env(home));
      expect(page.state).toBe("configured-stopped");
      expect(page.failureMode).toBe("failOpen");
      expect(page.servers).toHaveLength(2);
      expect(page.binaryPresent).toBe(true);
      expect(page.binaryVersion).toBe("1.2.3");
      expect(page.bindScope.loopbackOnly).toBe(false);
      expect(page.gateEvents).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reuses GateCard events/worst instead of recomputing", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB]);
      const events = [
        ev({ toolId: "github__get_issue", verdict: "ALLOW" }),
        ev({ toolId: "github__merge_pr", verdict: "DENY" }),
      ];
      const page = loadGatePage(events, env(home));
      expect(page.events).toBe(2);
      expect(page.servers[0]!.events).toBe(2);
      expect(page.servers[0]!.worst).toBe("deny");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("collects denied tool names from gate events", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB]);
      const events = [
        ev({ toolId: "github__drop_table", verdict: "DENY", reasonCode: "NEVER_EVENT" }),
        ev({ toolId: "github__drop_database", verdict: "DENY", reasonCode: "NEVER_EVENT" }),
        ev({ toolId: "github__get_issue", verdict: "ALLOW" }),
      ];
      const page = loadGatePage(events, env(home));
      const denied = page.servers[0]!.deniedTools;
      expect(denied).toContain("drop_table");
      expect(denied).toContain("drop_database");
      expect(denied).not.toContain("get_issue");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("surfaces importedFrom or defaults to manual", () => {
    const home = tmp();
    try {
      writeGateways(home, [
        { ...GITHUB, importedFrom: ["cursor", "claude"] },
        ACME,
      ]);
      const page = loadGatePage([], env(home));
      expect(page.servers[0]!.importedFrom).toEqual(["cursor", "claude"]);
      expect(page.servers[1]!.importedFrom).toEqual(["manual"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("running state carries url/port/startedAt and otlpPort", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB]);
      fakeBinary(home);
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      writeGateState(
        { pid: process.pid, url: "http://127.0.0.1:3930", port: 3930, otlpPort: 3931, startedAt },
        env(home),
      );
      const page = loadGatePage([], env(home));
      expect(page.state).toBe("running");
      expect(page.url).toBe("http://127.0.0.1:3930");
      expect(page.port).toBe(3930);
      expect(page.otlpPort).toBe(3931);
      expect(page.startedAt).toBe(startedAt);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("derives listeners, routes, policy summary, and playground samples", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB, ACME]);
      fakeBinary(home);
      writeGateState(
        { pid: process.pid, url: "http://127.0.0.1:3930", port: 3930, otlpPort: 3931, startedAt: new Date().toISOString() },
        env(home),
      );
      const events = [
        ev({ toolId: "github__get_issue", verdict: "ALLOW" }),
        ev({ toolId: "github__drop_table", verdict: "DENY", reasonCode: "NEVER_EVENT", neverEvent: true }),
        ev({ toolId: "acme__fetch", verdict: "ALLOW" }),
      ];
      const page = loadGatePage(events, env(home));

      expect(page.listeners).toHaveLength(2);
      expect(page.listeners[0]!.name).toBe("MCP listener");
      expect(page.listeners[0]!.state).toBe("running");
      expect(page.listeners[1]!.name).toBe("OTLP receiver");

      expect(page.routes).toHaveLength(2);
      expect(page.routes[0]!).toMatchObject({ pattern: "github__*", backend: "github", tier: "WRITE" });
      expect(page.routes[1]!).toMatchObject({ pattern: "acme__*", backend: "acme", tier: undefined });

      expect(page.policySummary.networkRule).toContain("127.0.0.0/8");
      expect(page.policySummary.totalPolicies).toBe(3);
      expect(page.policySummary.verdicts).toEqual({ allow: 2, deny: 0, hold: 0, never: 1 });

      expect(page.playgroundSamples).toContain("fetch");
      expect(page.playgroundSamples).toContain("drop_table");
      expect(page.playgroundSamples).toContain("get_issue");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Gateway dashboard escaping", () => {
  it("escapes hostile server ids, commands, urls, provenance, and tool names", () => {
    const xss = '<script>alert(1)</script>';
    const page: GatePage = {
      state: "running",
      servers: [
        {
          id: `evil-${xss}`,
          transport: "stdio",
          cmd: ["node", xss],
          events: 1,
          worst: "deny",
          serverFacet: `Facet-${xss}`,
          importedFrom: ["cursor", xss],
          policy: { defaultTier: "WRITE", denyPatterns: [] },
          deniedTools: [xss],
        },
        {
          id: "http-evil",
          transport: "http",
          url: `http://127.0.0.1/mcp?${xss}`,
          events: 0,
          worst: "none",
          serverFacet: "http-evil",
          importedFrom: ["manual"],
          policy: { defaultTier: "READ", denyPatterns: [] },
          deniedTools: [],
        },
      ],
      events: 1,
      gateEvents: [
        {
          ts: new Date().toISOString(),
          sessionId: "s",
          toolId: `evil-${xss}__do_thing`,
          verdict: "DENY",
          reasonCode: "NEVER_EVENT",
          neverEvent: true,
          mode: "observe",
        },
      ],
      url: `http://127.0.0.1:3930/${xss}`,
      port: 3930,
      otlpPort: 3931,
      startedAt: new Date().toISOString(),
      binaryPresent: true,
      binaryVersion: `1.0.0-${xss}`,
      binaryPath: `/Users/evil/.kya/bin/${xss}`,
      failureMode: "failOpen",
      bindScope: { loopbackOnly: true, detail: `127.0.0.0/8 ${xss}` },
      listeners: [
        { name: `MCP-${xss}`, protocol: "MCP", address: `port ${xss}`, state: "running", detail: xss },
        { name: "OTLP", protocol: "OTLP/HTTP", address: "port 3931", state: "running" },
      ],
      routes: [
        {
          pattern: `evil-${xss}__*`,
          backend: `evil-${xss}`,
          backendLabel: `Facet-${xss}`,
          tier: "WRITE",
          denyCount: 1,
          events: 1,
          worst: "deny",
          deniedTools: [xss],
        },
      ],
      policySummary: {
        networkRule: `127.0.0.0/8 ${xss}`,
        failureMode: "failOpen",
        totalPolicies: 2,
        verdicts: { allow: 0, deny: 0, hold: 0, never: 1 },
      },
      playgroundSamples: [xss, "do_thing"],
    };
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { gate: page }));
    expect(html).not.toContain(xss);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Verify the Gateway pages rendered and carried the data-server facet escaped.
    expect(html).toContain('id="gateway-home"');
    expect(html).toContain('id="gateway-listeners"');
    expect(html).toContain('id="gateway-routes"');
    expect(html).toContain('id="gateway-backends"');
    expect(html).toContain('id="gateway-policies"');
    expect(html).toContain('id="gateway-playground"');
    expect(html).toContain('data-server="Facet-&lt;script&gt;alert(1)&lt;/script&gt;"');
  });
});
