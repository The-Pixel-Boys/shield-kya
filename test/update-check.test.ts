import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkForUpdate,
  compareVersions,
  formatUpdateBanner,
  shouldSkipUpdateCheck,
} from "../src/update-check.js";
import { freshTestHome } from "./setup.js";

function fakeFetch(latest: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ "dist-tags": { latest } }),
  })) as unknown as typeof fetch;
}

function failingFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

function makeEnv(): NodeJS.ProcessEnv {
  return { KYA_HOME: freshTestHome() };
}

describe("compareVersions", () => {
  it("compares semver triplets", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.2")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("strips a leading v", () => {
    expect(compareVersions("v0.20.0", "0.19.0")).toBeGreaterThan(0);
    expect(compareVersions("0.20.0", "v0.20.0")).toBe(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1", "1.0.1")).toBeLessThan(0);
  });
});

describe("shouldSkipUpdateCheck", () => {
  it("skips host-machine commands", () => {
    expect(shouldSkipUpdateCheck("serve-mcp", {}, {})).toBe(true);
    expect(shouldSkipUpdateCheck("hook", {}, {})).toBe(true);
    expect(shouldSkipUpdateCheck("wrap", {}, {})).toBe(true);
  });

  it("skips when explicitly disabled via flag", () => {
    expect(shouldSkipUpdateCheck("start", { "no-update-check": true }, {})).toBe(true);
    expect(shouldSkipUpdateCheck("start", { "no-update-check": "true" }, {})).toBe(true);
  });

  it("skips when disabled via env", () => {
    expect(shouldSkipUpdateCheck("start", {}, { KYA_UPDATE_CHECK: "0" })).toBe(true);
    expect(shouldSkipUpdateCheck("start", {}, { KYA_UPDATE_CHECK: "false" })).toBe(true);
  });

  it("skips in CI", () => {
    expect(shouldSkipUpdateCheck("start", {}, { CI: "true" })).toBe(true);
    expect(shouldSkipUpdateCheck("start", {}, { GITHUB_ACTIONS: "true" })).toBe(true);
  });

  it("skips machine-readable output", () => {
    expect(shouldSkipUpdateCheck("start", { json: true }, {})).toBe(true);
  });

  it("runs for ordinary interactive commands", () => {
    expect(shouldSkipUpdateCheck("start", {}, {})).toBe(false);
    expect(shouldSkipUpdateCheck("receipt", {}, {})).toBe(false);
  });

  it("skips when no command is provided", () => {
    expect(shouldSkipUpdateCheck(undefined, {}, {})).toBe(true);
  });
});

describe("checkForUpdate", () => {
  it("returns undefined when already on the latest version", async () => {
    const env = makeEnv();
    const fetch = fakeFetch("0.0.0");
    const result = await checkForUpdate({ fetch, env });
    expect(result).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns newer version info when npm is ahead", async () => {
    const env = makeEnv();
    const result = await checkForUpdate({ fetch: fakeFetch("99.99.99"), env });
    expect(result).toBeDefined();
    expect(result!.latest).toBe("99.99.99");
    expect(result!.current).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("uses a fresh cache and avoids a network call", async () => {
    const env = makeEnv();
    const fetch = fakeFetch("99.99.99");
    await checkForUpdate({ fetch, env });
    expect(fetch).toHaveBeenCalledTimes(1);

    const second = await checkForUpdate({ fetch, env });
    expect(second).toBeDefined();
    expect(second!.latest).toBe("99.99.99");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches when the cache is stale", async () => {
    const env = makeEnv();
    const fetch = fakeFetch("99.99.99");
    await checkForUpdate({ fetch, env });

    const cachePath = join(env.KYA_HOME!, ".kya", "update-check.json");
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as { checkedAt: string };
    const stale = new Date(raw.checkedAt).getTime() - 25 * 60 * 60 * 1000;
    const staleCache = JSON.stringify({ latest: "0.0.0", checkedAt: new Date(stale).toISOString() }, null, 2);
    // Simulating stale cache by rewriting it directly.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cachePath, staleCache, "utf8");

    const result = await checkForUpdate({ fetch, env });
    expect(result).toBeDefined();
    expect(result!.latest).toBe("99.99.99");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns undefined and does not throw when fetch fails", async () => {
    const env = makeEnv();
    const result = await checkForUpdate({ fetch: failingFetch(), env });
    expect(result).toBeUndefined();
  });

  it("skips network when offline", async () => {
    const env = makeEnv();
    env.KYA_OFFLINE = "1";
    const fetch = fakeFetch("99.99.99");
    const result = await checkForUpdate({ fetch, env });
    expect(result).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("formatUpdateBanner", () => {
  it("includes version numbers and update commands", () => {
    const text = formatUpdateBanner({ current: "0.1.0", latest: "0.2.0" });
    expect(text).toContain("0.2.0");
    expect(text).toContain("0.1.0");
    expect(text).toContain("kya update");
    expect(text).toContain("npm i -g @shield-agent/kya@latest");
  });
});
