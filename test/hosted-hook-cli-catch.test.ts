/**
 * LOW-6 (review r3 of #388): an error escaping runHook in hosted mode follows the crash
 * decision (deny, exit 2; shadow with a harmless tool exits 0), never runCli's generic exit 1.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/commands/hook.js", () => ({
  runHook: async () => { throw new Error("escaped"); },
}));

const { runCli, hostedExitPending } = await import("../src/cli.js");
const { hostedDecision } = await import("../src/commands/hosted-hook.js");

describe("runCli hook catch in hosted mode", () => {
  const tty = process.stdin.isTTY;
  afterEach(() => { (process.stdin as { isTTY?: boolean }).isTTY = tty; });

  const run = async (argv: string[]) => {
    (process.stdin as { isTTY?: boolean }).isTTY = true; // do not wait on stdin
    const errs: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await runCli(argv, { log: () => undefined, error: (m) => errs.push(m), exit: () => undefined }, { HOME: "/nonexistent-test-home", KYA_HOME: "/nonexistent-test-home" }, "/");
      return { code, errs: errs.join(""), out: write.mock.calls.map((c) => String(c[0])).join("") };
    } finally {
      write.mockRestore();
    }
  };

  it("hosted: exit 2 with the deny JSON", async () => {
    hostedDecision.neverList = "clear";
    const r = await run(["hook", "--host", "claude", "--plane-config", "/x/hosted.json"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('"permissionDecision":"deny"');
  });

  it("shadow: harmless tool exits 0, unknown payload exits 2", async () => {
    hostedDecision.neverList = "clear";
    expect((await run(["hook", "--host", "claude", "--plane-config", "/x/hosted.json", "--plane-shadow"])).code).toBe(0);
    // Shadow also exits explicitly after the catch (no lingering handle).
    expect(hostedExitPending()).toBe(true);
    hostedDecision.neverList = "unknown";
    expect((await run(["hook", "--host", "claude", "--plane-config", "/x/hosted.json", "--plane-shadow"])).code).toBe(2);
  });

  it("OSS mode (no --plane-config) keeps the generic error path", async () => {
    expect((await run(["hook", "--host", "claude"])).code).toBe(1);
  });
});
