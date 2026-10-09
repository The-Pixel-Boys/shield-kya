// test/receipt-gate-panel.test.ts
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadGateCard, type GateCard } from "../src/receipt/gate-card.js";
import { toolServerPrefix, type GatePage } from "../src/receipt/gate-page.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../src/receipt/render-receipt.js";
import { writeGateState } from "../src/gate/daemon.js";
import type { TrailEvent } from "../src/trail.js";

/**
 * Gateway card (model + panel): the report surfaces the local gateway in all
 * three states (not-set-up / configured-stopped / running), with per-server
 * event counts and worst verdict from the window's trail events, fail-safe
 * degradation on missing/corrupt state, and full escaping of the
 * user-editable state files.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-gate-card-"));
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
      'setInterval(() => {}, 1000);',
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

describe("loadGateCard model", () => {
  it("not-set-up when gateways.json is missing or has zero servers", () => {
    const home = tmp();
    try {
      const missing = loadGateCard([], env(home));
      expect(missing.state).toBe("not-set-up");
      expect(missing.servers).toEqual([]);
      expect(missing.events).toBe(0);
      expect(missing.binaryPresent).toBe(false);
      expect(missing.url).toBeUndefined();

      writeGateways(home, []);
      expect(loadGateCard([], env(home)).state).toBe("not-set-up");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("corrupt gateways.json degrades to not-set-up instead of throwing", () => {
    const home = tmp();
    try {
      const path = join(home, ".kya", "gateways.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{ not json", "utf8");
      expect(loadGateCard([], env(home)).state).toBe("not-set-up");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("configured-stopped with per-server counts and worst verdict from the window", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB, ACME]);
      const events = [
        ev({ toolId: "github__get_issue" }),
        ev({ toolId: "github__merge_pr", verdict: "DENY" }),
        ev({ toolId: "acme__search", verdict: "REQUIRE_APPROVE" }),
        ev({ toolId: "org.sample.safe.read" }), // not a configured server
        ev({ toolId: "other__thing" }), // gateway shape, not configured
      ];
      const card = loadGateCard(events, env(home));
      expect(card.state).toBe("configured-stopped");
      expect(card.events).toBe(3);
      expect(card.servers).toHaveLength(2);
      const github = card.servers[0]!;
      expect(github).toMatchObject({ id: "github", transport: "stdio", events: 2, worst: "deny" });
      expect(github.serverFacet).toBe("GitHub");
      const acme = card.servers[1]!;
      expect(acme).toMatchObject({ id: "acme", transport: "http", events: 1, worst: "hold" });
      expect(acme.serverFacet).toBe("acme"); // unknown id: facet falls back to the id
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("worst verdict ranks never above deny above hold above allow", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB, ACME]);
      const events = [
        ev({ toolId: "github__a", verdict: "DENY" }),
        ev({ toolId: "github__b", verdict: "REQUIRE_APPROVE" }),
        ev({ toolId: "github__c", reasonCode: "NEVER_EVENT", neverEvent: true }),
        ev({ toolId: "acme__a" }),
      ];
      const card = loadGateCard(events, env(home));
      expect(card.servers[0]!.worst).toBe("never");
      expect(card.servers[1]!.worst).toBe("allow");
      expect(loadGateCard([], env(home)).servers[0]!.worst).toBe("none");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("running when the state file pid is alive, carrying listener url/port/startedAt", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB]);
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      writeGateState(
        { pid: process.pid, url: "http://127.0.0.1:3930", port: 3930, otlpPort: 3931, startedAt },
        env(home),
      );
      const card = loadGateCard([ev({})], env(home));
      expect(card.state).toBe("running");
      expect(card.url).toBe("http://127.0.0.1:3930");
      expect(card.port).toBe(3930);
      expect(card.startedAt).toBe(startedAt);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stale state file (dead pid) reads as configured-stopped", async () => {
    const home = tmp();
    const dead = spawn("sleep", ["0"]);
    await new Promise((r) => dead.once("exit", r));
    try {
      writeGateways(home, [GITHUB]);
      writeGateState(
        {
          pid: dead.pid!,
          url: "http://127.0.0.1:3930",
          port: 3930,
          otlpPort: 3931,
          startedAt: new Date().toISOString(),
        },
        env(home),
      );
      const card = loadGateCard([], env(home));
      expect(card.state).toBe("configured-stopped");
      expect(card.url).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("running wins over empty servers (a live listener with zero targets is not not-set-up)", () => {
    const home = tmp();
    try {
      writeGateways(home, []);
      writeGateState(
        {
          pid: process.pid,
          url: "http://127.0.0.1:3930",
          port: 3930,
          otlpPort: 3931,
          startedAt: new Date().toISOString(),
        },
        env(home),
      );
      const card = loadGateCard([], env(home));
      expect(card.state).toBe("running");
      const html = renderWith(card);
      expect(html).toContain('<span class="pill ok">running</span>');
      expect(html).toContain("Backends");
      expect(html).toContain('<span class="num">0</span>');
      expect(html).not.toContain("Gateway not set up");
      // …and the third ordering: stopped + servers is still configured-stopped.
      expect(loadGateCard([], env(home)).servers).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("non-string startedAt in the state file is dropped, not rendered", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB]);
      const path = join(home, ".kya", "gate-server.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          pid: process.pid,
          url: "http://127.0.0.1:3930",
          port: 3930,
          otlpPort: 3931,
          startedAt: {},
        }),
        "utf8",
      );
      const card = loadGateCard([], env(home));
      expect(card.state).toBe("running");
      expect(card.startedAt).toBeUndefined();
      const html = renderWith(card);
      expect(html).toContain('<span class="pill ok">running</span>');
      expect(html).not.toContain("up since");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("markdown flattens newline injection from the user-editable state file", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB]);
      writeGateState(
        {
          pid: process.pid,
          url: "http://127.0.0.1:3930/mcp\n# fake heading",
          port: 3930,
          otlpPort: 3931,
          startedAt: new Date().toISOString(),
        },
        env(home),
      );
      const card = loadGateCard([], env(home));
      const md = renderReceiptMarkdown(buildWindowReceiptModel([], 3, { gate: card }));
      expect(md).not.toContain("\n# fake heading");
      expect(md).toContain("running - `http://127.0.0.1:3930/mcp # fake heading`");
      // binaryVersion gets the same treatment.
      const md2 = renderReceiptMarkdown(
        buildWindowReceiptModel([], 3, {
          gate: { ...RUNNING_CARD, binaryVersion: "1.5.0\n# fake heading" },
        }),
      );
      expect(md2).not.toContain("\n# fake heading");
      expect(md2).toContain("binary 1.5.0 # fake heading");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("binary version surfaces when the pinned binary answers --version", () => {
    const home = tmp();
    try {
      writeGateways(home, [GITHUB]);
      fakeBinary(home, "9.9.9");
      const card = loadGateCard([], env(home));
      expect(card.binaryPresent).toBe(true);
      expect(card.binaryVersion).toBe("9.9.9");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const RUNNING_CARD: GateCard = {
  state: "running",
  servers: [
    { id: "github", transport: "stdio", events: 2, worst: "deny", serverFacet: "GitHub" },
    { id: "acme", transport: "http", events: 0, worst: "none", serverFacet: "acme" },
  ],
  events: 2,
  url: "http://127.0.0.1:3930",
  port: 3930,
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  binaryPresent: true,
  binaryVersion: "1.5.0",
};

const STOPPED_CARD: GateCard = {
  state: "configured-stopped",
  servers: [{ id: "github", transport: "stdio", events: 0, worst: "none", serverFacet: "GitHub" }],
  events: 0,
  binaryPresent: false,
};

const FRESH_CARD: GateCard = {
  state: "not-set-up",
  servers: [],
  events: 0,
  binaryPresent: false,
};

function renderWith(card: GateCard, events: TrailEvent[] = []): string {
  const configured = new Set(card.servers.map((s) => s.id));
  const gateEvents = events.filter((e) => {
    const id = toolServerPrefix(e.toolId);
    return id !== undefined && configured.has(id);
  });
  const servers = card.servers.map((s) => ({
    ...s,
    importedFrom: ["manual"],
    policy: { defaultTier: s.id === "github" ? "WRITE" : undefined, denyPatterns: [] },
    deniedTools: [],
  }));
  const page: GatePage = {
    ...card,
    failureMode: "failOpen",
    otlpPort: 3931,
    bindScope: { loopbackOnly: true, detail: "loopback-only" },
    binaryPath: "/home/test/.kya/bin/kya-gate",
    gateEvents,
    servers,
    listeners:
      card.state === "not-set-up"
        ? []
        : [
            { name: "MCP listener", protocol: "MCP over HTTP", address: "http://127.0.0.1:3930", state: card.state === "running" ? "running" : "stopped", detail: "local proxy" },
            { name: "OTLP receiver", protocol: "OTLP/HTTP", address: "port 3931", state: card.state === "running" ? "running" : "stopped", detail: "telemetry" },
          ],
    routes: servers.map((s) => ({
      pattern: `${s.id}__*`,
      backend: s.id,
      backendLabel: s.serverFacet,
      tier: s.policy.defaultTier,
      denyCount: s.policy.denyPatterns.length,
      events: s.events,
      worst: s.worst,
      deniedTools: s.deniedTools,
    })),
    policySummary: {
      networkRule: "127.0.0.0/8",
      failureMode: "failOpen",
      totalPolicies: 1 + servers.length,
      verdicts: { allow: 0, deny: 0, hold: 0, never: 0 },
    },
    playgroundSamples: [],
  };
  return renderReceiptHtml(buildWindowReceiptModel(events, 3, { gate: page }));
}

describe("gateway panel render", () => {
  it("not-set-up: quickstart on Gateway Home, slim System panel", () => {
    const html = renderWith(FRESH_CARD);
    expect(html).toContain('id="gateway-home"');
    expect(html).toContain('id="gateway-home"');
    expect(html).toContain("not set up");
    expect(html).toContain("kya gate init");
    expect(html).toContain("kya start");
    expect(html).toContain("routes it through the gateway automatically");
    expect(html).toContain("Doctor");
    // The Gateway hero tile (not the Home quickstart) prompts for setup.
    expect(html.match(/kya gate setup/g)).toHaveLength(1);
    expect(html).not.toContain('class="panel hero-gate"');
    expect(html).toContain('class="panel gate"');
    expect(html).toContain("Open Gateway");
  });

  it("configured-stopped: status on Home, servers on Backends, slim System panel", () => {
    const html = renderWith(STOPPED_CARD);
    expect(html).toContain('id="gateway-home"');
    expect(html).toContain('id="gateway-backends"');
    expect(html).toContain("<span class=\"pill\">stopped</span>");
    expect(html).toContain("1 server configured");
    expect(html).toContain("binary missing - kya gate setup");
    expect(html).toContain("<code>github</code>");
    expect(html).toContain("stdio");
  });

  it("running: listener, uptime, per-server counts + worst verdict", () => {
    const html = renderWith(RUNNING_CARD, [ev({}), ev({ toolId: "github__merge_pr", verdict: "DENY" })]);
    expect(html).toContain('id="gateway-home"');
    expect(html).toContain('id="gateway-backends"');
    expect(html).toContain('<span class="pill ok">running</span>');
    expect(html).toContain("http://127.0.0.1:3930");
    expect(html).toContain("up since");
    expect(html).toContain("Binary <code>1.5.0</code>");
    expect(html).toContain("<code>github</code>");
    expect(html).toContain("stdio");
    expect(html).toContain('<span class="wdot deny"');
    expect(html).toContain("Gateway events");
  });

  it("per-server rows carry data-server aligned with the feed's Servers facet", () => {
    const html = renderWith(RUNNING_CARD, [ev({})]);
    // Known id: both the feed article and the gateway Backends table use the registry label.
    expect(html).toContain('<article class="ev ok" data-verdict="ALLOW" data-mode="observe" data-plane="unknown" data-product="other" data-tool="github__get_issue" data-session="sess-gate" data-server="GitHub">');
    expect(html).toContain('data-server="GitHub"');
    // Unknown id: no feed stamp exists; the row still carries the id itself.
    expect(html).toContain('data-server="acme"');
  });

  it("escapes the user-editable state file (hostile listener url)", () => {
    const hostile: GateCard = {
      ...RUNNING_CARD,
      url: 'http://127.0.0.1:3930"><script>alert(1)</script>',
    };
    const html = renderWith(hostile);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("markdown artifact carries the gateway section in every state", () => {
    const fresh = renderReceiptMarkdown(buildWindowReceiptModel([], 3, { gate: FRESH_CARD }));
    expect(fresh).toContain("## Gateway");
    expect(fresh).toContain("not set up - Add any MCP server to a host config");
    expect(fresh).toContain("`kya start` routes it through the gateway automatically");
    const running = renderReceiptMarkdown(buildWindowReceiptModel([], 3, { gate: RUNNING_CARD }));
    expect(running).toContain("running - `http://127.0.0.1:3930`");
    expect(running).toContain("`github` - stdio · 2 events, worst: deny");
    expect(running).toContain("`acme` - http · 0 events");
  });

  it("no gate card renders no gateway chrome (model extra is optional)", () => {
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, {}));
    expect(html).not.toContain("hero-gate");
    expect(html).not.toContain('aria-label="Gateway"');
  });
});
