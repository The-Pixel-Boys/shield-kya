/**
 * Opt-in telemetry: consent, gates, payload allow-list, the `kya telemetry` command, and the session
 * beacon. Unit level (injected fetch/prompt/clock); the real process + real socket paths live in
 * telemetry-e2e.test.ts.
 */
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import {
  CONSENT_NOTICE,
  DEFAULT_TELEMETRY_ENDPOINT,
  HOOK_PING_INTERVAL_MS,
  buildPayload,
  claimHookPingSlot,
  hookPingStampPath,
  isTelemetryEnabled,
  maybePromptConsent,
  maybeSpawnHookPing,
  sendHookPing,
  postTelemetry,
  readTelemetryState,
  runTelemetryCommand,
  startSessionBeacon,
  telemetryDisabledReason,
  telemetryEndpoint,
  telemetryHostId,
  telemetryStatePath,
  writeTelemetryState,
  type FetchLike,
  type TelemetryPayload,
} from "../src/telemetry.js";
import { CLI_VERSION } from "../src/version.js";
import { freshTestHome } from "./setup.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let home: string;
const envOf = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ KYA_HOME: home, ...extra });

beforeEach(() => {
  home = freshTestHome();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function optIn(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  writeTelemetryState(envOf(), {
    enabled: true,
    installId: "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c",
    askedAt: "2026-10-08T00:00:00.000Z",
  });
  return envOf(extra);
}

function okFetch(): ReturnType<typeof vi.fn> & FetchLike {
  return vi.fn(async () => ({ ok: true, status: 204 })) as ReturnType<typeof vi.fn> & FetchLike;
}

function bodies(fetchMock: ReturnType<typeof vi.fn>): TelemetryPayload[] {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string) as TelemetryPayload);
}

describe("gates", () => {
  it("DO_NOT_TRACK, KYA_TELEMETRY=off and CI force telemetry off, with a stated reason", () => {
    expect(telemetryDisabledReason({ DO_NOT_TRACK: "1" })).toMatch(/DO_NOT_TRACK/);
    expect(telemetryDisabledReason({ DO_NOT_TRACK: "true" })).toMatch(/DO_NOT_TRACK/);
    for (const v of ["0", "off", "FALSE", " no "]) {
      expect(telemetryDisabledReason({ KYA_TELEMETRY: v })).toMatch(/KYA_TELEMETRY/);
    }
    expect(telemetryDisabledReason({ CI: "true" })).toMatch(/CI/);
    expect(telemetryDisabledReason({ CI: "1" })).toMatch(/CI/);
    expect(telemetryDisabledReason({ GITHUB_ACTIONS: "true" })).toMatch(/CI/);
  });

  it("empty, zero or false values do not trigger the overrides", () => {
    for (const env of [{}, { DO_NOT_TRACK: "" }, { DO_NOT_TRACK: "0" }, { DO_NOT_TRACK: "false" },
      { KYA_TELEMETRY: "1" }, { CI: "false" }, { CI: "" }, { GITHUB_ACTIONS: "false" }]) {
      expect(telemetryDisabledReason(env)).toBeUndefined();
    }
  });

  it("KYA_OFFLINE does not block telemetry: it means sample-evaluate, and kya connect writes it to every host", () => {
    expect(telemetryDisabledReason({ KYA_OFFLINE: "1" })).toBeUndefined();
    expect(isTelemetryEnabled(optIn({ KYA_OFFLINE: "1" }))).toBe(true);
  });

  it("is enabled only with an opt-in, an install id, and no override", () => {
    expect(isTelemetryEnabled(envOf())).toBe(false);
    expect(isTelemetryEnabled(optIn())).toBe(true);
    expect(isTelemetryEnabled(optIn({ DO_NOT_TRACK: "1" }))).toBe(false);
    expect(isTelemetryEnabled(optIn({ KYA_TELEMETRY: "0" }))).toBe(false);
    expect(isTelemetryEnabled(optIn({ CI: "true" }))).toBe(false);
    writeTelemetryState(envOf(), { enabled: true });
    expect(isTelemetryEnabled(envOf())).toBe(false);
    writeTelemetryState(envOf(), { enabled: false, installId: "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c" });
    expect(isTelemetryEnabled(envOf())).toBe(false);
  });
});

describe("state file", () => {
  it("round-trips and lowercases the install id", () => {
    writeTelemetryState(envOf(), {
      enabled: true,
      installId: "3F2B8C1E-6A4D-4E0B-9C7A-1D2E3F4A5B6C",
      askedAt: "2026-10-08T00:00:00.000Z",
    });

    expect(readTelemetryState(envOf())).toEqual({
      enabled: true,
      installId: "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c",
      askedAt: "2026-10-08T00:00:00.000Z",
    });
  });

  it("treats a missing, corrupt or hand-edited file as never asked", () => {
    expect(readTelemetryState(envOf())).toEqual({});
    mkdirSync(join(home, ".kya"), { recursive: true });
    writeFileSync(telemetryStatePath(envOf()), "{not json");
    expect(readTelemetryState(envOf())).toEqual({});
    writeFileSync(telemetryStatePath(envOf()), JSON.stringify({ enabled: "yes", installId: "nope", askedAt: 5 }));
    expect(readTelemetryState(envOf())).toEqual({});
  });
});

