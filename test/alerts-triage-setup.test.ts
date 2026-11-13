/**
 * kya start: the offer of security alerts with local triage (src/alerts/triage-setup.ts).
 * Same case list as the plain-language search offer (semantic-setup.test.ts): yes, no, remembered no,
 * KYA_ALERTS=on / off, no terminal, install failure, plus the model download (sha256 pin, atomic write).
 * The real-CLI part spawns dist/cli.js with a temp KYA_HOME and a fake npm. Requires `npm run build` first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveAlertsConfig } from "../src/alerts/config.js";
import { downloadModelFrom, downloadTriageModel, maybeOfferTriageAlerts, modelUrlRefusal, type TriageSetupIo } from "../src/alerts/triage-setup.js";
import { TRIAGE_MODEL_ID, TRIAGE_MODEL_MAX_BYTES, TRIAGE_MODEL_URL, triageInstalled, triageModelInstallPath, triageRuntimeInstalled } from "../src/alerts/triage-status.js";
import { installFakeModel, installFakeOrt, packModel } from "./support/fake-triage-runtime.js";

function harness(over: Partial<TriageSetupIo> = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const calls = { runtime: 0, model: 0, test: 0 };
  const io: TriageSetupIo = {
    error: (m) => lines.push(m),
    isTty: true,
    ask: async (q) => {
      asked.push(q);
      return "";
    },
    installRuntime: async (env) => {
      calls.runtime++;
      installFakeOrt(env);
      return { ok: true };
    },
    downloadModel: async (env) => {
      calls.model++;
      installFakeModel(env);
      return { ok: true };
    },
    testAlert: async () => {
      calls.test++;
      return { desktop: true, webhooks: 0 };
    },
    ...over,
  };
  return { io, lines, asked, calls, out: () => lines.join("\n") };
}

describe("kya start: offer security alerts", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kya-triage-setup-"));
    env = { KYA_HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("yes (Enter is yes): says what it does, installs runtime and model, turns alerts on in the user config, sends one test alert", async () => {
    const h = harness();
    expect(await maybeOfferTriageAlerts(h.io, env)).toBe("installed");
    expect(h.asked).toEqual(["Turn on security alerts? [Y/n]"]);
    const text = h.out();
    for (const word of ["destructive change", "secret access", "data exfiltration", "repeated denies", "offline", "150 MB", "advisory", "Nothing leaves this machine"]) {
      expect(text).toContain(word);
    }
    expect(h.calls).toEqual({ runtime: 1, model: 1, test: 1 });
    expect(triageInstalled(env)).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, ".kya", "config.json"), "utf8")) as { alerts: { enabled: boolean } };
    expect(cfg.alerts.enabled).toBe(true);
    expect(resolveAlertsConfig(env)).toMatchObject({ enabled: true, source: "config" });
    expect(text).toContain("Sent a test alert: a desktop notification.");
  });

  it("no: installs nothing, turns nothing on, prints how to turn it on later, and is never asked again", async () => {
    const h = harness({ ask: async () => "n" });
    expect(await maybeOfferTriageAlerts(h.io, env)).toBe("declined");
    expect(h.calls).toEqual({ runtime: 0, model: 0, test: 0 });
    expect(triageRuntimeInstalled(env)).toBe(false);
    expect(existsSync(join(home, ".kya", "config.json"))).toBe(false);
    expect(h.out()).toContain("Turn it on later: KYA_ALERTS=on kya start");
    expect(JSON.parse(readFileSync(join(home, ".kya", "alerts-choice.json"), "utf8")).answer).toBe("no");
    const again = harness();
    expect(await maybeOfferTriageAlerts(again.io, env)).toBe("skipped"); // remembered no
    expect(again.asked).toEqual([]);
    expect(again.lines).toEqual([]);
  });

  it("without a terminal: asks nothing, installs nothing, one hint line", async () => {
    const h = harness({ isTty: false });
    expect(await maybeOfferTriageAlerts(h.io, env)).toBe("hinted");
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual({ runtime: 0, model: 0, test: 0 });
    expect(h.lines).toEqual(["Security alerts are off. Turn them on: KYA_ALERTS=on kya start"]);
    expect(existsSync(join(home, ".kya", "alerts-choice.json"))).toBe(false);
  });

  it("KYA_ALERTS=on installs without asking, even without a terminal", async () => {
    const h = harness({ isTty: false });
    expect(await maybeOfferTriageAlerts(h.io, { ...env, KYA_ALERTS: "on" })).toBe("installed");
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual({ runtime: 1, model: 1, test: 1 });
    expect(resolveAlertsConfig(env).enabled).toBe(true);
  });

  it("KYA_ALERTS=off (and 0, false) never asks and installs nothing", async () => {
    for (const v of ["off", "0", "false", "OFF"]) {
      const h = harness();
      expect(await maybeOfferTriageAlerts(h.io, { ...env, KYA_ALERTS: v })).toBe("skipped");
      expect(h.asked).toEqual([]);
      expect(h.calls).toEqual({ runtime: 0, model: 0, test: 0 });
    }
  });

  it("an installed runtime and model are left alone", async () => {
    installFakeOrt(env);
    installFakeModel(env);
    const h = harness();
    expect(await maybeOfferTriageAlerts(h.io, env)).toBe("already");
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual({ runtime: 0, model: 0, test: 0 });
  });

  it("an explicit `kya alerts on` or `kya alerts off` in the user config is a decision: not asked", async () => {
    for (const enabled of [true, false]) {
      mkdirSync(join(home, ".kya"), { recursive: true });
      writeFileSync(join(home, ".kya", "config.json"), JSON.stringify({ alerts: { enabled } }));
      const h = harness();
      expect(await maybeOfferTriageAlerts(h.io, env)).toBe("skipped");
      expect(h.asked).toEqual([]);
    }
  });

  it("runtime install failure: says so, prints the manual command, alerts still on with the detector severity, a yes is not turned into a no", async () => {
    const h = harness({ installRuntime: async () => ({ ok: false, detail: "network down" }) });
    expect(await maybeOfferTriageAlerts(h.io, env)).toBe("partial");
    const out = h.out();
    expect(out).toContain("network down");
    expect(out).toContain("detector severity only");
    expect(out).toContain("KYA_ALERTS=on kya start");
    expect(h.calls.model).toBe(0); // no model without the runtime
    expect(resolveAlertsConfig(env).enabled).toBe(true);
    expect(existsSync(join(home, ".kya", "alerts-choice.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".kya", "alerts-choice.json"), "utf8")).answer).toBe("yes");
  });

  it("model download failure: runtime stays, alerts on without the model, manual command printed", async () => {
    const h = harness({ downloadModel: async () => ({ ok: false, detail: "sha256 does not match the pinned value: file refused" }) });
    expect(await maybeOfferTriageAlerts(h.io, env)).toBe("partial");
    expect(h.out()).toContain("sha256 does not match");
    expect(h.out()).toContain("detector severity only");
    expect(triageRuntimeInstalled(env)).toBe(true);
    expect(triageInstalled(env)).toBe(false);
  });

  it("KYA_ALERTS=on on every start with the model still missing: the test alert is sent once, not on every start", async () => {
    const on = { ...env, KYA_ALERTS: "on" };
    const failing = { downloadModel: async () => ({ ok: false, detail: "HTTP 404" }) };
    const first = harness(failing);
    expect(await maybeOfferTriageAlerts(first.io, on)).toBe("partial");
    expect(first.calls.test).toBe(1); // alerts were just turned on
    const second = harness(failing);
    expect(await maybeOfferTriageAlerts(second.io, on)).toBe("partial");
    expect(second.calls.test).toBe(0); // nothing changed: no second test alert
    const third = harness();
    expect(await maybeOfferTriageAlerts(third.io, on)).toBe("installed");
    expect(third.calls.test).toBe(1); // the model arrived: tell the user
  });

  it("the npm install for the runtime skips scripts (the Linux CUDA download) and pins the version", async () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "alerts", "triage-setup.ts"), "utf8");
    expect(src).toContain('"--ignore-scripts"');
    expect(src).toContain('ONNXRUNTIME_NODE_INSTALL: "skip"');
  });

  it("a throwing test alert does not change the result", async () => {
    const h = harness({
      testAlert: async () => {
        throw new Error("no display");
      },
    });
    expect(await maybeOfferTriageAlerts(h.io, env)).toBe("installed");
  });
});

describe("local triage model download: sha256 pin and atomic write", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  const bytes = Buffer.alloc(1_200_000, 3);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const URL_OK = TRIAGE_MODEL_URL;
  const respond = (body: Buffer | string, status = 200, headers: Record<string, string> = {}) =>
    (async () =>
      new Response(body as BodyInit, { status, headers: { "content-length": String(Buffer.byteLength(body)), ...headers } })) as unknown as typeof fetch;
  /** A stream of `chunks` chunks of `size` bytes; `length` is the Content-Length it declares (undefined: none). */
  const streamed = (chunks: number, size: number, length?: number) =>
    (async () => {
      let n = 0;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (n++ < chunks) c.enqueue(new Uint8Array(size));
            else c.close();
          },
        }),
        { headers: length === undefined ? {} : { "content-length": String(length) } },
      );
    }) as unknown as typeof fetch;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kya-triage-dl-"));
    env = { KYA_HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const leftovers = (): string[] => {
    const dir = join(home, ".kya", "triage", "model");
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it("a file with the pinned hash is written into place and no temp file stays", async () => {
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: respond(bytes), sha256: sha });
    expect(r).toEqual({ ok: true });
    expect(readFileSync(triageModelInstallPath(env)).equals(bytes)).toBe(true);
    expect(leftovers()).toEqual([`${TRIAGE_MODEL_ID}.bin`]);
  });

  it("a different hash is refused: nothing is written, no temp file stays", async () => {
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: respond(Buffer.alloc(1_200_000, 9)), sha256: sha });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("sha256 does not match");
    expect(existsSync(triageModelInstallPath(env))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("a refused download leaves a model that is already there untouched", async () => {
    installFakeModel(env);
    const before = readFileSync(triageModelInstallPath(env));
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: respond(Buffer.alloc(1_200_000, 9)), sha256: sha });
    expect(r.ok).toBe(false);
    expect(readFileSync(triageModelInstallPath(env)).equals(before)).toBe(true);
  });

  it("the pinned default hash refuses an unknown file (no test override)", async () => {
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: respond(bytes) });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("sha256 does not match");
  });

  it("an HTTP error and a tiny file are refused", async () => {
    expect((await downloadModelFrom(env, { url: URL_OK, fetch: respond("nope", 404), sha256: sha })).ok).toBe(false);
    const tiny = Buffer.from("tiny");
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: respond(tiny), sha256: createHash("sha256").update(tiny).digest("hex") });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("too small");
    expect(leftovers()).toEqual([]);
  });

  it("a connection that breaks in the middle is reported, and no temp file stays", async () => {
    const broken = (async () => {
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (!sent) {
              sent = true;
              c.enqueue(new Uint8Array(500_000));
            } else c.error(new Error("connection reset"));
          },
        }),
        { headers: { "content-length": "1200000" } },
      );
    }) as unknown as typeof fetch;
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: broken, sha256: sha });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("connection reset");
    expect(leftovers()).toEqual([]);
  });

  it("a redirect is never followed: a 302 is a failure and the fetch asks for manual redirects", async () => {
    let seen: RequestInit | undefined;
    const redirect = (async (_u: string, init?: RequestInit) => {
      seen = init;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/m.bin" } });
    }) as unknown as typeof fetch;
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: redirect, sha256: sha });
    expect(seen?.redirect).toBe("manual");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("redirect");
    expect(leftovers()).toEqual([]);
  });

  it("a file that declares more than the cap is refused before any byte is written", async () => {
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: respond(bytes, 200, { "content-length": String(300 * 1024 * 1024) }), sha256: sha });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("larger than 200 MB");
    expect(leftovers()).toEqual([]);
  });

  it("a response without Content-Length is refused", async () => {
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: streamed(3, 500_000), sha256: sha });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no Content-Length");
    expect(leftovers()).toEqual([]);
  });

  it("a body that is longer than the cap (the header lies) is cut off, and no temp file stays", async () => {
    // cap 1.5 MB (seam): the header says 1.2 MB, the body sends 4 x 500 kB
    const r = await downloadModelFrom(env, { url: URL_OK, fetch: streamed(4, 500_000, 1_200_000), sha256: sha, maxBytes: 1_500_000 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("more than 200 MB");
    expect(leftovers()).toEqual([]);
  });

  it("the cap is 200 MB", () => {
    expect(TRIAGE_MODEL_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  it("another host, http, a port and credentials are refused before any request", async () => {
    let called = 0;
    const spy = (async () => {
      called++;
      return new Response(bytes as BodyInit);
    }) as unknown as typeof fetch;
    for (const url of [
      "https://evil.example/triage-model-v1/kya-triage-v1.bin",
      "https://models.shield-agent.com.evil.example/m.bin",
      "https://github.com/The-Pixel-Boys/shield-kya/releases/download/triage-model-v1/kya-triage-v1.bin",
      "http://models.shield-agent.com/triage-model-v1/kya-triage-v1.bin",
      "https://models.shield-agent.com:8443/m.bin",
      "https://user:pw@models.shield-agent.com/m.bin",
      "http://169.254.169.254/latest",
      "not a url",
    ]) {
      const r = await downloadModelFrom(env, { fetch: spy, sha256: sha, url });
      expect(r.ok, url).toBe(false);
    }
    expect(called).toBe(0);
    expect(modelUrlRefusal(TRIAGE_MODEL_URL)).toBeUndefined();
    expect(TRIAGE_MODEL_URL).toBe("https://models.shield-agent.com/triage-model-v1/kya-triage-v1.bin");
  });

  it("KYA_TRIAGE_MODEL_URL is ignored, whatever it holds: the pinned URL is requested, redirects manual", async () => {
    const asked: Array<{ url: string; redirect?: string }> = [];
    vi.stubGlobal("fetch", (async (u: string, init?: RequestInit) => {
      asked.push({ url: String(u), redirect: init?.redirect as string | undefined });
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch);
    try {
      for (const override of ["https://evil.example/m.bin", "http://127.0.0.1:9/m.bin", "http://localhost/m.bin", "https://models.shield-agent.com.evil.example/m.bin"]) {
        const r = await downloadTriageModel({ ...env, KYA_TRIAGE_MODEL_URL: override });
        expect(r.ok).toBe(false);
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(asked).toHaveLength(4);
    for (const a of asked) expect(a).toEqual({ url: TRIAGE_MODEL_URL, redirect: "manual" });
  });

  it("the check on the url has no exception: loopback http, another host, a port and credentials all fail", () => {
    for (const url of ["http://127.0.0.1:8080/m.bin", "http://localhost/m.bin", "https://localhost/m.bin", "https://evil.example/m.bin", "https://models.shield-agent.com:8443/m.bin", "https://u:p@models.shield-agent.com/m.bin", "http://models.shield-agent.com/m.bin"]) {
      expect(modelUrlRefusal(url), url).toBeDefined();
    }
    expect(modelUrlRefusal(TRIAGE_MODEL_URL)).toBeUndefined();
  });

  it("a real HTTP server on loopback (url passed to the download function, its check replaced): happy path, redirect, over-cap header, wrong hash", async () => {
    const good = Buffer.alloc(1_500_000, 7);
    const goodSha = createHash("sha256").update(good).digest("hex");
    const hits: string[] = [];
    const srv = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/ok") res.writeHead(200, { "content-length": good.length }).end(good);
      else if (req.url === "/redirect") res.writeHead(302, { location: "/ok" }).end();
      else if (req.url === "/huge") {
        res.writeHead(200, { "content-length": TRIAGE_MODEL_MAX_BYTES + 1 });
        res.write(Buffer.alloc(1000));
        setTimeout(() => res.destroy(), 200);
      } else res.writeHead(200, { "content-length": 1_200_000 }).end(Buffer.alloc(1_200_000, 9));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const src = (path: string) => ({ url: base + path, refusal: () => undefined, sha256: goodSha });
    try {
      expect(await downloadModelFrom(env, src("/ok"))).toEqual({ ok: true });
      expect(readFileSync(triageModelInstallPath(env)).equals(good)).toBe(true);
      rmSync(triageModelInstallPath(env));
      const red = await downloadModelFrom(env, src("/redirect"));
      expect(red.ok).toBe(false);
      expect(red.detail).toContain("redirect");
      expect(hits.filter((h) => h === "/ok")).toHaveLength(1); // only the first, direct request: the Location was not followed
      const huge = await downloadModelFrom(env, src("/huge"));
      expect(huge.detail).toContain("larger than 200 MB");
      const wrong = await downloadModelFrom(env, src("/other"));
      expect(wrong.detail).toContain("sha256 does not match");
      expect(leftovers()).toEqual([]);
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("no answer within the connect time and silence while streaming both end the download", async () => {
    const hang = (async (_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal?.reason)))) as unknown as typeof fetch;
    const a = await downloadModelFrom(env, { url: URL_OK, fetch: hang, sha256: sha, connectTimeoutMs: 50 });
    expect(a.ok).toBe(false);
    expect(a.detail).toContain("no answer in 10 s");
    const stall = (async () =>
      new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(1000)) }), {
        headers: { "content-length": "1200000" },
      })) as unknown as typeof fetch;
    const b = await downloadModelFrom(env, { url: URL_OK, fetch: stall, sha256: sha, readTimeoutMs: 80 });
    expect(b.ok).toBe(false);
    expect(b.detail).toContain("no data for 60 s");
    expect(leftovers()).toEqual([]);
  });

  it("a network error is reported, not thrown", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await downloadModelFrom(env, { url: URL_OK, fetch: boom, sha256: sha })).toEqual({ ok: false, detail: "offline" });
  });
});

describe.skipIf(process.platform === "win32")("kya start (real CLI): security alerts question", () => {
  const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
  let dir: string;
  let bin: string;
  let server: Server | undefined;
  const served = Buffer.alloc(1_200_000, 5); // a file that is not the pinned model

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kya-triage-cli-"));
    bin = join(dir, "bin");
    mkdirSync(bin);
    // A fake npm: puts the runtime where `npm install --prefix <dir> pkg` would.
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      `#!/bin/sh
echo "$@" > "${dir}/npm-args.txt"
prefix=""
while [ $# -gt 0 ]; do if [ "$1" = "--prefix" ]; then prefix="$2"; fi; shift; done
mkdir -p "$prefix/node_modules/onnxruntime-node"
echo '{"name":"onnxruntime-node","version":"1.30.0","main":"index.js"}' > "$prefix/node_modules/onnxruntime-node/package.json"
echo 'exports.x=1' > "$prefix/node_modules/onnxruntime-node/index.js"
for p in linux darwin win32; do mkdir -p "$prefix/node_modules/onnxruntime-node/bin/napi-v6/$p/x64"; echo bin > "$prefix/node_modules/onnxruntime-node/bin/napi-v6/$p/x64/onnxruntime_binding.node"; done
`,
    );
    chmodSync(npm, 0o755);
  });
  afterEach(async () => {
    // `kya start` leaves its report daemon running: stop it by the pid in its state file.
    try {
      const st = JSON.parse(readFileSync(join(dir, "proj", ".kya", "receipt-server.json"), "utf8")) as { pid?: number };
      if (typeof st.pid === "number") process.kill(st.pid, "SIGTERM");
    } catch {
      /* no daemon was started */
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function run(extraEnv: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const proj = join(dir, "proj");
    mkdirSync(proj, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliJs, "start", "--no-open", "--no-gate"], {
        cwd: proj,
        env: {
          ...process.env,
          HOME: dir,
          KYA_HOME: dir,
          KYA_NO_BROWSER: "1",
          KYA_SKIP_NODE_CHECK: "1",
          KYA_TELEMETRY: "0",
          KYA_SEMANTIC: "off",
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          ...extraEnv,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  /** A loopback server that counts every request it gets (the model URL override must never reach it). */
  async function countingServer(): Promise<{ url: string; hits: () => number }> {
    let n = 0;
    server = createServer((_req, res) => {
      n++;
      res.writeHead(200, { "content-length": Buffer.byteLength(served) }).end(served);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/kya-triage-v1.bin`, hits: () => n };
  }

  it("no terminal: start exits 0, installs nothing, prints one hint line", async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Security alerts are off. Turn them on: KYA_ALERTS=on kya start");
    expect(existsSync(join(dir, "npm-args.txt"))).toBe(false);
    expect(triageRuntimeInstalled({ KYA_HOME: dir })).toBe(false);
  }, 30_000);

  it("KYA_ALERTS=off: start prints nothing about alerts and installs nothing", async () => {
    const r = await run({ KYA_ALERTS: "off" });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Security alerts");
    expect(existsSync(join(dir, "npm-args.txt"))).toBe(false);
  }, 30_000);

  it("KYA_ALERTS=on with a local model file: pinned npm install into the opt-in folder, alerts on, start exits 0", async () => {
    const model = join(dir, "local-model.bin");
    writeFileSync(model, packModel());
    const r = await run({ KYA_ALERTS: "on", KYA_TRIAGE_MODEL_PATH: model, KYA_ALERTS_DESKTOP: "off" });
    expect(r.code).toBe(0);
    const args = readFileSync(join(dir, "npm-args.txt"), "utf8");
    expect(args).toContain("install");
    expect(args).toContain("--prefix");
    expect(args).toContain(join(dir, ".kya", "triage"));
    expect(args).toContain("onnxruntime-node@1.30.0");
    expect(triageRuntimeInstalled({ KYA_HOME: dir })).toBe(true);
    expect(args).toContain("--ignore-scripts");
    // other platforms' native binaries are removed after the install, this platform's stays
    expect(readdirSync(join(dir, ".kya", "triage", "node_modules", "onnxruntime-node", "bin", "napi-v6"))).toEqual([process.platform]);
    expect(r.stderr).toContain("Security alerts are on, with local triage.");
    const cfg = JSON.parse(readFileSync(join(dir, ".kya", "config.json"), "utf8")) as { alerts: { enabled: boolean } };
    expect(cfg.alerts.enabled).toBe(true);
  }, 30_000);

  it("KYA_TRIAGE_MODEL_URL set to a loopback server: ignored, the server gets no request, start exits 0", async () => {
    const srv = await countingServer();
    const model = join(dir, "local-model.bin");
    writeFileSync(model, packModel());
    const r = await run({ KYA_ALERTS: "on", KYA_TRIAGE_MODEL_PATH: model, KYA_TRIAGE_MODEL_URL: srv.url, KYA_ALERTS_DESKTOP: "off" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Security alerts are on, with local triage.");
    expect(srv.hits()).toBe(0);
  }, 30_000);

  it("a broken npm: start still exits 0 and prints the manual command", async () => {
    writeFileSync(join(bin, "npm"), "#!/bin/sh\necho 'boom' >&2\nexit 1\n");
    chmodSync(join(bin, "npm"), 0o755);
    const r = await run({ KYA_ALERTS: "on", KYA_ALERTS_DESKTOP: "off" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Could not install the local runtime (boom)");
    expect(r.stderr).toContain("KYA_ALERTS=on kya start");
    expect(triageRuntimeInstalled({ KYA_HOME: dir })).toBe(false);
  }, 30_000);
});
