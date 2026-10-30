// Unit tests for the RFC 8628 device flow client (src/login/device-flow.ts).
// Fetch, sleep and clock are injected, so slow_down and expiry run without real waits.
import { describe, expect, it } from "vitest";
import {
  LoginError,
  MAX_TRANSIENT_FAILURES,
  pollForToken,
  requestDeviceCode,
  validateConsoleUrl,
  type DeviceCode,
} from "../src/login/device-flow.js";

const BASE = new URL("https://console.example.test");
const CODE: DeviceCode = {
  deviceCode: "device-code-0123456789abcdef",
  userCode: "ABCD-EFGH",
  verificationUri: "https://console.example.test/app/device",
  expiresInSec: 600,
  intervalSec: 5,
};

type Answer = { status: number; body?: unknown } | "throw" | "hang";

/** A fetch that answers from a script, one entry per call. The last entry repeats. */
function scripted(answers: Answer[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (a === "throw") throw new TypeError("fetch failed");
    if (a === "hang") {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(a.body === undefined ? "not json" : JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Injected clock: sleep advances time, so the local expiry check is deterministic. */
function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LoginError);
  expect((err as LoginError).code).toBe(code);
}

describe("validateConsoleUrl", () => {
  it("accepts https and loopback http", () => {
    expect(validateConsoleUrl("https://shield-agent.com").origin).toBe("https://shield-agent.com");
    expect(validateConsoleUrl("http://127.0.0.1:8080").origin).toBe("http://127.0.0.1:8080");
    expect(validateConsoleUrl("http://localhost:8080").origin).toBe("http://localhost:8080");
  });
  it.each([
    ["plain http to a remote host", "http://console.example.test"],
    ["credentials in the URL", "https://user:pw@console.example.test"],
    ["a query", "https://console.example.test/?x=1"],
    ["a fragment", "https://console.example.test/#x"],
    ["a non-URL", "not a url"],
    ["a non-ASCII host", "https://консоль.example.test"],
  ])("refuses %s", (_label, raw) => {
    expect(() => validateConsoleUrl(raw)).toThrow(LoginError);
  });
});

describe("requestDeviceCode", () => {
  const good = {
    device_code: CODE.deviceCode,
    user_code: CODE.userCode,
    verification_uri: CODE.verificationUri,
    expires_in: 600,
    interval: 5,
  };

  it("returns the codes on 200", async () => {
    const { fetchImpl, calls } = scripted([{ status: 200, body: good }]);
    const code = await requestDeviceCode(BASE, { clientVersion: "0.0.0", fetch: fetchImpl });
    expect(code).toEqual(CODE);
    expect(calls[0]!.url).toBe("https://console.example.test/api/v1/kya/device/code");
    expect(calls[0]!.body).toEqual({ client: "kya-cli", version: "0.0.0" });
  });

  it("reports LOGIN_RATE_LIMITED when this network starts too many logins (429)", async () => {
    const { fetchImpl } = scripted([{ status: 429, body: { error: "slow_down" } }]);
    await rejectsWith(requestDeviceCode(BASE, { clientVersion: "0", fetch: fetchImpl }), "LOGIN_RATE_LIMITED");
  });

  it("reports LOGIN_UNAVAILABLE when the feature is off (404)", async () => {
    const { fetchImpl } = scripted([{ status: 404 }]);
    await rejectsWith(requestDeviceCode(BASE, { clientVersion: "0", fetch: fetchImpl }), "LOGIN_UNAVAILABLE");
  });

  it("refuses a verification page on another origin (no foreign page is opened)", async () => {
    const { fetchImpl } = scripted([
      { status: 200, body: { ...good, verification_uri: "https://evil.example.test/app/device" } },
    ]);
    await rejectsWith(requestDeviceCode(BASE, { clientVersion: "0", fetch: fetchImpl }), "LOGIN_WRONG_STATE");
  });

  it.each([
    ["a short device code", { device_code: "short" }],
    ["a missing user code", { user_code: undefined }],
    ["a zero expiry", { expires_in: 0 }],
    ["an interval over 60", { interval: 61 }],
  ])("refuses %s", async (_label, patch) => {
    const { fetchImpl } = scripted([{ status: 200, body: { ...good, ...patch } }]);
    await rejectsWith(requestDeviceCode(BASE, { clientVersion: "0", fetch: fetchImpl }), "LOGIN_WRONG_STATE");
  });

  it("reports LOGIN_NETWORK when the server cannot be reached", async () => {
    const { fetchImpl } = scripted(["throw"]);
    await rejectsWith(requestDeviceCode(BASE, { clientVersion: "0", fetch: fetchImpl }), "LOGIN_NETWORK");
  });
});

describe("pollForToken", () => {
  const ok = { status: 200, body: { access_token: "sk_live_abcdefgh0123456789", key_prefix: "sk_live_abcdefgh" } };
  const pending = { status: 400, body: { error: "authorization_pending" } };

  it("returns the key after one pending answer", async () => {
    const t = clock();
    const { fetchImpl, calls } = scripted([pending, ok]);
    const got = await pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now });
    expect(got).toEqual({ apiKey: "sk_live_abcdefgh0123456789", keyPrefix: "sk_live_abcdefgh" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual({ device_code: CODE.deviceCode });
    expect(t.sleeps).toEqual([5000, 5000]);
  });

  it("adds 5 seconds to the interval on slow_down (RFC 8628)", async () => {
    const t = clock();
    const { fetchImpl } = scripted([{ status: 400, body: { error: "slow_down" } }, ok]);
    await pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now });
    expect(t.sleeps).toEqual([5000, 10000]);
  });

  it("reports LOGIN_EXPIRED on expired_token", async () => {
    const t = clock();
    const { fetchImpl } = scripted([{ status: 400, body: { error: "expired_token" } }]);
    await rejectsWith(pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now }), "LOGIN_EXPIRED");
  });

  it("stops on the local deadline without another request", async () => {
    const t = clock();
    const { fetchImpl, calls } = scripted([pending]);
    const short = { ...CODE, expiresInSec: 12 };
    await rejectsWith(pollForToken(BASE, short, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now }), "LOGIN_EXPIRED");
    // 12 s deadline, 5 s interval: polls at 5 s and 10 s, then the deadline check fires at 15 s.
    expect(calls).toHaveLength(2);
  });

  it("reports LOGIN_DENIED when the user denies (access_denied)", async () => {
    const t = clock();
    const { fetchImpl } = scripted([{ status: 400, body: { error: "access_denied" } }]);
    await rejectsWith(pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now }), "LOGIN_DENIED");
  });

  it.each([
    ["an unknown error (consumed or wrong code)", { status: 400, body: { error: "invalid_grant" } }],
    ["a 400 with no JSON", { status: 400 }],
    ["a 200 with a malformed key", { status: 200, body: { access_token: "short" } }],
    ["a 200 with no JSON", { status: 200 }],
  ] as const)("aborts on %s with LOGIN_WRONG_STATE", async (_label, answer) => {
    const t = clock();
    const { fetchImpl } = scripted([answer as Answer]);
    await rejectsWith(pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now }), "LOGIN_WRONG_STATE");
  });

  it("reports LOGIN_CAP_REACHED when the workspace key cap is hit (409)", async () => {
    const t = clock();
    const { fetchImpl } = scripted([{ status: 409, body: { error: "api_key.cap_reached" } }]);
    await rejectsWith(pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now }), "LOGIN_CAP_REACHED");
  });

  it("reports LOGIN_UNAVAILABLE when polling hits a 404", async () => {
    const t = clock();
    const { fetchImpl } = scripted([{ status: 404 }]);
    await rejectsWith(pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now }), "LOGIN_UNAVAILABLE");
  });

  it("gives up after MAX_TRANSIENT_FAILURES network errors in a row", async () => {
    const t = clock();
    const { fetchImpl, calls } = scripted(["throw"]);
    await rejectsWith(pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now }), "LOGIN_NETWORK");
    expect(calls).toHaveLength(MAX_TRANSIENT_FAILURES);
  });

  it("recovers when a failure is followed by an answer", async () => {
    const t = clock();
    const { fetchImpl } = scripted(["throw", { status: 503 }, ok]);
    const got = await pollForToken(BASE, CODE, { clientVersion: "0", fetch: fetchImpl, sleep: t.sleep, now: t.now });
    expect(got.keyPrefix).toBe("sk_live_abcdefgh");
  });

  it("counts a slow answer (past the request timeout) as a transient failure", async () => {
    const t = clock();
    const { fetchImpl, calls } = scripted(["hang", ok]);
    const got = await pollForToken(BASE, CODE, {
      clientVersion: "0",
      fetch: fetchImpl,
      sleep: t.sleep,
      now: t.now,
      requestTimeoutMs: 20,
    });
    expect(got.apiKey).toBe("sk_live_abcdefgh0123456789");
    expect(calls).toHaveLength(2);
  });
});

describe("loginBrowserOpener", () => {
  // Imported here to keep the device-flow tests free of command wiring.
  it("opens only for a person at a terminal, and never with KYA_NO_BROWSER=1", async () => {
    const { loginBrowserOpener } = await import("../src/commands/login.js");
    const open = () => {};
    expect(loginBrowserOpener({}, true, open)).toBe(open);
    expect(loginBrowserOpener({}, false, open)).toBeUndefined();
    expect(loginBrowserOpener({ KYA_NO_BROWSER: "1" }, true, open)).toBeUndefined();
    expect(loginBrowserOpener({ CI: "true" }, false, open)).toBeUndefined();
  });
});
