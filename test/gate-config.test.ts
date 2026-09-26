import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GATE_DEFAULT_OTLP_PORT,
  GATE_DEFAULT_PORT,
  gatewaysPath,
  readGateways,
  scaffoldGateways,
  validateGateways,
} from "../src/gate/config.js";
import { UsageError } from "../src/errors.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-gate-cfg-"));
}

function env(home: string): NodeJS.ProcessEnv {
  return { KYA_HOME: home };
}

describe("gateways.json schema", () => {
  it("accepts a minimal stdio server and applies default ports", () => {
    const cfg = validateGateways({
      servers: [{ id: "github", transport: "stdio", cmd: ["npx", "-y", "gh-mcp"] }],
    });
    expect(cfg.port).toBe(GATE_DEFAULT_PORT);
    expect(cfg.otlpPort).toBe(GATE_DEFAULT_OTLP_PORT);
    expect(cfg.servers).toEqual([{ id: "github", transport: "stdio", cmd: ["npx", "-y", "gh-mcp"] }]);
  });

  it("accepts http transport with url and headers", () => {
    const cfg = validateGateways({
      port: 4100,
      servers: [
        { id: "exa", transport: "http", url: "https://mcp.exa.ai/mcp", headers: { authorization: "Bearer x" } },
      ],
    });
    expect(cfg.port).toBe(4100);
    expect(cfg.servers[0]).toMatchObject({
      transport: "http",
      url: "https://mcp.exa.ai/mcp",
      headers: { authorization: "Bearer x" },
    });
  });

  it("rejects env on http transport (the gateway has no env concept there) and headers on stdio", () => {
    expect(() =>
      validateGateways({
        servers: [{ id: "a", transport: "http", url: "https://x.dev", env: { A: "b" } }],
      }),
    ).toThrow(/does not support "env"/);
    expect(() =>
      validateGateways({
        servers: [{ id: "a", transport: "stdio", cmd: ["npx", "x"], headers: { A: "b" } }],
      }),
    ).toThrow(/only applies to transport "http"/);
  });

  it("accepts failureMode failOpen/failClosed and defaults to failOpen", () => {
    expect(validateGateways({ servers: [] }).failureMode).toBe("failOpen");
    expect(validateGateways({ failureMode: "failClosed", servers: [] }).failureMode).toBe(
      "failClosed",
    );
    expect(() => validateGateways({ failureMode: "sometimes", servers: [] })).toThrow(
      /failureMode/,
    );
  });

  it("rejects underscores in ids (gateway target names forbid them)", () => {
    expect(() =>
      validateGateways({ servers: [{ id: "my_server", transport: "http", url: "https://x.dev" }] }),
    ).toThrow(UsageError);
  });

  it("rejects stdio without cmd and http without url", () => {
    expect(() => validateGateways({ servers: [{ id: "a", transport: "stdio" }] })).toThrow(
      /requires "cmd"/,
    );
    expect(() => validateGateways({ servers: [{ id: "a", transport: "http" }] })).toThrow(
      /requires "url"/,
    );
  });

  it("rejects duplicate ids, bad ports, and non-string env values", () => {
    expect(() =>
      validateGateways({
        servers: [
          { id: "a", transport: "http", url: "https://x.dev" },
          { id: "a", transport: "http", url: "https://y.dev" },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => validateGateways({ port: 70000, servers: [] })).toThrow(UsageError);
    expect(() =>
      validateGateways({ servers: [{ id: "a", transport: "http", url: "https://x.dev", env: { A: 1 } }] }),
    ).toThrow(UsageError);
  });

  it("the github recipe carries its auth as headers, not env", () => {
    const home = tmp();
    try {
      const first = scaffoldGateways(env(home));
      const raw = JSON.parse(readFileSync(first.path, "utf8")) as {
        recipes: { id: string; headers?: Record<string, string>; env?: unknown; transport: string }[];
        failureMode?: string;
      };
      const github = raw.recipes.find((r) => r.id === "github")!;
      expect(github.transport).toBe("http");
      expect(github.env).toBeUndefined();
      expect(github.headers).toMatchObject({ authorization: expect.stringContaining("Bearer") });
      // Every http recipe must validate against the schema (no env anywhere).
      for (const r of raw.recipes.filter((r) => r.transport === "http")) {
        expect(r.env, `recipe ${r.id}`).toBeUndefined();
      }
      expect(raw.failureMode).toBe("failOpen");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores unknown top-level keys (recipes catalog)", () => {
    const cfg = validateGateways({ servers: [], recipes: [{ id: "x" }], note: "hi" });
    expect(cfg.servers).toEqual([]);
  });
});

describe("gateways.json file handling", () => {
  it("scaffold writes an empty servers list plus the recipe catalog, idempotently", () => {
    const home = tmp();
    try {
      const first = scaffoldGateways(env(home));
      expect(first.created).toBe(true);
      const raw = JSON.parse(readFileSync(first.path, "utf8")) as {
        servers: unknown[];
        recipes: { id: string; note: string }[];
      };
      expect(raw.servers).toEqual([]);
      expect(raw.recipes.length).toBeGreaterThanOrEqual(20);
      const ids = raw.recipes.map((r) => r.id);
      for (const id of ["playwright", "github", "slack", "postgresql", "filesystem"]) {
        expect(ids).toContain(id);
      }
      expect(raw.recipes.every((r) => typeof r.note === "string")).toBe(true);

      const second = scaffoldGateways(env(home));
      expect(second.created).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("readGateways tolerates a missing file and rejects broken JSON", () => {
    const home = tmp();
    try {
      expect(readGateways(env(home)).servers).toEqual([]);
      const path = gatewaysPath(env(home));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{not json", "utf8");
      expect(() => readGateways(env(home))).toThrow(/not valid JSON/);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
