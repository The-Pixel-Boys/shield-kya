/**
 * OpenShell report panel: the pure trail rollup, the always-render contract
 * (panel shows self-service empty states on a fresh install), sandbox rows
 * with policy-file status against a temp .kya dir, runtime probes against
 * stub PATH binaries (same pattern as test/sandbox.test.ts), and the
 * live-server payload wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateOpenshellEvents,
  loadOpenshellCard,
  openshellCardResetForTests,
  type OpenshellCertifyLike,
} from "../src/receipt/openshell-card.js";
import {
  buildWindowReceiptModel,
  renderReceiptHtml,
} from "../src/receipt/render-receipt.js";
import { writeOpenshellPolicy } from "../src/sandbox/openshell-policy.js";
import { saveSandboxState } from "../src/sandbox/runtime.js";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import { appendTrail, type TrailEvent } from "../src/trail.js";

vi.mock("../src/commands/gate.js", () => ({
  runGateRun: vi.fn(),
  runGateStop: vi.fn(),
  runGateDoctor: vi.fn(),
}));

const dirs: string[] = [];
const savedEnv = { ...process.env };

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-openshell-panel-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  openshellCardResetForTests();
});

function writeBin(dir: string, name: string, script: string): void {
  const p = join(dir, name);
  writeFileSync(p, script, "utf8");
  chmodSync(p, 0o755);
}

/** Empty PATH dir: no openshell, no docker/podman, no prover. */
function emptyPathEnv(binDir: string): NodeJS.ProcessEnv {
  return { PATH: binDir };
}

const osEv = (over: Partial<TrailEvent> = {}): TrailEvent => ({
  ts: "2026-10-15T12:00:00.000Z",
  sessionId: "import-openshell-2026-10-15",
  host: "import",
  toolId: "openshell.network",
  verdict: "DENY",
  reasonCode: "OPENSHELL_POLICY",
  mode: "observe",
  importFormat: "openshell",
  importedFrom: "openshell",
  summary: "dst: api.example.com:443",
  ...over,
});

const EVENTS: TrailEvent[] = [
  osEv(),
  osEv({ verdict: "ALLOW", ts: "2026-10-15T13:00:00.000Z" }),
  osEv({ toolId: "openshell.http" }),
  osEv({ toolId: "openshell.http", summary: "dst: cdn.other.org:80" }),
  // Not openshell: regular local events never enter the rollup.
  osEv({ toolId: "Bash", reasonCode: "SHELL_EXEC" }),
];

describe("aggregateOpenshellEvents", () => {
  it("is undefined when the trail has no openshell events", () => {
    expect(aggregateOpenshellEvents([])).toBeUndefined();
    expect(
      aggregateOpenshellEvents([
        osEv({ toolId: "Bash", reasonCode: "SHELL_EXEC" }),
      ]),
    ).toBeUndefined();
  });

  it("counts deny/allow, splits by tool, ranks top destinations, tracks last event", () => {
    const a = aggregateOpenshellEvents(EVENTS);
    expect(a).toBeDefined();
    expect(a?.total).toBe(4);
    expect(a?.deny).toBe(3);
    expect(a?.allow).toBe(1);
    expect(a?.network).toBe(2);
    expect(a?.http).toBe(2);
    expect(a?.lastTs).toBe("2026-10-15T13:00:00.000Z");
    expect(a?.topDestinations).toEqual([
      { dst: "api.example.com:443", count: 3 },
      { dst: "cdn.other.org:80", count: 1 },
    ]);
  });

  it("parses destinations defensively from user-editable summaries", () => {
    const a = aggregateOpenshellEvents([
      osEv({ summary: "src: 10.0.0.1:53 dst: db.internal:5432" }),
      osEv({ summary: "no endpoint here" }),
      osEv({ summary: undefined }),
    ]);
    expect(a?.topDestinations).toEqual([{ dst: "db.internal:5432", count: 1 }]);
  });
});

