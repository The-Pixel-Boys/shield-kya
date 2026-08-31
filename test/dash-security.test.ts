import { describe, expect, it } from "vitest";
import { assertNoSecrets, clip, stripEscapes } from "../src/dash/render.js";
import { sanitizedScorecardEnv } from "../src/orr/scorecard.js";
import { isMachineApiKey } from "../src/client.js";

describe("dash security helpers", () => {
  it("assertNoSecrets scans extra haystack and JWTs", () => {
    expect(() => assertNoSecrets("ok", "Bearer abcdefghijklmnop")).toThrow(/secret/);
    expect(() =>
      assertNoSecrets(
        "frame",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toThrow(/secret/);
    expect(() => assertNoSecrets("clean frame", "no secrets here")).not.toThrow();
  });

  it("clip strips ESC / OSC sequences", () => {
    const dirty = "hello\u001b]52;c;AAAA\u0007world";
    expect(clip(dirty)).toBe("helloworld");
    expect(stripEscapes("a\u001b[31mb")).toBe("ab");
  });

  it("machine API keys are sk_*", () => {
    expect(isMachineApiKey("sk_live_abc")).toBe(true);
    expect(isMachineApiKey("sk_test_abc")).toBe(true);
    expect(isMachineApiKey("kya_user_jwt_like")).toBe(false);
  });

  it("scorecard env strips KYA_API_KEY and tokens", () => {
    const clean = sanitizedScorecardEnv({
      PATH: "/usr/bin",
      KYA_API_KEY: "sk_live_secret",
      NODE_AUTH_TOKEN: "npm_xxx",
      HOME: "/tmp",
    });
    expect(clean.PATH).toBe("/usr/bin");
    expect(clean.HOME).toBe("/tmp");
    expect(clean.KYA_API_KEY).toBeUndefined();
    expect(clean.NODE_AUTH_TOKEN).toBeUndefined();
  });
});
