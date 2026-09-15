/**
 * Regression tests for the adversarial-review security fixes:
 * daemon state trust (F1/F2), file guards (F3), trail validation (F4),
 * live-token anchor spoof (F5), markdown escaping (F6), secret patterns (F7).
 * Daemon tests spawn dist/cli.js — run `pnpm build` first.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir, resolveConfig, type ResolvedConfig } from "../src/config.js";
import {
  clearDaemonState,
  daemonLogPath,
  daemonStatePath,
  ensureReceiptDaemon,
  pidAlive,
  readDaemonState,
  writeDaemonState,
  type ReceiptDaemonState,
} from "../src/receipt/daemon.js";
import { runStop } from "../src/commands/stop.js";
import { loadIdentity, loadSandboxes, loadWiredHosts } from "../src/receipt/enrich.js";
import { startLiveReceiptServer } from "../src/receipt/live-server.js";
import {
  buildWindowReceiptModel,
  loadReceiptModel,
  renderReceiptHtml,
  renderReceiptMarkdown,
} from "../src/receipt/render-receipt.js";
import { appendTrail, readTrail, trailPath, type TrailEvent } from "../src/trail.js";

let dir: string;
let home: string;
let config: ResolvedConfig;
const children: ChildProcess[] = [];
const daemonPids: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kya-sec-"));
  home = mkdtempSync(join(tmpdir(), "kya-sec-home-"));
  config = resolveConfig({
    cwd: dir,
    offline: true,
    allowMissingApiKey: true,
    env: { KYA_OFFLINE: "1" },
    flags: { offline: true },
  });
});

afterEach(async () => {
  for (const pid of daemonPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 150));
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function daemonState(over: Partial<ReceiptDaemonState> = {}): ReceiptDaemonState {
  return {
    pid: 1,
    url: "http://127.0.0.1:1/?t=x",
    token: "x",
    port: 1,
    startedAt: new Date().toISOString(),
    ...over,
  };
}

async function ensureAndTrack(): Promise<{ url: string; pid: number; reused: boolean }> {
  const handle = await ensureReceiptDaemon(config, { days: 3 });
  daemonPids.push(handle.pid);
  return handle;
}

describe("F1 — planted receipt-server.json is not trusted", () => {
  it("refuses to reuse a non-loopback url and spawns a fresh daemon", async () => {
    writeDaemonState(dir, daemonState({ url: "https://evil.example/x", port: 443 }));
    const handle = await ensureAndTrack();
    expect(handle.reused).toBe(false);
    expect(handle.pid).not.toBe(1);
    expect(handle.url).toContain("http://127.0.0.1:");
  }, 20_000);

  it("refuses to reuse a loopback url that fails the token handshake", async () => {
    // pid 1 is alive (EPERM) but nothing listens on port 1.
    writeDaemonState(dir, daemonState());
    const handle = await ensureAndTrack();
    expect(handle.reused).toBe(false);
    expect(handle.pid).not.toBe(1);
  }, 20_000);

  it("reuses a genuinely running daemon (loopback + handshake pass)", async () => {
    const first = await ensureAndTrack();
    expect(first.reused).toBe(false);
    const second = await ensureReceiptDaemon(config, { days: 3 });
    expect(second.reused).toBe(true);
    expect(second.pid).toBe(first.pid);
    expect(second.url).toBe(first.url);
  }, 20_000);

  it("kills a wedged owned daemon on handshake failure before respawning", async () => {
    const first = await ensureAndTrack();
    // Plant a stale token: the handshake now 401s against the running daemon.
    writeDaemonState(dir, {
      pid: first.pid,
      url: first.url,
      token: "stale-token-value",
      port: Number(new URL(first.url).port),
      startedAt: new Date().toISOString(),
    });
    const second = await ensureAndTrack();
    expect(second.reused).toBe(false);
    expect(second.pid).not.toBe(first.pid);
    // The wedged daemon was SIGTERM'd — no orphan leak.
    for (let waited = 0; waited < 3_000 && pidAlive(first.pid); waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pidAlive(first.pid)).toBe(false);
    expect(pidAlive(second.pid)).toBe(true);
    expect(readDaemonState(dir)?.pid).toBe(second.pid);
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "leaves a foreign pid untouched when its handshake fails",
    async () => {
      const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
      children.push(sleeper);
      expect(sleeper.pid).toBeTypeOf("number");
      // Dead loopback port → handshake fails; pid is not ours → never signaled.
      writeDaemonState(dir, daemonState({ pid: sleeper.pid as number }));
      const handle = await ensureAndTrack();
      expect(handle.reused).toBe(false);
      expect(pidAlive(sleeper.pid as number)).toBe(true);
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "stop refuses to SIGTERM a foreign pid from a planted state file",
    async () => {
      const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
      children.push(sleeper);
      expect(sleeper.pid).toBeTypeOf("number");
      writeDaemonState(dir, daemonState({ pid: sleeper.pid as number }));
      const res = await runStop(dir);
      expect(res.stopped).toBe(false);
      expect(res.stale).toBe(true);
      expect(pidAlive(sleeper.pid as number)).toBe(true);
      expect(existsSync(daemonStatePath(dir))).toBe(false);
    },
  );
});

describe("F2 — daemon state file permissions and symlink clobber", () => {
  it.skipIf(process.platform === "win32")(
    "forces mode 0600 on a pre-existing 0644 state file",
    () => {
      mkdirSync(configDir(dir), { recursive: true });
      const path = daemonStatePath(dir);
      writeFileSync(path, "{}\n", "utf8");
      chmodSync(path, 0o644);
      writeDaemonState(dir, daemonState());
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(1);
    },
  );

  it("never writes through a symlinked state file", () => {
    mkdirSync(configDir(dir), { recursive: true });
    const target = join(home, "innocent.json");
    writeFileSync(target, "ORIGINAL\n", "utf8");
    symlinkSync(target, daemonStatePath(dir));
    writeDaemonState(dir, daemonState());
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL\n");
    expect(lstatSync(daemonStatePath(dir)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(daemonStatePath(dir), "utf8")).pid).toBe(1);
  });

  it("never appends through a symlinked daemon log", async () => {
    mkdirSync(configDir(dir), { recursive: true });
    const target = join(home, "innocent.log");
    writeFileSync(target, "untouched\n", "utf8");
    symlinkSync(target, daemonLogPath(dir));
    const handle = await ensureAndTrack();
    expect(handle.reused).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("untouched\n");
    expect(lstatSync(daemonLogPath(dir)).isSymbolicLink()).toBe(false);
  }, 20_000);

  it("clearDaemonState with expectedPid spares a successor's state file", () => {
    writeDaemonState(dir, daemonState({ pid: 2222 }));
    // A dying daemon (pid 1111) must not delete its successor's (2222) state.
    clearDaemonState(dir, 1111);
    expect(existsSync(daemonStatePath(dir))).toBe(true);
    // Owner pid matches → removed. Plain call → removed.
    clearDaemonState(dir, 2222);
    expect(existsSync(daemonStatePath(dir))).toBe(false);
    writeDaemonState(dir, daemonState({ pid: 3333 }));
    clearDaemonState(dir);
    expect(existsSync(daemonStatePath(dir))).toBe(false);
    // Corrupt state + expectedPid → still removed (we own the normal case).
    writeFileSync(daemonStatePath(dir), "{corrupt", "utf8");
    clearDaemonState(dir, 4444);
    expect(existsSync(daemonStatePath(dir))).toBe(false);
  });
});

describe("F3 — non-regular files and cwd-relative jails", () => {
  const block = JSON.stringify({ mcpServers: { "shield-kya": { command: "kya" } } });

  it.skipIf(process.platform === "win32")(
    "treats a FIFO host config as not wired without hanging",
    async () => {
      mkdirSync(join(dir, ".cursor"), { recursive: true });
      execFileSync("mkfifo", [join(dir, ".cursor", "mcp.json")]);
      const rows = await Promise.race([
        Promise.resolve().then(() => loadWiredHosts(dir, home, new Set())),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("loadWiredHosts hung on FIFO")), 3000),
        ),
      ]);
      expect(rows.find((r) => r.id === "cursor")?.wired).toBe("none");
    },
  );

  it.skipIf(process.platform === "win32")(
    "treats a symlink to /dev/zero as not wired (no infinite read)",
    () => {
      mkdirSync(join(dir, ".cursor"), { recursive: true });
      symlinkSync("/dev/zero", join(dir, ".cursor", "mcp.json"));
      const cursor = loadWiredHosts(dir, home, new Set()).find((r) => r.id === "cursor");
      expect(cursor?.wired).toBe("none");
    },
  );

  it("refuses a symlinked .kya/sandboxes.json", () => {
    const outside = join(home, "sandboxes-outside.json");
    writeFileSync(
      outside,
      JSON.stringify([
        { sandboxId: "sbx-evil", backend: "mock", createdAt: "t", status: "running" },
      ]),
      "utf8",
    );
    mkdirSync(configDir(dir), { recursive: true });
    symlinkSync(outside, join(configDir(dir), "sandboxes.json"));
    expect(loadSandboxes(dir, {}).sandboxes).toEqual([]);
  });

  it("refuses a symlinked .kya/config.json", () => {
    const outside = join(home, "config-outside.json");
    writeFileSync(outside, JSON.stringify({ agentName: "evil-bot", host: "ide" }), "utf8");
    mkdirSync(configDir(dir), { recursive: true });
    symlinkSync(outside, join(configDir(dir), "config.json"));
    expect(loadIdentity(dir)).toBeUndefined();
  });

  it("still honors a legitimately symlinked HOME-dir host config", () => {
    const real = join(home, "real-mcp.json");
    writeFileSync(real, block, "utf8");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    symlinkSync(real, join(home, ".cursor", "mcp.json"));
    const cursor = loadWiredHosts(dir, home, new Set()).find((r) => r.id === "cursor");
    expect(cursor?.wired).toBe("global");
  });
});

describe("F4 — malformed trail lines are dropped, not fatal", () => {
  it("readTrail keeps only schema-valid lines and rendering survives", () => {
    const good = {
      ts: new Date().toISOString(),
      sessionId: "s-good",
      toolId: "org.sample.safe.read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
    };
    const lines = [
      JSON.stringify(good),
      JSON.stringify({ ...good, toolId: {} }),
      JSON.stringify({ ts: good.ts, sessionId: "s", toolId: "t", reasonCode: "A", mode: "observe" }),
      JSON.stringify({ ...good, mode: "yolo" }),
      JSON.stringify({ ...good, sessionId: "s-bad", product: "not-a-product" }),
      "{not json",
    ];
    mkdirSync(configDir(dir), { recursive: true });
    writeFileSync(trailPath(dir), `${lines.join("\n")}\n`, "utf8");

    const events = readTrail(dir);
    expect(events).toHaveLength(2);
    expect(events[0]?.sessionId).toBe("s-good");
    // Unknown product string is dropped rather than passed through.
    expect(events[1]?.sessionId).toBe("s-bad");
    expect(events[1]?.product).toBeUndefined();

    const model = loadReceiptModel({ cwd: dir, days: 3 });
    const html = renderReceiptHtml(model);
    expect(html).toContain("org.sample.safe.read");
  });

  it("caps an oversized trail.jsonl to the newest events without throwing", () => {
    const mk = (sessionId: string) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        sessionId,
        toolId: "org.sample.safe.read",
        verdict: "ALLOW",
        reasonCode: "ALLOW",
        mode: "observe",
      });
    const pad = `${JSON.stringify({
      ts: new Date().toISOString(),
      sessionId: "pad",
      toolId: "org.sample.safe.read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
      summary: "x".repeat(200),
    })}\n`;
    let body = `${mk("old-marker")}\n`;
    while (body.length < 1_500_000) body += pad;
    body += `${mk("recent-marker")}\n`;
    mkdirSync(configDir(dir), { recursive: true });
    writeFileSync(trailPath(dir), body, "utf8");

    const events = readTrail(dir);
    expect(events.some((e) => e.sessionId === "recent-marker")).toBe(true);
    expect(events.some((e) => e.sessionId === "old-marker")).toBe(false);
  });
});

describe("F5 — EventSource replace-anchor is not spoofable", () => {
  it("embeds the token exactly once even when trail text contains the anchor", async () => {
    const anchor = "EventSource('/events')";
    appendTrail(dir, {
      ts: new Date().toISOString(),
      sessionId: "live",
      product: "cursor",
      toolId: "org.sample.safe.read",
      verdict: "ALLOW",
      reasonCode: "ALLOW",
      mode: "observe",
      summary: `anchor ${anchor} here`,
    });
    const live = await startLiveReceiptServer({ config, days: 3 });
    try {
      const page = await fetch(live.url);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html.split(live.token).length - 1).toBe(1);
      expect(html).toContain(`EventSource('/events?t=${live.token}')`);
      // Attacker text survives as inert, un-replaced page text.
      expect(html).toContain(`anchor ${anchor} here`);
    } finally {
      await live.close();
    }
  }, 15_000);

  it("serves a token-gated /healthz that never renders", async () => {
    const live = await startLiveReceiptServer({ config, days: 3 });
    try {
      const denied = await fetch(`http://127.0.0.1:${live.port}/healthz`);
      expect(denied.status).toBe(401);
      const ok = await fetch(`http://127.0.0.1:${live.port}/healthz?t=${live.token}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).not.toContain("<html");
    } finally {
      await live.close();
    }
  }, 15_000);
});

describe("F6 — markdown renderer escapes untrusted text", () => {
  const ESC = "\u001b";
  const BIDI = "\u202e";
  const ZWSP = "\u200b";

  function hostileModel() {
    return buildWindowReceiptModel(
      [
        {
          ts: new Date().toISOString(),
          sessionId: `s${BIDI}ession${ZWSP}`,
          product: "cursor",
          toolId: "org.sample.safe.read",
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          mode: "observe",
          summary: `sum ${ESC}[31m\`code\`${ESC}[0m <script>alert(1)</script> ${BIDI}end`,
          diffPreview: "```\n</script><script>alert(2)</script>\n```",
        },
      ],
      3,
    );
  }

  it("strips control/bidi chars and defuses fence breakout and raw HTML in MD", () => {
    const md = renderReceiptMarkdown(hostileModel());
    expect(md).not.toContain(ESC);
    expect(md).not.toContain(BIDI);
    expect(md).not.toContain(ZWSP);
    // Inline text (summary) is escaped — no raw HTML outside code fences.
    expect(md).not.toContain("<script>alert(1)");
    // Fenced diff content is verbatim: no backslash garbling, fence holds.
    const lines = md.split("\n");
    const fenceIdx = lines.flatMap((l, i) => (l === "~~~~" ? [i] : []));
    expect(fenceIdx).toHaveLength(2);
    const [open, close] = fenceIdx as [number, number];
    const body = lines.slice(open + 1, close);
    expect(body).toContain("```");
    expect(body).toContain("</script><script>alert(2)</script>");
  });

  it("renders realistic diff lines verbatim inside the fence", () => {
    const line = "+  arr[i] = a < b ? x[0] : `y`;";
    const model = buildWindowReceiptModel(
      [
        {
          ts: new Date().toISOString(),
          sessionId: "s",
          toolId: "org.sample.safe.read",
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          mode: "observe",
          diffPreview: `- old line\n${line}\n+ done`,
        },
      ],
      3,
    );
    const md = renderReceiptMarkdown(model);
    const lines = md.split("\n");
    const fenceIdx = lines.flatMap((l, i) => (l === "~~~~" ? [i] : []));
    expect(fenceIdx).toHaveLength(2);
    const [open, close] = fenceIdx as [number, number];
    const body = lines.slice(open + 1, close);
    expect(body).toContain(line);
    expect(body).toContain("- old line");
    expect(body).toContain("+ done");
  });

  it("defuses backticks in inline code spans (toolId)", () => {
    const model = buildWindowReceiptModel(
      [
        {
          ts: new Date().toISOString(),
          sessionId: "s",
          toolId: "a`b`c",
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          mode: "observe",
        },
      ],
      3,
    );
    const md = renderReceiptMarkdown(model);
    const head = md.split("\n").find((l) => l.includes("a'b'c"));
    expect(head).toBeDefined();
    // Backticks stripped from the span value — the span stays balanced.
    expect(head?.split("`").length - 1).toBe(2);
    expect(head).toContain("`a'b'c`");
  });

  it("renders brackets and angles verbatim inside inline code spans", () => {
    const model = buildWindowReceiptModel(
      [
        {
          ts: new Date().toISOString(),
          sessionId: "s",
          toolId: "a[0]<x>",
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          mode: "observe",
        },
      ],
      3,
    );
    const md = renderReceiptMarkdown(model);
    // No backslash garbling inside the span.
    expect(md).toContain("`a[0]<x>`");
    expect(md).not.toContain("a\\[0\\]");
  });

  it("strips bidi/control chars in the HTML path too", () => {
    const html = renderReceiptHtml(hostileModel());
    expect(html).not.toContain(BIDI);
    expect(html).not.toContain(ZWSP);
    expect(html).not.toContain(ESC);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("sizes the MD fence beyond tilde runs in diffPreview (no ~~~~ breakout)", () => {
    const model = buildWindowReceiptModel(
      [
        {
          ts: new Date().toISOString(),
          sessionId: "s",
          toolId: "org.sample.safe.read",
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          mode: "observe",
          diffPreview: "before\n~~~~\nmiddle\n~~~~~\nafter",
        },
      ],
      3,
    );
    const md = renderReceiptMarkdown(model);
    const lines = md.split("\n");
    // Fence must be one longer than the longest payload run (5 → 6 tildes).
    const fenceIdx = lines.flatMap((l, i) => (l === "~~~~~~" ? [i] : []));
    expect(fenceIdx).toHaveLength(2);
    const [open, close] = fenceIdx as [number, number];
    // Payload tilde lines stay between the opening and closing fence.
    for (const payload of ["before", "~~~~", "middle", "~~~~~", "after"]) {
      const at = lines.indexOf(payload);
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
    }
  });
});

describe("F7 — assertNoSecrets coverage without false-positive DoS", () => {
  it("throws on URL userinfo credentials in identity baseUrl", () => {
    const url = ["http://admin", ":", "s3cr3t", "P4ss", "@internal.corp:8090"].join("");
    const model = buildWindowReceiptModel([], 3, {
      identity: { agentName: "bot", host: "ide", baseUrl: url },
    });
    expect(() => renderReceiptHtml(model)).toThrow(/secret/i);
    expect(() => renderReceiptMarkdown(model)).toThrow(/secret/i);
  });

  it("throws on sk-proj-style keys", () => {
    const key = "sk" + "-proj-" + "Ab3dEf5".repeat(7);
    const model = buildWindowReceiptModel(
      [
        {
          ts: new Date().toISOString(),
          sessionId: "s",
          toolId: "org.sample.safe.read",
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          mode: "observe",
          summary: `used ${key} here`,
        },
      ],
      3,
    );
    expect(() => renderReceiptHtml(model)).toThrow(/secret/i);
  });

  it("allows short benign keyword mentions", () => {
    const model = buildWindowReceiptModel(
      [
        {
          ts: new Date().toISOString(),
          sessionId: "s",
          toolId: "org.sample.safe.read",
          verdict: "ALLOW",
          reasonCode: "ALLOW",
          mode: "observe",
          summary: "refreshed token: ab12cd34 ok",
        },
      ],
      3,
    );
    expect(() => renderReceiptHtml(model)).not.toThrow();
    expect(() => renderReceiptMarkdown(model)).not.toThrow();
  });
});
