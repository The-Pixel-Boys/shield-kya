import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUpgradeScript,
  currentNodeMajor,
  detectNodeManager,
  ensureSupportedNode,
  nodeSatisfied,
  REQUIRED_NODE_MAJOR,
} from "../src/node-upgrade.js";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

function fakeIo(over: {
  isTty?: boolean;
  confirm?: (q: string) => Promise<boolean>;
}) {
  const errors: string[] = [];
  return {
    errors,
    io: {
      error: (m: string) => errors.push(m),
      isTty: over.isTty,
      confirm: over.confirm,
    },
  };
}

describe("node version gate", () => {
  it("parses major versions", () => {
    expect(currentNodeMajor("v22.22.2")).toBe(22);
    expect(currentNodeMajor("v24.0.0")).toBe(24);
    expect(nodeSatisfied("v22.22.2")).toBe(false);
    expect(nodeSatisfied("v24.1.0")).toBe(true);
  });

  it("REQUIRED_NODE_MAJOR matches package.json engines", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${REQUIRED_NODE_MAJOR}`);
  });

  it("detects managers in priority order", () => {
    const no = () => false;
    const env = { HOME: "/home/x" } as NodeJS.ProcessEnv;
    expect(
      detectNodeManager(env, {
        hasCmd: (c) => c === "fnm" || c === "volta",
        hasFile: no,
        platform: "linux",
      }),
    ).toBe("volta");
    expect(
      detectNodeManager(env, { hasCmd: (c) => c === "fnm", hasFile: no, platform: "linux" }),
    ).toBe("fnm");
    expect(
      detectNodeManager(env, {
        hasCmd: no,
        hasFile: (p) => p === "/home/x/.nvm/nvm.sh",
        platform: "darwin",
      }),
    ).toBe("nvm");
    expect(
      detectNodeManager(env, { hasCmd: (c) => c === "brew", hasFile: no, platform: "darwin" }),
    ).toBe("brew");
    expect(
      detectNodeManager(env, { hasCmd: no, hasFile: no, platform: "linux" }),
    ).toBeUndefined();
    // nvm.sh / brew are POSIX-only
    expect(
      detectNodeManager(env, {
        hasCmd: no,
        hasFile: () => true,
        platform: "win32",
      }),
    ).toBeUndefined();
  });

  it("builds an upgrade script that reinstalls and re-runs the command", () => {
    const env = { HOME: "/home/x" } as NodeJS.ProcessEnv;
    const nvm = buildUpgradeScript("nvm", env, ["start"]);
    expect(nvm.shell).toBe("bash");
    expect(nvm.args[1]).toContain("nvm install 24");
    expect(nvm.args[1]).toContain("npm i -g @shield-agent/kya@latest");
    // start is re-run with --force so MCP blocks point at the new node
    expect(nvm.args[1]).toContain("KYA_NODE_CHECKED=1 kya start --force");

    const volta = buildUpgradeScript("volta", env, ["connect", "qwen"]);
    expect(volta.args[1]).toContain("volta install node@24");
    expect(volta.args[1]).toContain("kya connect qwen");
    expect(volta.args[1]).not.toContain("--force");
  });

  it("does nothing when the version is satisfied", async () => {
    const { io, errors } = fakeIo({ isTty: true });
    const out = await ensureSupportedNode(io, {}, ["start"], "start", {
      version: "v24.0.0",
    });
    expect(out).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("skips internal/protocol commands and env escape hatches", async () => {
    const { io } = fakeIo({ isTty: true });
    const deps = { version: "v22.0.0" };
    expect(await ensureSupportedNode(io, {}, ["serve-mcp"], "serve-mcp", deps)).toBeUndefined();
    expect(
      await ensureSupportedNode(io, {}, ["receipt-serve"], "receipt-serve", deps),
    ).toBeUndefined();
    expect(
      await ensureSupportedNode(io, { KYA_SKIP_NODE_CHECK: "1" }, ["start"], "start", deps),
    ).toBeUndefined();
    expect(
      await ensureSupportedNode(io, { KYA_NODE_CHECKED: "1" }, ["start"], "start", deps),
    ).toBeUndefined();
  });

  it("warns and continues on non-TTY instead of prompting", async () => {
    const { io, errors } = fakeIo({ isTty: false });
    const out = await ensureSupportedNode(io, {}, ["start"], "start", {
      version: "v22.22.2",
    });
    expect(out).toBeUndefined();
    expect(errors.join("\n")).toContain("Node.js 24+");
  });

  it("decline continues with a warning", async () => {
    const { io, errors } = fakeIo({ isTty: true, confirm: async () => false });
    const out = await ensureSupportedNode(io, {}, ["start"], "start", {
      version: "v22.22.2",
      hasCmd: () => false,
      hasFile: () => false,
    });
    expect(out).toBeUndefined();
    expect(errors.join("\n")).toContain("unsupported Node");
  });

  it("accept with a manager runs the upgrade and hands off its exit code", async () => {
    const asked: string[] = [];
    const ran: string[][] = [];
    const { io } = fakeIo({
      isTty: true,
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
    });
    const out = await ensureSupportedNode(io, {}, ["start"], "start", {
      version: "v22.22.2",
      hasCmd: (c) => c === "volta",
      hasFile: () => false,
      run: async (shell, args) => {
        ran.push([shell, ...args]);
        return 0;
      },
    });
    expect(out).toBe(0);
    expect(asked[0]).toContain("via volta");
    expect(ran[0][0]).toBe("bash");
    expect(ran[0].join(" ")).toContain("volta install node@24");
  });

  it("accept without a manager just continues", async () => {
    const { io } = fakeIo({ isTty: true, confirm: async () => true });
    const out = await ensureSupportedNode(io, {}, ["start"], "start", {
      version: "v22.22.2",
      hasCmd: () => false,
      hasFile: () => false,
    });
    expect(out).toBeUndefined();
  });
});
