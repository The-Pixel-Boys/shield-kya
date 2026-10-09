import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DESTRUCTIVE_PATTERN,
  LOOPBACK_RULE,
  celAllowRule,
  denyPatternsFor,
  generateGatewayYaml,
  unmatchedAllowed,
} from "../src/gate/config-gen.js";
import type { GatewayServer } from "../src/gate/config.js";

const GOLDEN_DIR = fileURLToPath(new URL("./golden", import.meta.url));

function golden(name: string, actual: string): void {
  const path = `${GOLDEN_DIR}/${name}`;
  if (process.env.KYA_UPDATE_GOLDEN === "1") {
    writeFileSync(path, actual, "utf8");
  }
  expect(existsSync(path), `missing golden ${name} (run KYA_UPDATE_GOLDEN=1 pnpm test)`).toBe(true);
  expect(actual).toBe(readFileSync(path, "utf8"));
}

const stdio = (id: string, cmd: string[]): GatewayServer => ({
  id,
  transport: "stdio",
  cmd,
});

describe("CEL generation from the MCP server registry", () => {
  it("destructive-name family is word-boundary anchored and always in the deny set", () => {
    for (const id of ["github", "postgresql", "playwright", "context7", "totally-unknown"]) {
      expect(denyPatternsFor(id)[0]).toBe(DESTRUCTIVE_PATTERN);
    }
    const re = new RegExp(DESTRUCTIVE_PATTERN);
    // denied
    for (const tool of ["drop_table", "truncate_all", "purge_cache", "transfer_repo", "do_drop_x"]) {
      expect(re.test(tool), tool).toBe(true);
    }
    // NOT denied: the family must not over-match lookalike names
    for (const tool of ["dropdown_select", "droplet_info", "drops", "transferable_list", "purgeable_get"]) {
      expect(re.test(tool), tool).toBe(false);
    }
  });

  it("dedupes the alternation", () => {
    const patterns = denyPatternsFor("github");
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("joins the server's ADMIN registry patterns into the deny set", () => {
    const gh = denyPatternsFor("github");
    expect(gh.length).toBeGreaterThan(1);
    expect(gh.join("|")).toContain("delete_");
    // context7 has no ADMIN rules - destructive family only
    expect(denyPatternsFor("context7")).toEqual([DESTRUCTIVE_PATTERN]);
  });

  it("unmatched tools follow the server's defaultTier (READ/WRITE allow)", () => {
    expect(unmatchedAllowed("github")).toBe(true); // defaultTier WRITE → observed allow
    expect(unmatchedAllowed("context7")).toBe(true); // defaultTier READ → allow
    expect(unmatchedAllowed("unknown-server")).toBe(true); // observe gateway: allow, audited
  });

  it("rule shape: target match AND NOT matches(deny) - destructive deny always wins", () => {
    const rule = celAllowRule(stdio("github", ["npx", "gh-mcp"]));
    expect(rule).toMatch(/^mcp\.tool\.target == 'github' && !mcp\.tool\.name\.matches\('/);
    expect(rule).toContain("drop|truncate|purge|transfer");
    // OR-allow semantics: a denied name matches no allow rule → gateway denies it.
  });

  it("escapes single quotes in CEL string literals", () => {
    const rule = celAllowRule(stdio("github", ["npx"]));
    expect(rule).not.toContain("''");
  });
});

describe("listener hardening (#1)", () => {
  const cfg = {
    port: 3930,
    otlpPort: 3931,
    failureMode: "failOpen" as const,
    servers: [stdio("context7", ["npx", "ctx"])],
  };

  it("emits a loopback-only L4 allowlist for the wildcard-bound listener", () => {
    const yaml = generateGatewayYaml(cfg);
    expect(yaml).toContain("networkAuthorization:");
    expect(yaml).toContain(`- allow: ${JSON.stringify(LOOPBACK_RULE)}`);
    expect(LOOPBACK_RULE).toContain("127.0.0.0/8");
    expect(LOOPBACK_RULE).toContain("::1");
  });

  it("turns the stats/readiness/admin listeners off and quiets logging", () => {
    const yaml = generateGatewayYaml(cfg);
    expect(yaml).toContain('statsAddr: "off"');
    expect(yaml).toContain('readinessAddr: "off"');
    expect(yaml).toContain('adminAddr: "off"');
    expect(yaml).toContain('level: "warn"');
  });
});

describe("target emission", () => {
  it("failureMode comes from gateways.json", () => {
    expect(
      generateGatewayYaml({ port: 1, otlpPort: 2, failureMode: "failClosed", servers: [] }),
    ).toContain('failureMode: "failClosed"');
  });

  it("http targets emit headers as requestHeaderModifier transport policy", () => {
    const yaml = generateGatewayYaml({
      port: 3930,
      otlpPort: 3931,
      failureMode: "failOpen",
      servers: [
        { id: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { authorization: "Bearer x" } },
      ],
    });
    expect(yaml).toContain("requestHeaderModifier:");
    expect(yaml).toContain('"authorization": "Bearer x"');
  });
});

describe("generateGatewayYaml goldens", () => {
  it("three representative servers (stdio+env, http, read-only default)", () => {
    const yaml = generateGatewayYaml({
      port: 3930,
      otlpPort: 3931,
      failureMode: "failOpen",
      servers: [
        {
          id: "github",
          transport: "stdio",
          cmd: ["npx", "-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "<pat>" },
        },
        { id: "exa", transport: "http", url: "https://mcp.exa.ai/mcp" },
        stdio("context7", ["npx", "-y", "@upstash/context7-mcp"]),
      ],
    });
    golden("gate-config-3-servers.yaml", yaml);
  });

  it("postgres with destructive-heavy taxonomy", () => {
    const yaml = generateGatewayYaml({
      port: 3930,
      otlpPort: 3931,
      failureMode: "failOpen",
      servers: [
        stdio("postgresql", ["npx", "-y", "@modelcontextprotocol/server-postgres", "postgresql://db"]),
      ],
    });
    golden("gate-config-postgres.yaml", yaml);
  });

  it("empty server list emits an explicit empty targets array", () => {
    const yaml = generateGatewayYaml({ port: 3930, otlpPort: 3931, failureMode: "failOpen", servers: [] });
    expect(yaml).toContain("targets: []");
    expect(yaml).not.toContain("mcpAuthorization");
  });

  it("wires tracing to the local OTLP receiver and loopback listener", () => {
    const yaml = generateGatewayYaml({
      port: 4000,
      otlpPort: 4001,
      failureMode: "failOpen",
      servers: [stdio("context7", ["npx", "ctx"])],
    });
    expect(yaml).toContain('otlpEndpoint: "http://127.0.0.1:4001"');
    expect(yaml).toContain('otlpProtocol: "http"');
    expect(yaml).toContain("- port: 4000");
  });
});
