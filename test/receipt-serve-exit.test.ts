/**
 * The internal `receipt-serve` daemon must end its process once its server has closed (idle, folder gone,
 * memory ceiling, signal). Without this, a running search warm-up kept it alive with no state file, so
 * `kya stop` could not find it and the next `kya start` ran a second daemon beside it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/commands/receipt-serve.js", () => ({ runReceiptServe: async () => undefined }));

const { runCli, hostedExitPending } = await import("../src/cli.js");

describe("kya receipt-serve exit", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("asks the CLI entry to exit the process once the server has closed", async () => {
    const home = mkdtempSync(join(tmpdir(), "kya-serve-exit-"));
    dirs.push(home);
    expect(hostedExitPending()).toBe(false);
    const code = await runCli(
      ["receipt-serve", "--days", "1"],
      { log: () => undefined, error: () => undefined, exit: () => undefined },
      { HOME: home, KYA_HOME: home, KYA_OFFLINE: "1", KYA_SKIP_NODE_CHECK: "1", KYA_NO_BROWSER: "1" },
      home,
    );
    expect(code).toBe(0);
    expect(hostedExitPending()).toBe(true);
  });
});
