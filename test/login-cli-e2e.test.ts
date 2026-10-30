// `kya login` / `kya logout` through runCli against a stub hosted console on 127.0.0.1.
// Happy and denied paths: approved, denied, expired code, wrong state, feature off, server down,
// wrong origin on the verification page. Nothing is stored on any denied path.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { credentialsPath } from "../src/login/credentials.js";

// Fakes are built at runtime so the repo token-shape scan (mirror push protection) does not see a literal.
const LIVE = "sk_" + "live_";
const KEY = LIVE + "e2e0123456789abcdef0123456789abcdef";
const PREFIX = LIVE + "e2e01234";

type Reply = { status: number; body?: unknown };
interface Script {
  code?: Reply;
  /** Answers for successive token polls. The last one repeats. */
  token: Reply[];
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function stub(script: Script): Promise<string> {
  const polls = { n: 0 };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (r: Reply) => {
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(r.body === undefined ? "" : JSON.stringify(r.body));
      };
      if (req.url === "/api/v1/kya/device/code") {
        return send(
          script.code ?? {
            status: 200,
            body: {
              device_code: "device-code-e2e-0123456789",
              user_code: "WXYZ-2345",
              verification_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/app/device`,
              expires_in: 600,
              interval: 1,
            },
          },
        );
      }
      if (req.url === "/api/v1/kya/device/token") {
        const r = script.token[Math.min(polls.n, script.token.length - 1)]!;
        polls.n++;
        return send(r);
      }
      send({ status: 404 });
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function run(argv: string[], home: string) {
  const logs: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    exit: () => {},
    isTty: false,
  };
  const env = { KYA_SKIP_NODE_CHECK: "1", KYA_HOME: home, KYA_NO_BROWSER: "1" };
  const cwd = mkdtempSync(join(tmpdir(), "kya-login-cwd-"));
  dirs.push(cwd);
  return runCli(argv, io, env, cwd).then((code) => ({ code, out: logs.join("\n"), err: errors.join("\n") }));
}

function home(): string {
  const d = mkdtempSync(join(tmpdir(), "kya-login-home-"));
  dirs.push(d);
  return d;
}

const approved: Reply = { status: 200, body: { access_token: KEY, token_type: "Bearer", key_prefix: PREFIX } };
const pending: Reply = { status: 400, body: { error: "authorization_pending" } };

describe("kya login (happy path)", { timeout: 30_000 }, () => {
  it("completes after one pending poll, stores the key with mode 0600, never prints it", async () => {
    const base = await stub({ token: [pending, approved] });
    const h = home();
    const r = await run(["login", "--base-url", base], h);
    expect(r.code).toBe(0);
    expect(r.out).toContain("WXYZ-2345");
    expect(r.out).toContain(`Logged in. Key ${PREFIX}...`);
    expect(r.out).toContain("only if you started this login yourself");
    expect(r.out).not.toContain(KEY);
    expect(r.err).not.toContain(KEY);
    const path = credentialsPath({ KYA_HOME: h });
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { apiKey: string; baseUrl: string };
    expect(saved.apiKey).toBe(KEY);
    expect(saved.baseUrl).toBe(base);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("kya logout removes the key file and says the server key stays active", async () => {
    const base = await stub({ token: [approved] });
    const h = home();
    expect((await run(["login", "--base-url", base], h)).code).toBe(0);
    const out = await run(["logout"], h);
    expect(out.code).toBe(0);
    expect(out.out).toContain("stays active on the server");
    expect(existsSync(credentialsPath({ KYA_HOME: h }))).toBe(false);
    const again = await run(["logout"], h);
    expect(again.out).toContain("Nothing to remove");
  });
});

describe("kya login (denied and failure paths store nothing)", { timeout: 30_000 }, () => {
  const cases: [string, Script, string, string][] = [
    ["the user denies", { token: [{ status: 400, body: { error: "access_denied" } }] }, "LOGIN_DENIED", "denied"],
    ["the code expires", { token: [pending, { status: 400, body: { error: "expired_token" } }] }, "LOGIN_EXPIRED", "expired"],
    ["the answer is unknown (wrong state)", { token: [{ status: 400, body: { error: "invalid_grant" } }] }, "LOGIN_WRONG_STATE", "unexpected answer"],
    ["the feature is off on the server", { code: { status: 404 }, token: [approved] }, "LOGIN_UNAVAILABLE", "not available"],
    ["the workspace key cap is reached", { token: [{ status: 409, body: { error: "api_key.cap_reached" } }] }, "LOGIN_CAP_REACHED", "maximum number of API keys"],
    ["the verification page is on another origin", {
      code: { status: 200, body: { device_code: "device-code-e2e-0123456789", user_code: "WXYZ-2345", verification_uri: "https://evil.example.test/app/device", expires_in: 600, interval: 1 } },
      token: [approved],
    }, "LOGIN_WRONG_STATE", "unexpected answer"],
  ];
  it.each(cases)("%s", async (_label, script, _code, text) => {
    const base = await stub(script);
    const h = home();
    const r = await run(["login", "--base-url", base], h);
    expect(r.code).toBe(1);
    expect(r.err).toContain(text);
    expect(existsSync(credentialsPath({ KYA_HOME: h }))).toBe(false);
  });

  it("the server is down: exits 1, stores nothing", async () => {
    const base = await stub({ token: [approved] });
    // Stop the stub, then point the login at its now-closed port.
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    const h = home();
    const r = await run(["login", "--base-url", base], h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not reach the hosted console");
    expect(existsSync(credentialsPath({ KYA_HOME: h }))).toBe(false);
  });

  it("a plain http URL to a remote host is refused before any request", async () => {
    const h = home();
    const r = await run(["login", "--base-url", "http://console.example.test"], h);
    expect(r.code).toBe(1);
    expect(r.err).toContain("must be https");
    expect(existsSync(credentialsPath({ KYA_HOME: h }))).toBe(false);
  });
});
