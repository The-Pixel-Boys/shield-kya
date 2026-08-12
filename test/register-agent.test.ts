import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KyaHttpClient } from "../src/client.js";
import {
  registerAgentInputFromArgs,
  runRegisterAgent,
} from "../src/commands/register-agent.js";
import { resolveConfig } from "../src/config.js";
import { parseArgs } from "../src/parse-args.js";
import { UsageError } from "../src/errors.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("register-agent", () => {
  it("parses --name and --version-hash", () => {
    const p = parseArgs([
      "register-agent",
      "--name",
      "solo-builder",
      "--version-hash",
      "dev-abc",
    ]);
    expect(registerAgentInputFromArgs(p)).toEqual({
      name: "solo-builder",
      versionHash: "dev-abc",
    });
  });

  it("requires --name", () => {
    expect(() =>
      registerAgentInputFromArgs(parseArgs(["register-agent"])),
    ).toThrow(UsageError);
  });

  it("registers via HTTP mock and writes agentId to config", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kya-reg-"));
    dirs.push(cwd);

    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          name: "solo-builder",
          status: "ACTIVE",
          versionHash: "dev-local",
        }),
        { status: 201 },
      ),
    ) as unknown as typeof fetch;

    const config = resolveConfig({
      cwd,
      env: {
        KYA_BASE_URL: "http://127.0.0.1:8090",
        KYA_API_KEY: "sk_test",
        KYA_HOST: "ide",
      },
      requireApiKey: true,
    });
    const client = new KyaHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fetch: fetchImpl,
    });

    const result = await runRegisterAgent(
      config,
      { name: "solo-builder", versionHash: "dev-local" },
      client,
    );
    expect(result.agentId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const file = JSON.parse(
      readFileSync(join(cwd, ".kya", "config.json"), "utf8"),
    );
    expect(file.agentId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(file.agentName).toBe("solo-builder");
  });
});