describe("endpoint", () => {
  it("defaults to the hosted endpoint", () => {
    expect(telemetryEndpoint({})).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });

  it("accepts https and loopback http overrides only", () => {
    expect(telemetryEndpoint({ KYA_TELEMETRY_URL: "https://example.com/t" })).toBe("https://example.com/t");
    for (const u of ["http://127.0.0.1:9/t", "http://localhost:9/t", "http://[::1]:9/t"]) {
      expect(telemetryEndpoint({ KYA_TELEMETRY_URL: u })).toBe(u);
    }
  });

  it("rejects plain http to a remote host, embedded credentials, other schemes and garbage", () => {
    for (const u of ["http://example.com/t", "https://user:pw@example.com/t", "ftp://example.com", "not a url", "  "]) {
      expect(telemetryEndpoint({ KYA_TELEMETRY_URL: u })).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    }
  });
});

describe("host id", () => {
  it("is the host slug kya connect writes into KYA_SESSION_ID, else unknown", () => {
    expect(telemetryHostId({ KYA_SESSION_ID: "mcp:claude" })).toBe("claude");
    expect(telemetryHostId({ KYA_SESSION_ID: "mcp:grok-build" })).toBe("grok-build");
    for (const v of [undefined, "local-2026-10-08", "mcp:Cursor", "mcp:", `mcp:a${"b".repeat(32)}`, "mcp:1abc"]) {
      expect(telemetryHostId(v === undefined ? {} : { KYA_SESSION_ID: v })).toBe("unknown");
    }
  });
});

describe("payload (the only fields that ever leave the machine)", () => {
  // A function, not a constant: `home` is assigned per test in beforeEach.
  const base = () => ({
    installId: "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c",
    sessionId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    event: "heartbeat" as const,
    surface: "mcp-stdio" as const,
    cwd: home,
  });

  it("has exactly this key set: adding a field is a privacy change", () => {
    const payload = buildPayload({ ...base(), env: envOf() });

    expect(Object.keys(payload).sort()).toEqual(
      ["arch", "cliVersion", "event", "gateMode", "hostId", "hostedLinked", "installId", "nodeMajor",
        "os", "schema", "sessionId", "surface"],
    );
    expect(payload.schema).toBe(1);
    expect(payload.cliVersion).toBe(CLI_VERSION);
    expect(payload.os).toBe(process.platform);
    expect(payload.arch).toBe(process.arch);
  });

  it("satisfies the hosted validator's value shapes (mirrors KyaOssTelemetryPayloadValidator)", () => {
    const p = buildPayload({ ...base(), env: envOf({ KYA_SESSION_ID: "mcp:claude" }) });

    expect(p.installId).toMatch(UUID);
    expect(p.sessionId).toMatch(UUID);
    expect(["start", "heartbeat", "end"]).toContain(p.event);
    expect(["mcp-stdio", "mcp-http", "report", "gateway"]).toContain(p.surface);
    expect(p.cliVersion).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}(-[0-9A-Za-z.-]{1,24})?$/);
    expect(p.os).toMatch(/^[a-z0-9]{1,12}$/);
    expect(p.arch).toMatch(/^[a-z0-9]{1,12}$/);
    expect(Number.isInteger(p.nodeMajor) && p.nodeMajor >= 1 && p.nodeMajor <= 99).toBe(true);
    expect(p.hostId).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    expect(["observe", "hold", "offline"]).toContain(p.gateMode);
    expect(typeof p.hostedLinked).toBe("boolean");
  });

  it("reports the gate mode and whether a hosted key exists, as a boolean only", () => {
    expect(buildPayload({ ...base(), env: envOf() }).gateMode).toBe("observe");
    expect(buildPayload({ ...base(), env: envOf({ KYA_HOLD: "1" }) }).gateMode).toBe("hold");
    expect(buildPayload({ ...base(), env: envOf({ KYA_OFFLINE: "1" }) }).gateMode).toBe("offline");
    expect(buildPayload({ ...base(), env: envOf() }).hostedLinked).toBe(false);
    expect(buildPayload({ ...base(), env: envOf({ KYA_API_KEY: "   " }) }).hostedLinked).toBe(false);
    expect(buildPayload({ ...base(), env: envOf({ KYA_API_KEY: "sk_live_x" }) }).hostedLinked).toBe(true);
  });

  it("never contains a secret, a path, or a name from the environment", () => {
    const json = JSON.stringify(
      buildPayload({
        ...base(),
        cwd: "/Users/someone/secret-client-project",
        env: envOf({ KYA_API_KEY: "sk_live_SECRET123", USER: "someone", KYA_SESSION_ID: "mcp:claude" }),
      }),
    );

    expect(json).not.toContain("SECRET123");
    expect(json).not.toContain("secret-client-project");
    expect(json).not.toContain("someone");
    expect(json).not.toContain(home);
  });
});