describe("loadOpenshellCard + OpenShell panel", () => {
  it("always returns a card and renders the panel, even with no openshell signal", () => {
    const cwd = tmp();
    const card = loadOpenshellCard({ cwd, events: [], env: emptyPathEnv(tmp()) });
    expect(card).toBeDefined();
    expect(card?.activity).toBeUndefined();
    expect(card?.sandboxes).toEqual([]);
    expect(card?.runtime.cliFound).toBe(false);
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { openshell: card }));
    expect(html).toContain('aria-label="OpenShell"');
    // Self-service empty state names the activation command.
    expect(html).toContain("kya import --from openshell FILE");
    expect(html).toContain("KYA_SANDBOX=openshell kya sandbox spawn");
    expect(html).toContain('openshell CLI <span class="pill">not detected</span>');
  });

  it("renders activity counts, deny/allow pills, and destinations", () => {
    const cwd = tmp();
    const card = loadOpenshellCard({ cwd, events: EVENTS, env: emptyPathEnv(tmp()) });
    expect(card?.activity?.deny).toBe(3);
    const html = renderReceiptHtml(
      buildWindowReceiptModel(EVENTS, 3, { openshell: card }),
    );
    expect(html).toContain('aria-label="OpenShell"');
    expect(html).toContain("DENY 3");
    expect(html).toContain("ALLOW 1");
    expect(html).toContain("network 2 · http 2");
    expect(html).toContain("api.example.com:443");
    expect(html).toContain("cdn.other.org:80");
    // No CLI on the stub PATH: every probe degrades to a not-detected row.
    expect(html).toContain('openshell CLI <span class="pill">not detected</span>');
    expect(html).toContain('openshell-prover <span class="pill">not detected</span>');
    expect(html).toContain("container runtime");
    expect(html).toContain("&gt;=0.1.0");
  });

  it("renders openshell sandbox rows with per-row policy-file status", () => {
    const cwd = tmp();
    const withPolicy = "sbx-11111111-2222-3333-4444-555555555555";
    const withoutPolicy = "sbx-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    saveSandboxState(cwd, [
      {
        sandboxId: withPolicy,
        backend: "openshell",
        createdAt: "2026-10-15T10:00:00.000Z",
        status: "running",
        externalName: "kya-sbx-1111",
      },
      {
        sandboxId: withoutPolicy,
        backend: "openshell",
        createdAt: "2026-10-14T10:00:00.000Z",
        status: "killed",
      },
      {
        sandboxId: "sbx-ffffffff-1111-2222-3333-444444444444",
        backend: "mock",
        createdAt: "2026-10-15T10:00:00.000Z",
        status: "running",
      },
    ]);
    writeOpenshellPolicy(cwd, withPolicy);
    const card = loadOpenshellCard({ cwd, events: [], env: emptyPathEnv(tmp()) });
    expect(card).toBeDefined();
    expect(card?.sandboxes).toHaveLength(2);
    const row = card?.sandboxes.find((s) => s.sandboxId === withPolicy);
    expect(row?.policyFile).toBe(true);
    expect(row?.externalName).toBe("kya-sbx-1111");
    expect(row?.status).toBe("running");
    const killed = card?.sandboxes.find((s) => s.sandboxId === withoutPolicy);
    expect(killed?.policyFile).toBe(false);
    expect(killed?.externalName).toBeUndefined();

    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { openshell: card }));
    expect(html).toContain("written");
    expect(html).toContain("missing");
    expect(html).toContain("kya-sbx-1111");
    // The mock-backend row is not an openshell row.
    expect(html).not.toContain("sbx-ffffffff-1111-2222-3333-444444444444");
  });

  it("tolerates a corrupt sandboxes.json without throwing", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".kya"), { recursive: true });
    writeFileSync(join(cwd, ".kya", "sandboxes.json"), "not json {{{", "utf8");
    const events = [osEv()];
    const card = loadOpenshellCard({ cwd, events, env: emptyPathEnv(tmp()) });
    expect(card?.activity?.total).toBe(1);
    expect(card?.sandboxes).toEqual([]);
  });

  it("reports CLI found with version, container runtime, and prover found", () => {
    const cwd = tmp();
    const binDir = tmp();
    const logDir = tmp();
    writeBin(
      binDir,
      "openshell",
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG/argv.log"
if [ "$1" = "--version" ]; then
  printf 'openshell version 0.2.3\\n'
  exit 0
fi
exit 0
`,
    );
    writeBin(binDir, "docker", "#!/bin/sh\nexit 0\n");
    writeBin(binDir, "openshell-prover", "#!/bin/sh\nexit 0\n");
    const env: NodeJS.ProcessEnv = { PATH: binDir, FAKE_LOG: logDir };
    const card = loadOpenshellCard({ cwd, events: [], env });
    expect(card?.runtime.cliFound).toBe(true);
    expect(card?.runtime.cliVersion).toBe("0.2.3");
    expect(card?.runtime.containerRuntime).toBe("docker");
    expect(card?.runtime.proverFound).toBe(true);
    expect(card?.runtime.minVersion).toBe(">=0.1.0");
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { openshell: card }));
    expect(html).toContain('aria-label="OpenShell"');
    expect(html).toContain("<code>0.2.3</code>");
    expect(html).toContain('openshell-prover <span class="pill ok">found</span>');
    expect(html).toContain(
      "SAFE-06 (openshell-prover) <span class=\"mute\">not evaluated by Certify yet</span>",
    );
  });

  it("probes openshell --version once per binary across report builds", () => {
    const cwd = tmp();
    const binDir = tmp();
    const logDir = tmp();
    writeBin(
      binDir,
      "openshell",
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG/argv.log"
printf 'openshell version 0.2.3\\n'
`,
    );
    const env: NodeJS.ProcessEnv = { PATH: binDir, FAKE_LOG: logDir };
    loadOpenshellCard({ cwd, events: [], env });
    loadOpenshellCard({ cwd, events: [], env });
    const log = readFileSync(join(logDir, "argv.log"), "utf8");
    expect(log.match(/--version/g)).toHaveLength(1);
  });

  it("degrades to a version-probe-failed row when --version fails", () => {
    const cwd = tmp();
    const binDir = tmp();
    writeBin(binDir, "openshell", "#!/bin/sh\nexit 1\n");
    const card = loadOpenshellCard({ cwd, events: [], env: { PATH: binDir } });
    expect(card?.runtime.cliFound).toBe(true);
    expect(card?.runtime.cliVersion).toBeUndefined();
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { openshell: card }));
    expect(html).toContain("version probe failed");
  });

  it("ignores a malformed KYA_SANDBOX_OPENSHELL override instead of throwing", () => {
    const cwd = tmp();
    const binDir = tmp();
    const card = loadOpenshellCard({
      cwd,
      events: [osEv()],
      env: { PATH: binDir, KYA_SANDBOX_OPENSHELL: "relative/openshell" },
    });
    expect(card?.runtime.cliFound).toBe(false);
  });

  it("reuses the SAFE-06 outcome from the certify card without recomputing it", () => {
    const cwd = tmp();
    const binDir = tmp();
    writeBin(
      binDir,
      "openshell",
      '#!/bin/sh\nprintf "openshell version 0.2.3\\n"\n',
    );
    const certify: OpenshellCertifyLike = {
      requirements: [
        { id: "SEC-01", status: "pass", evidence: "ok" },
        {
          id: "SAFE-06",
          status: "insufficient_evidence",
          evidence: "openshell-prover not evaluated",
        },
      ],
    };
    const card = loadOpenshellCard({
      cwd,
      events: [],
      env: { PATH: binDir },
      certify,
    });
    expect(card?.runtime.safe06?.status).toBe("insufficient_evidence");
    const html = renderReceiptHtml(buildWindowReceiptModel([], 3, { openshell: card }));
    expect(html).toContain("SAFE-06 (openshell-prover)");
    expect(html).toContain("insufficient evidence");
    expect(html).toContain("openshell-prover not evaluated");
  });

  it("escapes attacker-controlled destinations", () => {
    const events = [osEv({ summary: "dst: <img src=x onerror=alert(1)>" })];
    const card = loadOpenshellCard({ cwd: tmp(), events, env: emptyPathEnv(tmp()) });
    const html = renderReceiptHtml(buildWindowReceiptModel(events, 3, { openshell: card }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("live receipt server OpenShell payload", () => {
  let dir: string;
  let config: ResolvedConfig;
  const servers: Awaited<ReturnType<typeof startLiveReceiptServer>>[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kya-live-openshell-"));
    dirs.push(dir);
    // Isolate from whatever is installed on the dev machine.
    process.env.PATH = join(dir, "empty-bin");
    mkdirSync(process.env.PATH, { recursive: true });
    config = resolveConfig({
      cwd: dir,
      offline: true,
      allowMissingApiKey: true,
      env: { KYA_OFFLINE: "1" },
      flags: { offline: true },
    });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      try {
        await s.close();
      } catch {
        /* ignore */
      }
    }
  });

  async function start(): Promise<Awaited<ReturnType<typeof startLiveReceiptServer>>> {
    const s = await startLiveReceiptServer({ config, days: 3 });
    servers.push(s);
    return s;
  }

  it("renders the panel on a fresh install (empty state) and with data once openshell events land", async () => {
    const fresh = await start();
    const freshHtml = await (
      await fetch(`http://127.0.0.1:${fresh.port}/?t=${fresh.token}`)
    ).text();
    expect(freshHtml).toContain('aria-label="OpenShell"');
    expect(freshHtml).toContain("kya import --from openshell FILE");
    await fresh.close();

    appendTrail(dir, osEv({ summary: "dst: live.example.com:443" }));
    const live = await start();
    const html = await (
      await fetch(`http://127.0.0.1:${live.port}/?t=${live.token}`)
    ).text();
    expect(html).toContain('aria-label="OpenShell"');
    expect(html).toContain("live.example.com:443");
    expect(html).toContain("DENY 1");
  });
});
