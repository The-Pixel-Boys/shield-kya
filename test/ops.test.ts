import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/parse-args.js";
import {
  formatAgentTable,
  formatApprovalTable,
  formatSessionTable,
  requireId,
  shrinkToFromArgs,
} from "../src/commands/ops.js";
import { runCli, type CliIo } from "../src/cli.js";
import { UsageError } from "../src/errors.js";

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    exit: () => undefined,
  };
  return { io, logs, errors };
}

describe("ops parsers", () => {
  it("requireId reads --id or positional", () => {
    expect(requireId(parseArgs(["kill", "--id", "abc"]), "kill")).toBe("abc");
    expect(requireId(parseArgs(["kill", "def"]), "kill")).toBe("def");
  });

  it("requireId throws without id", () => {
    expect(() => requireId(parseArgs(["kill"]), "kill")).toThrow(UsageError);
  });

  it("shrink --to accepts BUILD READ DEPLOY and defaults BUILD", () => {
    expect(shrinkToFromArgs(parseArgs(["shrink", "--id", "x", "--to", "build"]))).toBe(
      "BUILD",
    );
    expect(shrinkToFromArgs(parseArgs(["shrink", "--id", "x", "--to", "READ"]))).toBe(
      "READ",
    );
    expect(shrinkToFromArgs(parseArgs(["shrink", "--id", "x"]))).toBe("BUILD");
  });

  it("shrink --to rejects junk", () => {
    expect(() =>
      shrinkToFromArgs(parseArgs(["shrink", "--id", "x", "--to", "NOPE"])),
    ).toThrow(/BUILD/);
  });

  it("tables stay readable when empty", () => {
    expect(formatAgentTable([])).toBe("no agents");
    expect(formatApprovalTable([])).toBe("no approvals");
    expect(formatSessionTable([])).toBe("no sessions");
  });

  it("tables print status first", () => {
    expect(
      formatAgentTable([{ id: "a1", name: "solo", status: "ACTIVE" }]),
    ).toMatch(/ACTIVE\s+a1\s+solo/);
    expect(
      formatApprovalTable([{ id: "t1", status: "PENDING", action: "org.sample.data.write" }]),
    ).toMatch(/PENDING\s+t1/);
    expect(
      formatSessionTable([
        { id: "s1", sessionId: "ext", riskLevel: "LOW", host: "ide", clearance: "BUILD" },
      ]),
    ).toMatch(/BUILD\s+LOW\s+s1/);
  });
});

describe("desk verbs fail closed", () => {
  const env = { KYA_BASE_URL: "http://127.0.0.1:8093", KYA_API_KEY: "" };

  it.each([
    ["agents"],
    ["approvals"],
    ["sessions"],
    ["kill", "--id", "00000000-0000-0000-0000-000000000001"],
    ["shrink", "--id", "00000000-0000-0000-0000-000000000001", "--to", "BUILD"],
  ])("empty key: %s", async (...args: string[]) => {
    const { io, errors } = captureIo();
    const code = await runCli(args, io, env, process.cwd());
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toMatch(/KYA_API_KEY|AUTH|required|api key/i);
  });

  it("kill without --id is usage, not a plane hit", async () => {
    const { io, errors } = captureIo();
    const code = await runCli(["kill"], io, { KYA_API_KEY: "sk_live_x" }, process.cwd());
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toMatch(/--id/);
  });

  it("shrink --to NOPE is usage", async () => {
    const { io, errors } = captureIo();
    const code = await runCli(
      ["shrink", "--id", "x", "--to", "NOPE"],
      io,
      { KYA_API_KEY: "sk_live_x" },
      process.cwd(),
    );
    expect(code).not.toBe(0);
    expect(errors.join("\n")).toMatch(/BUILD|READ|DEPLOY|--to/);
  });
});
