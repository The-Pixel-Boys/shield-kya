import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/parse-args.js";
import { runSandboxCommand } from "../src/commands/sandbox.js";
import { createMockDriver } from "../src/sandbox/mock-driver.js";
import { assertSandboxId } from "../src/sandbox/id.js";
import {
  killSandbox,
  loadSandboxState,
  spawnSandbox,
} from "../src/sandbox/runtime.js";
import { evaluateOffline } from "../src/offline-evaluate.js";

describe("sandbox wrap", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("spawn records a running id and kill removes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "kya-sbx-"));
    dirs.push(root);
    const driver = createMockDriver();
    const row = await spawnSandbox({ root, driver });
    expect(row.status).toBe("running");
    expect(driver.live.has(row.sandboxId)).toBe(true);
    expect(loadSandboxState(root)).toHaveLength(1);

    await killSandbox({ root, driver, sandboxId: row.sandboxId });
    expect(driver.live.has(row.sandboxId)).toBe(false);
    expect(loadSandboxState(root)[0]?.status).toBe("killed");
  });

  it("policy DENY without sandboxId before exec", () => {
    const d = evaluateOffline({
      toolId: "org.sample.sandbox.exec",
      irreversible: true,
      env: { host: "runtime" },
    });
    expect(d.reasonCode).toBe("MISSING_SANDBOX_ID");
  });

  it("rejects pkill-shaped sandbox ids", () => {
    expect(() => assertSandboxId(".")).toThrow(/sbx-<uuid>/);
    expect(() => assertSandboxId(".*")).toThrow(/sbx-<uuid>/);
    expect(() => assertSandboxId("firecracker")).toThrow(/sbx-<uuid>/);
  });

  it("CLI spawn does not create a VM when policy is REQUIRE_APPROVE", async () => {
    const root = mkdtempSync(join(tmpdir(), "kya-sbx-cli-"));
    dirs.push(root);
    const prev = process.cwd();
    process.chdir(root);
    process.env.KYA_SANDBOX = "mock";
    delete process.env.KYA_API_KEY;
    try {
      const code = await runSandboxCommand(parseArgs(["sandbox", "spawn"]));
      expect(code).toBe(4);
      expect(loadSandboxState(root)).toEqual([]);
    } finally {
      process.chdir(prev);
      delete process.env.KYA_SANDBOX;
    }
  });
});