describe("postTelemetry", () => {
  it("POSTs JSON with a short timeout, no redirects, and reports acceptance", async () => {
    const fetchMock = okFetch();

    const ok = await postTelemetry("https://x.test/t", { a: 1 }, fetchMock);

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.test/t");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(`shield-agent-kya-cli/${CLI_VERSION}`);
    expect(JSON.parse(init.body as string)).toEqual({ a: 1 });
  });

  it("returns false on a non-2xx, a network error, or a timeout, and never throws", async () => {
    expect(await postTelemetry("https://x.test", {}, vi.fn(async () => ({ ok: false, status: 500 })))).toBe(false);
    expect(await postTelemetry("https://x.test", {}, vi.fn(async () => { throw new Error("ECONNREFUSED"); }))).toBe(false);
    expect(await postTelemetry("https://x.test", {}, vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }))).toBe(false);
  });
});

describe("consent prompt", () => {
  const interactive = (answer: string) => {
    const errors: string[] = [];
    const ask = vi.fn(async () => answer);
    return { io: { error: (m: string) => errors.push(m), isTty: true, ask }, errors, ask };
  };

  it("does nothing off a terminal and saves nothing, so a later interactive run can ask", async () => {
    const errors: string[] = [];

    const result = await maybePromptConsent({ error: (m) => errors.push(m), isTty: false }, envOf());

    expect(result).toBe("skipped");
    expect(errors).toEqual([]);
    expect(existsSync(telemetryStatePath(envOf()))).toBe(false);
  });

  it("does not prompt when stdin/stderr are not TTYs (the default under test)", async () => {
    expect(await maybePromptConsent({ error: () => {} }, envOf())).toBe("skipped");
  });

  it("by default asks only when BOTH stdin and stderr are terminals (the question goes to stderr)", async () => {
    const setTty = (stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean | undefined) =>
      Object.defineProperty(stream, "isTTY", { value, configurable: true });
    const realIn = process.stdin.isTTY;
    const realErr = process.stderr.isTTY;
    const ask = vi.fn(async () => "y");
    try {
      setTty(process.stdin, true);
      setTty(process.stderr, false);
      expect(await maybePromptConsent({ error: () => {}, ask }, envOf())).toBe("skipped");

      setTty(process.stdin, false);
      setTty(process.stderr, true);
      expect(await maybePromptConsent({ error: () => {}, ask }, envOf())).toBe("skipped");
      expect(ask).not.toHaveBeenCalled();

      setTty(process.stdin, true);
      setTty(process.stderr, true);
      expect(await maybePromptConsent({ error: () => {}, ask }, envOf())).toBe("yes");
      expect(ask).toHaveBeenCalledTimes(1);
    } finally {
      setTty(process.stdin, realIn);
      setTty(process.stderr, realErr);
    }
  });

  it("says what is and is not sent, on stderr, and defaults to No", async () => {
    const { io, errors, ask } = interactive("");

    const result = await maybePromptConsent(io, envOf());

    expect(result).toBe("no");
    expect(errors.join("\n")).toContain("random install ID");
    expect(errors.join("\n")).toContain("Never: file paths, repo names, prompts, tool arguments, or code");
    expect(CONSENT_NOTICE.length).toBeGreaterThan(2);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("[y/N]"));
  });

  it("enables only on an explicit y or yes, and creates the random install id then", async () => {
    for (const answer of ["y", "Y", "yes", " YES ", "yEs\n"]) {
      const h = freshTestHome();
      const env = { KYA_HOME: h };
      const { io } = interactive(answer);

      expect(await maybePromptConsent(io, env)).toBe("yes");

      const state = readTelemetryState(env);
      expect(state.enabled).toBe(true);
      expect(state.installId).toMatch(UUID);
      expect(state.askedAt).toBeDefined();
    }
  });

  it("treats anything else as No and creates no install id", async () => {
    for (const answer of ["", "n", "no", "N", "maybe", "yep", "ye", "yes please", "true", "1"]) {
      const h = freshTestHome();
      const env = { KYA_HOME: h };
      const { io } = interactive(answer);

      expect(await maybePromptConsent(io, env)).toBe("no");

      expect(readTelemetryState(env)).toEqual({ enabled: false, askedAt: expect.any(String) });
    }
  });

  it("asks once: a recorded answer, either way, is never asked again", async () => {
    const { io, ask } = interactive("y");
    await maybePromptConsent(io, envOf());

    expect(await maybePromptConsent(io, envOf())).toBe("skipped");
    expect(ask).toHaveBeenCalledTimes(1);

    const declined = freshTestHome();
    const second = interactive("n");
    await maybePromptConsent(second.io, { KYA_HOME: declined });
    expect(await maybePromptConsent(second.io, { KYA_HOME: declined })).toBe("skipped");
    expect(second.ask).toHaveBeenCalledTimes(1);
  });

  it("never prompts or saves while an override forces telemetry off", async () => {
    for (const extra of [{ DO_NOT_TRACK: "1" }, { KYA_TELEMETRY: "0" }, { CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
      const { io, ask } = interactive("y");

      expect(await maybePromptConsent(io, envOf(extra))).toBe("skipped");
      expect(ask).not.toHaveBeenCalled();
    }
    expect(existsSync(telemetryStatePath(envOf()))).toBe(false);
  });

  it("the default prompt reads one line from stdin and writes its question to stderr, not stdout", async () => {
    const stdin = new PassThrough();
    const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    const stderrWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    try {
      const pending = maybePromptConsent({ error: () => {}, isTty: true }, envOf());
      stdin.write("yes\n");

      expect(await pending).toBe("yes");
      expect(stderrWrites.join("")).toContain("Share anonymous usage stats? [y/N]");
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      if (realStdin) Object.defineProperty(process, "stdin", realStdin);
    }
  });

  it("reports and sends nothing when the choice cannot be saved", async () => {
    const blocker = join(home, "a-file");
    writeFileSync(blocker, "x");
    const { io, errors } = interactive("y");

    const result = await maybePromptConsent(io, { KYA_HOME: blocker });

    expect(result).toBe("no");
    expect(errors.join("\n")).toContain("could not save your telemetry choice");
    expect(isTelemetryEnabled({ KYA_HOME: blocker })).toBe(false);
  });
});

describe("kya telemetry", () => {
  const run = async (
    sub: string | undefined,
    flags: { purge?: boolean; json?: boolean } = {},
    env: NodeJS.ProcessEnv = envOf(),
    fetchImpl: FetchLike = okFetch(),
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runTelemetryCommand(
      { sub, purge: flags.purge ?? false, json: flags.json ?? false },
      { log: (m) => out.push(m), error: (m) => err.push(m) },
      env,
      home,
      fetchImpl,
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("status reports not asked, on, off, and what overrides it", async () => {
    expect((await run(undefined)).out).toContain("Telemetry: not asked yet");
    expect((await run("status", {}, optIn())).out).toContain("Telemetry: on");
    const overridden = await run("status", {}, optIn({ DO_NOT_TRACK: "1" }));
    expect(overridden.out).toContain("Overridden for this process: DO_NOT_TRACK is set");
    writeTelemetryState(envOf(), { enabled: false, askedAt: "2026-10-08T00:00:00.000Z" });
    expect((await run("status")).out).toContain("Telemetry: off");
  });

  it("status --json is machine readable", async () => {
    const parsed = JSON.parse((await run("status", { json: true }, optIn({ CI: "true" }))).out);

    expect(parsed).toMatchObject({ enabled: true, effective: false, overriddenBy: "running in CI" });
    expect(parsed.installId).toMatch(UUID);
    expect(parsed.endpoint).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });

  it("on enables, keeps an existing id, and warns when an override applies", async () => {
    const first = await run("on");
    const id = readTelemetryState(envOf()).installId;
    expect(first.code).toBe(0);
    expect(id).toMatch(UUID);

    const again = await run("on", {}, envOf({ DO_NOT_TRACK: "1" }));
    expect(readTelemetryState(envOf()).installId).toBe(id);
    expect(again.out).toContain("DO_NOT_TRACK is set, so nothing is sent from this shell");
  });

  it("off disables without any network call", async () => {
    optIn();
    const fetchMock = okFetch();

    const result = await run("off", {}, envOf(), fetchMock);

    expect(result.code).toBe(0);
    expect(readTelemetryState(envOf()).enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("off --purge erases by POSTing the install id in the BODY, then removes it locally", async () => {
    optIn();
    const fetchMock = okFetch();

    const result = await run("off", { purge: true }, envOf(), fetchMock);

    expect(result.code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_TELEMETRY_ENDPOINT}/erase`);
    expect(url).not.toContain("3f2b8c1e");
    expect(JSON.parse(init.body as string)).toEqual({ installId: "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c" });
    expect(readTelemetryState(envOf())).toEqual({ enabled: false, askedAt: "2026-10-08T00:00:00.000Z" });
    expect(result.out).toContain("Erased everything stored for this install");
  });

  it("off --purge never loses the already-asked marker, so setup does not ask again after an erase", async () => {
    writeTelemetryState(envOf(), { enabled: true, installId: "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c" });

    await run("off", { purge: true });

    expect(readTelemetryState(envOf())).toEqual({ enabled: false, askedAt: expect.any(String) });
    const ask = vi.fn(async () => "y");
    expect(await maybePromptConsent({ error: () => {}, isTty: true, ask }, envOf())).toBe("skipped");
    expect(ask).not.toHaveBeenCalled();
  });

  it("status --json before anything is set reports nulls, not undefined", async () => {
    const parsed = JSON.parse((await run("status", { json: true })).out);

    expect(parsed).toEqual({ enabled: null, effective: false, installId: null, endpoint: DEFAULT_TELEMETRY_ENDPOINT, overriddenBy: null });
  });

  it("reset on a file that has an id but no recorded answer rotates the id and leaves the answer unset", async () => {
    writeTelemetryState(envOf(), { installId: "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c" });

    await run("reset");

    const state = readTelemetryState(envOf());
    expect(state.enabled).toBeUndefined();
    expect(state.installId).not.toBe("3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c");
  });

  it("off --purge keeps the id and fails loudly when the server cannot be reached", async () => {
    optIn();
    const failing = vi.fn(async () => { throw new Error("offline"); }) as unknown as FetchLike;

    const result = await run("off", { purge: true }, envOf(), failing);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Could not reach the server to erase your data");
    expect(readTelemetryState(envOf()).installId).toBe("3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c");
  });

  it("off --purge with no install id has nothing to erase and calls nothing", async () => {
    const fetchMock = okFetch();

    const result = await run("off", { purge: true }, envOf(), fetchMock);

    expect(result.code).toBe(0);
    expect(result.out).toContain("nothing to erase");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("erase follows a loopback endpoint override and tolerates a trailing slash", async () => {
    optIn({ KYA_TELEMETRY_URL: "http://127.0.0.1:9/x/telemetry/" });
    const fetchMock = okFetch();

    await run("off", { purge: true }, optIn({ KYA_TELEMETRY_URL: "http://127.0.0.1:9/x/telemetry/" }), fetchMock);

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:9/x/telemetry/erase");
  });

  it("show prints the exact payload shape with placeholders before opt-in, and never sends", async () => {
    const fetchMock = okFetch();

    const result = await run("show", {}, envOf(), fetchMock);

    expect(result.out).toContain("<random id, created only when you opt in>");
    expect(result.out).toContain("Never sent: file paths, repo names");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("show --json is the sample payload, using the real id after opt-in", async () => {
    const parsed = JSON.parse((await run("show", { json: true }, optIn())).out);

    expect(Object.keys(parsed).sort()).toHaveLength(12);
    expect(parsed.installId).toBe("3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c");
    expect(parsed.event).toBe("heartbeat");
  });

  it("reset rotates the install id and keeps the opt-in", async () => {
    optIn();

    const result = await run("reset");

    const state = readTelemetryState(envOf());
    expect(result.code).toBe(0);
    expect(state.enabled).toBe(true);
    expect(state.installId).toMatch(UUID);
    expect(state.installId).not.toBe("3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c");
  });

  it("reset with no opt-in and no id does nothing", async () => {
    const result = await run("reset");

    expect(result.out).toContain("Nothing to reset");
    expect(existsSync(telemetryStatePath(envOf()))).toBe(false);
  });

  it("reset keeps a recorded opt-out while rotating a leftover id", async () => {
    writeTelemetryState(envOf(), { enabled: false, installId: "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c" });

    await run("reset");

    const state = readTelemetryState(envOf());
    expect(state.enabled).toBe(false);
    expect(state.installId).not.toBe("3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c");
  });

  it("an unknown subcommand is a usage error", async () => {
    const result = await run("frobnicate");

    expect(result.code).toBe(2);
    expect(result.err).toContain("Usage: kya telemetry");
  });
});

describe("session beacon", () => {
  const deps = (env: NodeJS.ProcessEnv, fetchImpl: FetchLike, intervalMs = 1000) =>
    ({ env, cwd: home, fetchImpl, intervalMs });

  it("is silent and sends nothing without an opt-in", async () => {
    const fetchMock = okFetch();

    const beacon = startSessionBeacon("mcp-stdio", deps(envOf(), fetchMock));
    await beacon.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is silent while an override forces telemetry off, even after opt-in", async () => {
    const fetchMock = okFetch();

    const beacon = startSessionBeacon("report", deps(optIn({ DO_NOT_TRACK: "1" }), fetchMock));
    await beacon.stop();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends start immediately, a heartbeat per interval, and one end on stop", async () => {
    vi.useFakeTimers();
    const fetchMock = okFetch();
    const beacon = startSessionBeacon("mcp-http", deps(optIn({ KYA_SESSION_ID: "mcp:cursor" }), fetchMock));
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies(fetchMock).map((b) => b.event)).toEqual(["start"]);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bodies(fetchMock).map((b) => b.event)).toEqual(["start", "heartbeat", "heartbeat"]);

    await beacon.stop();
    await beacon.stop();
    await vi.advanceTimersByTimeAsync(5000);
    const events = bodies(fetchMock);
    expect(events.map((b) => b.event)).toEqual(["start", "heartbeat", "heartbeat", "end"]);
    expect(new Set(events.map((b) => b.sessionId)).size).toBe(1);
    expect(events.every((b) => b.installId === "3f2b8c1e-6a4d-4e0b-9c7a-1d2e3f4a5b6c")).toBe(true);
    expect(events.every((b) => b.surface === "mcp-http" && b.hostId === "cursor")).toBe(true);
  });

  it("uses a fresh session id per beacon", async () => {
    const fetchMock = okFetch();
    const env = optIn();

    await startSessionBeacon("report", deps(env, fetchMock)).stop();
    await startSessionBeacon("report", deps(env, fetchMock)).stop();

    const ids = bodies(fetchMock).map((b) => b.sessionId);
    expect(new Set(ids).size).toBe(2);
  });

  it("does not keep the process alive: the heartbeat timer is unref'd", async () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    const beacon = startSessionBeacon("gateway", deps(optIn(), okFetch()));

    expect(unref).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await beacon.stop();
  });

  it("writes nothing to stdout or stderr, even when every send fails", async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write");
    const failing = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as FetchLike;

    const beacon = startSessionBeacon("mcp-stdio", deps(optIn(), failing));
    await vi.advanceTimersByTimeAsync(5000);
    await beacon.stop();

    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it("stops sending for the rest of the process after three consecutive failures", async () => {
    vi.useFakeTimers();
    const failing = vi.fn(async () => { throw new Error("down"); });
    const beacon = startSessionBeacon("mcp-stdio", deps(optIn(), failing as unknown as FetchLike));

    await vi.advanceTimersByTimeAsync(10_000);
    await beacon.stop();

    expect(failing).toHaveBeenCalledTimes(3);
  });

  it("a success resets the failure count", async () => {
    vi.useFakeTimers();
    const results = [false, false, true, false, false, true];
    const flaky = vi.fn(async () => {
      if (results.shift() ?? true) return { ok: true, status: 204 };
      throw new Error("blip");
    });
    const beacon = startSessionBeacon("mcp-stdio", deps(optIn(), flaky as unknown as FetchLike));

    await vi.advanceTimersByTimeAsync(5000);
    await beacon.stop();

    expect(flaky.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("stop resolves only after the end beacon was attempted", async () => {
    let release: () => void = () => {};
    const gated = vi.fn(
      () => new Promise<{ ok: boolean; status: number }>((resolve) => { release = () => resolve({ ok: true, status: 204 }); }),
    );
    const beacon = startSessionBeacon("report", deps(optIn(), gated as unknown as FetchLike));
    release();
    await Promise.resolve();

    let stopped = false;
    const stopping = beacon.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;

    expect(stopped).toBe(true);
    expect(bodies(gated).map((b) => b.event)).toEqual(["start", "end"]);
  });

  it("honours KYA_TELEMETRY_INTERVAL_MS within bounds and ignores out-of-range or junk values", async () => {
    for (const [value, expectedMs] of [["200", 200], ["abc", 300_000], ["99", 300_000], ["4000000", 300_000]] as const) {
      vi.useFakeTimers();
      const fetchMock = okFetch();
      const env = optIn({ KYA_TELEMETRY_INTERVAL_MS: value });
      const beacon = startSessionBeacon("mcp-stdio", { env, cwd: home, fetchImpl: fetchMock });

      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      expect(bodies(fetchMock).map((b) => b.event), `${value}: before ${expectedMs}ms`).toEqual(["start"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(bodies(fetchMock).map((b) => b.event), `${value}: at ${expectedMs}ms`).toEqual(["start", "heartbeat"]);

      await beacon.stop();
      vi.useRealTimers();
    }
  });

  it("falls back to the global fetch when none is injected", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    const beacon = startSessionBeacon("report", { env: optIn(), cwd: home, intervalMs: 60_000 });
    await beacon.stop();

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("kya CLI integration (injected io)", () => {
  // The Node-upgrade gate runs before any command and PROMPTS on a TTY when Node is too old, which
  // would hang these tests on a dev machine with an older Node. It is irrelevant to telemetry.
  const cliEnv = () => envOf({ KYA_SKIP_NODE_CHECK: "1" });

  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m), exit: () => {} },
      out,
      err,
    };
  };

  it("kya telemetry on|status|off round-trips through runCli", async () => {
    const env = cliEnv();
    const cwd = freshTestHome();

    const c1 = capture();
    expect(await runCli(["telemetry", "on"], c1.io, env, cwd)).toBe(0);
    const c2 = capture();
    expect(await runCli(["telemetry", "status"], c2.io, env, cwd)).toBe(0);
    expect(c2.out.join("\n")).toContain("Telemetry: on");
    const c3 = capture();
    expect(await runCli(["telemetry", "off"], c3.io, env, cwd)).toBe(0);
    expect(readTelemetryState(env).enabled).toBe(false);
  });

  it("kya init asks once on a terminal and records the answer (stdout stays the command's own)", async () => {
    const env = cliEnv();
    const cwd = freshTestHome();
    const ask = vi.fn(async () => "y");
    const c = capture();

    expect(await runCli(["init"], { ...c.io, isTty: true, ask }, env, cwd)).toBe(0);

    expect(readTelemetryState(env).enabled).toBe(true);
    expect(c.err.join("\n")).toContain("Share anonymous usage stats");
    expect(c.out.join("\n")).not.toContain("Share anonymous usage stats");
    expect(c.out.join("\n")).toContain("KYA light scaffold ready");

    const again = capture();
    await runCli(["init"], { ...again.io, isTty: true, ask }, env, cwd);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("kya init --json never prompts and saves nothing, so its stdout stays valid JSON", async () => {
    const env = cliEnv();
    const ask = vi.fn(async () => "y");
    const c = capture();

    await runCli(["init", "--json"], { ...c.io, isTty: true, ask }, env, freshTestHome());

    expect(ask).not.toHaveBeenCalled();
    expect(existsSync(telemetryStatePath(env))).toBe(false);
    expect(() => JSON.parse(c.out.join("\n"))).not.toThrow();
  });

  it("kya connect asks once on a terminal before writing the host config", async () => {
    const env = cliEnv();
    const ask = vi.fn(async () => "n");
    const c = capture();

    const code = await runCli(["connect", "claude"], { ...c.io, isTty: true, ask }, env, freshTestHome());

    expect(code).toBe(0);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(readTelemetryState(env)).toEqual({ enabled: false, askedAt: expect.any(String) });
  });

  it("kya connect --json does not prompt", async () => {
    const ask = vi.fn(async () => "y");

    await runCli(["connect", "claude", "--json"], { ...capture().io, isTty: true, ask }, cliEnv(), freshTestHome());

    expect(ask).not.toHaveBeenCalled();
  });

  it("non-interactive setup commands neither prompt nor save, in any host", async () => {
    const env = cliEnv();
    const ask = vi.fn(async () => "y");

    await runCli(["init"], { ...capture().io, isTty: false, ask }, env, freshTestHome());

    expect(ask).not.toHaveBeenCalled();
    expect(existsSync(telemetryStatePath(env))).toBe(false);
  });

  it("an unknown telemetry subcommand exits 2 through runCli", async () => {
    const c = capture();

    expect(await runCli(["telemetry", "nope"], c.io, cliEnv(), freshTestHome())).toBe(2);
    expect(c.err.join("\n")).toContain("Usage: kya telemetry");
  });

  it("the help text lists the command and says it is off by default", async () => {
    const c = capture();

    await runCli(["help"], c.io, cliEnv(), freshTestHome());

    expect(c.out.join("\n")).toMatch(/telemetry\s+Opt-in anonymous usage stats, OFF by default/);
  });

  it("the state file is written under the global kya dir with the recorded answer only", async () => {
    const env = cliEnv();
    await runCli(["telemetry", "on"], capture().io, env, freshTestHome());

    const raw = JSON.parse(readFileSync(telemetryStatePath(env), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["askedAt", "enabled", "installId"]);
  });
});


describe("hook ping (hook-only installs have no long-lived process to heartbeat from)", () => {
  const spawnStub = () => {
    const child = { unref: vi.fn(), on: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    return { child, spawnImpl };
  };
  const deps = (env: NodeJS.ProcessEnv, spawnImpl: ReturnType<typeof vi.fn>, extra: object = {}) => ({
    env,
    cwd: home,
    entry: "/opt/kya/dist/cli.js",
    spawnImpl: spawnImpl as never,
    ...extra,
  });

  it("starts nothing without an opt-in, and leaves no stamp behind", () => {
    const { spawnImpl } = spawnStub();

    expect(maybeSpawnHookPing(deps(envOf(), spawnImpl))).toBe(false);

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(existsSync(hookPingStampPath(envOf()))).toBe(false);
  });

  it.each([["DO_NOT_TRACK", "1"], ["KYA_TELEMETRY", "0"], ["CI", "true"]])(
    "starts nothing while %s=%s overrides an opt-in",
    (key, value) => {
      const { spawnImpl } = spawnStub();

      expect(maybeSpawnHookPing(deps(optIn({ [key]: value }), spawnImpl))).toBe(false);

      expect(spawnImpl).not.toHaveBeenCalled();
    },
  );

  it("starts one detached helper `kya telemetry ping` with ignored stdio, and does not wait for it", () => {
    const { spawnImpl, child } = spawnStub();
    const env = optIn();

    expect(maybeSpawnHookPing(deps(env, spawnImpl))).toBe(true);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnImpl.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["/opt/kya/dist/cli.js", "telemetry", "ping"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true, cwd: home });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("pings at most once per day however many tool calls fire the hook", () => {
    const { spawnImpl } = spawnStub();
    const env = optIn();
    const t0 = Date.now();

    expect(maybeSpawnHookPing(deps(env, spawnImpl, { nowMs: t0 }))).toBe(true);
    expect(maybeSpawnHookPing(deps(env, spawnImpl, { nowMs: t0 + 60_000 }))).toBe(false);
    expect(maybeSpawnHookPing(deps(env, spawnImpl, { nowMs: t0 + HOOK_PING_INTERVAL_MS - 1000 }))).toBe(false);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("pings again once the day has passed", () => {
    const { spawnImpl } = spawnStub();
    const env = optIn();
    maybeSpawnHookPing(deps(env, spawnImpl));
    const stamp = hookPingStampPath(env);
    const yesterday = new Date(Date.now() - HOOK_PING_INTERVAL_MS - 60_000);
    utimesSync(stamp, yesterday, yesterday);

    expect(maybeSpawnHookPing(deps(env, spawnImpl))).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it("claims the slot BEFORE spawning, so a burst of hooks starts one helper", () => {
    const env = optIn();
    let stampedAtSpawn = false;
    const spawnImpl = vi.fn(() => {
      stampedAtSpawn = existsSync(hookPingStampPath(env));
      return { unref: vi.fn(), on: vi.fn() };
    });

    maybeSpawnHookPing(deps(env, spawnImpl));

    expect(stampedAtSpawn).toBe(true);
  });

  it("never throws: a spawn that blows up is swallowed and the hook carries on", () => {
    const env = optIn();
    const spawnImpl = vi.fn(() => {
      throw new Error("EAGAIN");
    });

    expect(() => maybeSpawnHookPing(deps(env, spawnImpl))).not.toThrow();
    expect(maybeSpawnHookPing(deps(optIn({ KYA_HOME: "/proc/definitely/not/writable" }), spawnImpl))).toBe(false);
  });

  it("starts nothing when there is no entry script to re-run, and does not burn the day's slot", () => {
    const { spawnImpl } = spawnStub();
    const env = optIn();
    const argv1 = process.argv[1];
    process.argv[1] = undefined as unknown as string;
    try {
      expect(maybeSpawnHookPing({ env, cwd: home, spawnImpl: spawnImpl as never })).toBe(false);
    } finally {
      process.argv[1] = argv1 as string;
    }
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(existsSync(hookPingStampPath(env))).toBe(false);
  });

  it("hands the hook's --host to the helper so the host mix is meaningful, without overriding an existing session id", () => {
    const first = spawnStub();
    const second = spawnStub();
    const third = spawnStub();
    const env = optIn();

    maybeSpawnHookPing(deps(env, first.spawnImpl, { host: "claude" }));
    const helperEnv = (first.spawnImpl.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(helperEnv["KYA_SESSION_ID"]).toBe("mcp:claude");
    expect(telemetryHostId(helperEnv)).toBe("claude");

    const stamp = hookPingStampPath(env);
    const old = new Date(Date.now() - HOOK_PING_INTERVAL_MS - 60_000);
    utimesSync(stamp, old, old);
    maybeSpawnHookPing(deps({ ...env, KYA_SESSION_ID: "mcp:cursor" }, second.spawnImpl, { host: "claude" }));
    expect((second.spawnImpl.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env["KYA_SESSION_ID"]).toBe("mcp:cursor");

    utimesSync(stamp, old, old);
    maybeSpawnHookPing(deps(env, third.spawnImpl, { host: "Not A Slug!" }));
    expect((third.spawnImpl.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env["KYA_SESSION_ID"]).toBeUndefined();
  });

  it("claims the day's slot exactly once: fresh stamp loses, stale stamp is replaced, a missing one is created", () => {
    const env = optIn();
    const t0 = Date.now();

    expect(claimHookPingSlot(env, t0)).toBe(true);
    expect(claimHookPingSlot(env, t0 + 1000)).toBe(false);
    expect(claimHookPingSlot(env, t0 + HOOK_PING_INTERVAL_MS - 1)).toBe(false);
    expect(existsSync(hookPingStampPath(env))).toBe(true);

    const old = new Date(t0 - HOOK_PING_INTERVAL_MS - 1000);
    utimesSync(hookPingStampPath(env), old, old);
    expect(claimHookPingSlot(env, t0)).toBe(true);
    expect(claimHookPingSlot(env, t0)).toBe(false);
  });

  it("loses the slot instead of throwing when the stamp cannot be created", () => {
    const env = optIn();
    mkdirSync(hookPingStampPath(env)); // a directory where the stamp file should be: wx create fails

    expect(claimHookPingSlot(env, Date.now() + 2 * HOOK_PING_INTERVAL_MS)).toBe(false);
  });

  it("the helper sends exactly one ping as surface hook with the standard allow-listed payload", async () => {
    const fetchMock = okFetch();

    expect(await sendHookPing(optIn(), home, fetchMock)).toBe(true);

    const [payload] = bodies(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ schema: 1, event: "ping", surface: "hook", cliVersion: CLI_VERSION });
    expect(Object.keys(payload as object).sort()).toEqual(
      ["arch", "cliVersion", "event", "gateMode", "hostId", "hostedLinked", "installId", "nodeMajor",
        "os", "schema", "sessionId", "surface"],
    );
  });

  it("the helper sends nothing without an opt-in or under an override", async () => {
    const fetchMock = okFetch();

    expect(await sendHookPing(envOf(), home, fetchMock)).toBe(false);
    expect(await sendHookPing(optIn({ DO_NOT_TRACK: "1" }), home, fetchMock)).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the helper reports false, without throwing, when the server is unreachable", async () => {
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;

    expect(await sendHookPing(optIn(), home, down)).toBe(false);
  });

  it("`kya telemetry ping` is silent and exits 0 whether or not it could send", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { log: (m: string) => out.push(m), error: (m: string) => err.push(m) };
    const fetchMock = okFetch();

    const sent = await runTelemetryCommand({ sub: "ping", purge: false, json: false }, io, optIn(), home, fetchMock);
    const skipped = await runTelemetryCommand({ sub: "ping", purge: false, json: false }, io, envOf({ KYA_HOME: freshTestHome() }), home, fetchMock);

    expect([sent, skipped]).toEqual([0, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });
});
