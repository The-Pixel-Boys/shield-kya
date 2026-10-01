#!/usr/bin/env node
/**
 * Visual verification for the redesigned kya report.
 * Generates static HTML fixtures and uses headless Chrome to screenshot
 * every section in dark and light, plus empty/populated Gateway states.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = process.argv[2] || join(tmpdir(), "kya-report-screenshots");
const distRoot = fileURLToPath(new URL("../dist", import.meta.url));

const { buildWindowReceiptModel, renderReceiptHtml } = await import(
  join(distRoot, "receipt/render-receipt.js")
);

const now = new Date();
const iso = (offsetMin) => new Date(now.getTime() - offsetMin * 60_000).toISOString();

const baseEvent = {
  ts: iso(10),
  sessionId: "sess-a",
  toolId: "github__get_issue",
  verdict: "ALLOW",
  reasonCode: "ALLOW",
  mode: "observe",
  product: "claude",
  host: "ide",
  project: "dev",
};

const events = [
  baseEvent,
  {
    ...baseEvent,
    ts: iso(5),
    toolId: "github__create_issue",
    verdict: "REQUIRE_APPROVE",
    reasonCode: "HIGH_STAKES_WRITE",
    mode: "hold",
  },
  {
    ...baseEvent,
    ts: iso(2),
    toolId: "github__drop_table",
    verdict: "DENY",
    reasonCode: "NEVER_EVENT",
    neverEvent: true,
  },
  {
    ...baseEvent,
    ts: iso(20),
    sessionId: "sess-b",
    toolId: "filesystem__read_file",
    verdict: "ALLOW",
    reasonCode: "LOW_RISK_READ",
    product: "cursor",
    host: "runtime",
    targetPath: "src/main.ts",
    diffPreview: "+ const x = 1;\n- const x = 0;",
  },
  // Generated history: three sessions across two products, mostly allow with
  // a realistic mix of holds and reviews so analytics tiles have shape.
  ...Array.from({ length: 20 }, (_, i) => {
    const sessions = ["sess-a", "sess-b", "sess-c"];
    const tools = [
      ["github__get_issue", "ALLOW", "ALLOW"],
      ["github__list_prs", "ALLOW", "ALLOW"],
      ["github__create_pr", "REQUIRE_APPROVE", "HIGH_STAKES_WRITE"],
      ["filesystem__write_file", "REQUIRE_APPROVE", "HIGH_STAKES_WRITE"],
      ["filesystem__read_file", "ALLOW", "LOW_RISK_READ"],
      ["github__search_code", "ALLOW", "ALLOW"],
    ];
    const [toolId, verdict, reasonCode] = tools[i % tools.length];
    const sessionIdx = Math.floor(i / 8) % sessions.length;
    return {
      ...baseEvent,
      ts: iso(40 + i * 13),
      sessionId: sessions[sessionIdx],
      toolId,
      verdict,
      reasonCode,
      mode: i % 7 === 3 ? "hold" : "observe",
      product: sessionIdx === 2 ? "cursor" : "claude",
      host: sessionIdx === 2 ? "runtime" : "ide",
      targetPath: toolId.startsWith("filesystem__write") ? "src/config.ts" : undefined,
      diffPreview:
        toolId === "filesystem__write_file" ? "+ export const feature = true;" : undefined,
    };
  }),
];

const certifyCard = {
  result: "gap",
  pass: 11,
  gap: 2,
  insufficientEvidence: 4,
  attested: 0,
  windowDays: 30,
  trailEvents: events.length,
  topGaps: [
    {
      id: "SAFE-04",
      domain: "safety",
      severity: "critical",
      title: "Destructive operations require human approval",
      evidence: "drop_table denied in hold mode",
    },
    {
      id: "SEC-01",
      domain: "security",
      severity: "high",
      title: "Gate enforces, not observe-only",
      evidence: "github__drop_table denied",
    },
  ],
  requirements: [
    { id: "SAFE-01", domain: "safety", title: "Never-event deny verified", severity: "critical", status: "pass", evidence: "github__drop_table denied as NEVER_EVENT" },
    { id: "SAFE-04", domain: "safety", title: "Destructive operations require human approval", severity: "critical", status: "gap", evidence: "drop_table denied in hold mode — no approval flow recorded" },
    { id: "SAFE-02", domain: "safety", title: "Irreversible actions gated", severity: "high", status: "pass", evidence: "github__create_issue held for review" },
    { id: "SAFE-03", domain: "safety", title: "Prompt-injection smoke test", severity: "medium", status: "pass", evidence: "injection probe flagged and contained" },
    { id: "SEC-01", domain: "security", title: "Gate enforces, not observe-only", severity: "high", status: "gap", evidence: "github__drop_table denied — enforcement proven in hold mode" },
    { id: "SEC-02", domain: "security", title: "Secrets never in logs", severity: "high", status: "pass", evidence: "0 secret-shaped strings in 30d trail" },
    { id: "SEC-03", domain: "security", title: "Tool call authentication", severity: "high", status: "pass", evidence: "all calls carried agent identity" },
    { id: "ACC-01", domain: "accountability", title: "Runtime attestation", severity: "high", status: "insufficient_evidence", evidence: "no attestation bundle in window" },
    { id: "ACC-02", domain: "accountability", title: "Agent identity declared", severity: "medium", status: "pass", evidence: "demo-bot/agt-1 declared on every call" },
    { id: "ACC-03", domain: "accountability", title: "Sandbox boundary enforced", severity: "medium", status: "pass", evidence: "firecracker sbx-001 isolated" },
    { id: "ACC-05", domain: "accountability", title: "Action-bound authorization", severity: "high", status: "insufficient_evidence", evidence: "no scoped grant artifacts found" },
    { id: "DP-01", domain: "data", title: "Telemetry export disabled in prod", severity: "high", status: "pass", evidence: "OTLP receiver loopback-only" },
    { id: "DP-02", domain: "data", title: "PII redaction on outputs", severity: "medium", status: "pass", evidence: "redaction verified on sample" },
    { id: "DP-04", domain: "data", title: "Data residency documented", severity: "high", status: "insufficient_evidence", evidence: "residency statement missing" },
    { id: "OPS-01", domain: "operations", title: "Rollback demonstrated", severity: "medium", status: "pass", evidence: "revert path exercised" },
    { id: "OPS-02", domain: "operations", title: "Human handoff on ambiguity", severity: "low", status: "pass", evidence: "HIGH_STAKES_WRITE held for approval" },
    { id: "OPS-04", domain: "operations", title: "Incident drill evidence", severity: "medium", status: "insufficient_evidence", evidence: "no drill recorded in window" },
  ],
};

const gatePage = {
  state: "running",
  servers: [
    {
      id: "github",
      transport: "stdio",
      cmd: ["npx", "-y", "@modelcontextprotocol/server-github"],
      events: 3,
      worst: "never",
      serverFacet: "GitHub",
      importedFrom: ["cursor", "claude"],
      policy: { defaultTier: "WRITE", denyPatterns: ["(?:^|_)(?:drop|truncate|purge|transfer)(?:_|$)"] },
      deniedTools: ["drop_table"],
    },
    {
      id: "filesystem",
      transport: "stdio",
      cmd: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      events: 1,
      worst: "allow",
      serverFacet: "Filesystem",
      importedFrom: ["manual"],
      policy: { defaultTier: "WRITE", denyPatterns: ["(?:^|_)(?:drop|truncate|purge|transfer)(?:_|$)"] },
      deniedTools: [],
    },
  ],
  events: 4,
  gateEvents: events.filter((e) => e.toolId.startsWith("github__") || e.toolId.startsWith("filesystem__")),
  url: "http://127.0.0.1:3930",
  port: 3930,
  otlpPort: 3931,
  startedAt: iso(120),
  binaryPresent: true,
  binaryVersion: "1.5.0",
  binaryPath: "/Users/demo/.kya/bin/kya-gate",
  failureMode: "failOpen",
  bindScope: { loopbackOnly: true, detail: "loopback-only (L4 allowlist 127.0.0.0/8 + ::1)" },
  listeners: [
    { name: "MCP listener", protocol: "MCP over HTTP", address: "http://127.0.0.1:3930", state: "running", uptime: iso(120), detail: "local proxy for host MCP clients" },
    { name: "OTLP receiver", protocol: "OTLP/HTTP", address: "port 3931", state: "running", detail: "telemetry ingestion" },
  ],
  routes: [
    { pattern: "github__*", backend: "github", backendLabel: "GitHub", tier: "WRITE", denyCount: 1, events: 3, worst: "never", deniedTools: ["drop_table"] },
    { pattern: "filesystem__*", backend: "filesystem", backendLabel: "Filesystem", tier: "WRITE", denyCount: 1, events: 1, worst: "allow", deniedTools: [] },
  ],
  policySummary: {
    networkRule: 'cidr("127.0.0.0/8").containsIP(source.address) || source.address == "::1"',
    failureMode: "failOpen",
    totalPolicies: 3,
    verdicts: { allow: 3, deny: 0, hold: 0, never: 1 },
  },
  playgroundSamples: ["drop_table", "create_issue", "get_issue", "read_file"],
};

const identity = { agentId: "agt-1", agentName: "demo-bot", host: "ide", baseUrl: "http://127.0.0.1:8090" };

const wiredHosts = [
  { id: "cursor", label: "Cursor", wired: "global", reload: { id: "cursor", reload: "auto", detail: "watches mcp.json", processNames: ["cursor"] }, running: true },
  { id: "claude", label: "Claude Code", wired: "global", reload: { id: "claude", reload: "session", detail: "restart required", processNames: ["claude"] }, running: false },
];

const sandboxes = {
  backend: "firecracker",
  sandboxes: [{ sandboxId: "sbx-001", backend: "firecracker", createdAt: iso(2000), status: "running" }],
};

const orr = {
  overall: "amber",
  disposition: "conditional",
  primaryFailureMode: "secret handling",
  mostUrgentFix: "rotate leaked keys",
  generatedAt: iso(60),
  targetName: "demo-target",
  scorecards: { pass: 2, fail: 1, partial: 1, notEvaluated: 0 },
};

const showback = {
  billingMeter: false,
  disclaimer: "Estimate from published list prices. Not a billing meter. Not a PEP.",
  totalTokensIn: 182_400,
  totalTokensOut: 24_300,
  estimatedUsd: 0.61,
  perRun: [
    { runId: "run-a", parentAgentId: "agt-1", tokensIn: 120_000, tokensOut: 15_000, estimatedUsd: 0.39, steps: 12, subagentIds: [] },
    { runId: "run-b", parentAgentId: "agt-1", tokensIn: 62_400, tokensOut: 9_300, estimatedUsd: 0.22, steps: 7, subagentIds: [] },
  ],
  perAgent: [
    { agentId: "agt-1", tokensIn: 182_400, tokensOut: 24_300, estimatedUsd: 0.61, runs: 2 },
  ],
};

function modelWith(extras) {
  return buildWindowReceiptModel(events, 3, { identity, sandboxes, wiredHosts, orr, certify: certifyCard, ...extras });
}

const emptyGatePage = {
  state: "not-set-up",
  servers: [],
  events: 0,
  binaryPresent: false,
  failureMode: "failOpen",
  otlpPort: 3931,
  bindScope: { loopbackOnly: false, detail: "not configured" },
  binaryPath: "/Users/demo/.kya/bin/kya-gate",
  gateEvents: [],
  listeners: [],
  routes: [],
  policySummary: { networkRule: "", failureMode: "failOpen", totalPolicies: 0, verdicts: { allow: 0, deny: 0, hold: 0, never: 0 } },
  playgroundSamples: [],
};

const fixtures = [
  { name: "empty", model: buildWindowReceiptModel([], 3), zone: "overview", height: 900 },
  { name: "overview", model: modelWith({ gate: gatePage, showback }), zone: "overview", height: 1500 },
  { name: "activity", model: modelWith({}), zone: "activity", height: 1700 },
  { name: "changes", model: modelWith({}), zone: "changes", height: 750 },
  { name: "certify", model: modelWith({}), zone: "certify", height: 1400 },
  { name: "gateway-home", model: modelWith({ gate: gatePage }), zone: "gateway-home", height: 900 },
  { name: "gateway-listeners", model: modelWith({ gate: gatePage }), zone: "gateway-listeners", height: 900 },
  { name: "gateway-routes", model: modelWith({ gate: gatePage }), zone: "gateway-routes", height: 900 },
  { name: "gateway-backends", model: modelWith({ gate: gatePage }), zone: "gateway-backends", height: 900 },
  { name: "gateway-policies", model: modelWith({ gate: gatePage }), zone: "gateway-policies", height: 900 },
  { name: "gateway-playground", model: modelWith({ gate: gatePage }), zone: "gateway-playground", height: 900 },
  { name: "gateway-empty", model: buildWindowReceiptModel([], 3, { gate: emptyGatePage }), zone: "gateway-home", height: 900 },
  { name: "system", model: modelWith({}), zone: "system", height: 900 },
];

mkdirSync(outDir, { recursive: true });

const hiddenZones = [
  "#overview", "#activity", "#changes", "#certify",
  "#gateway-home", "#gateway-listeners", "#gateway-routes", "#gateway-backends", "#gateway-policies", "#gateway-playground",
  "#system",
].join(", ");

const zoneStyle = (zone) => `
<style>
  ${hiddenZones} { display: none !important; }
  #${zone} { display: block !important; }
</style>`;

const screenshots = [];
for (const { name, model, zone, height } of fixtures) {
  const html = renderReceiptHtml(model);
  for (const theme of ["dark", "light"]) {
    let themed = html.replace("<html lang=\"en\">", `<html lang="en" data-theme="${theme}">`);
    themed = themed.replace("</head>", `${zoneStyle(zone)}\n</head>`);
    const file = join(outDir, `${name}-${theme}.html`);
    writeFileSync(file, themed);
    const url = `file://${file}`;
    const shot = join(outDir, `${name}-${theme}.png`);
    screenshots.push({ url, shot, name: `${name}-${theme}`, height });
  }
}

async function screenshot({ url, shot, name, height }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=1440,${height ?? 900}`,
      `--screenshot=${shot}`,
      url,
    ], { stdio: "ignore" });
    proc.on("exit", (code) => {
      if (code === 0) {
        console.log(`✓ ${name}`);
        resolve();
      } else {
        reject(new Error(`Chrome exited ${code} for ${name}`));
      }
    });
  });
}

for (const s of screenshots) {
  await screenshot(s);
}

console.log(`\nScreenshots written to ${outDir}`);
