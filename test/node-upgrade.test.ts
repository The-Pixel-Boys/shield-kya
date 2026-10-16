import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildUpgradeScript,
  currentNodeMajor,
  detectNodeManager,
  ensureSupportedNode,
  findInstalledNode,
  nodeFloorWarning,
  nodeSatisfied,
  RECOMMENDED_NODE_MAJOR,
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
    expect(nodeSatisfied("v20.20.2")).toBe(false);
    expect(nodeSatisfied("v21.7.3")).toBe(false);
    expect(nodeSatisfied("v22.0.0")).toBe(true);
    expect(nodeSatisfied("v24.1.0")).toBe(true);
  });

  it("REQUIRED_NODE_MAJOR matches package.json engines", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${REQUIRED_NODE_MAJOR}`);
    // The Claude Desktop extension (.mcpb) declares the same floor.
    const mcpb = JSON.parse(readFileSync(join(pkgRoot, "manifest.json"), "utf8")) as {
      compatibility: { runtimes: { node: string } };
    };
    expect(mcpb.compatibility.runtimes.node).toBe(`>=${REQUIRED_NODE_MAJOR}.0.0`);
  });

  it("floor thresholds: 22+ silent, 20/21 unsupported-but-works, below 20 unsupported", () => {
    expect(REQUIRED_NODE_MAJOR).toBe(22);
    expect(RECOMMENDED_NODE_MAJOR).toBe(24);
    for (const v of ["v22.0.0", "v22.23.3", "v23.11.1", "v24.21.0", "v26.1.0"]) {
      expect(nodeFloorWarning(v), v).toBeUndefined();
    }
    for (const v of ["v20.0.0", "v20.20.2", "v21.7.3"]) {
      const w = nodeFloorWarning(v)!;
      expect(w).toBe(`KYA supports Node.js 22+ (24 recommended); ${v} is unsupported but works.`);
      expect(w).not.toContain("\n");
    }
    for (const v of ["v18.20.8", "v19.9.0", "v16.20.2"]) {
      const w = nodeFloorWarning(v)!;
      expect(w).toContain(`does not support Node.js ${v}`);
      expect(w).toContain("Install Node.js 22+");
      expect(w).not.toMatch(/works/);
    }
  });

  it("non-TTY run: 22/23/24 print nothing, 21/20/18 print exactly one line, hook, serve-mcp and receipt-serve print nothing on any", async () => {
    for (const v of ["v22.0.0", "v23.11.1", "v24.21.0"]) {
      const { io, errors } = fakeIo({ isTty: false });
      expect(await ensureSupportedNode(io, {}, ["start"], "start", { version: v, hasCmd: () => false, hasFile: () => false })).toBeUndefined();
      expect(errors, v).toEqual([]);
    }
    for (const v of ["v21.7.3", "v20.20.2", "v18.20.8"]) {
      const { io, errors } = fakeIo({ isTty: false });
      expect(await ensureSupportedNode(io, {}, ["receipt"], "receipt", { version: v, hasCmd: () => false, hasFile: () => false })).toBeUndefined();
      expect(errors, v).toHaveLength(1);
      expect(errors[0], v).toContain(v);
    }
    for (const cmd of ["hook", "serve-mcp", "receipt-serve"]) {
      for (const v of ["v18.20.8", "v20.20.2", "v21.7.3", "v22.0.0", "v24.21.0"]) {
        for (const isTty of [false, true]) {
          const { io, errors } = fakeIo({ isTty, confirm: async () => { throw new Error(`${cmd} must never prompt`); } });
          const run = async () => { throw new Error(`${cmd} must never re-exec`); };
          const deps = { version: v, hasCmd: (c: string) => c === "volta", hasFile: () => true, readdir: () => ["24.21.0"], run };
          expect(await ensureSupportedNode(io, { HOME: "/home/x" }, [cmd], cmd, deps)).toBeUndefined();
          expect(errors, `${cmd} ${v} tty=${isTty}`).toEqual([]);
        }
      }
    }
  });

  // The monorepo CI step that backs the Node 22 support claim (absent in the public mirror).
  const ciFile = join(pkgRoot, "../../.woodpecker/ci-kya.yml");
  it.skipIf(!existsSync(ciFile))("CI kya-node22: hash checked before extract, floor 22.0.0 smoked, suite on Node 22 first on PATH", () => {
    const text = readFileSync(ciFile, "utf8");
    const step = text.slice(text.indexOf("- name: kya-node22"), text.indexOf("- name: kya-gate-e2e"));
    expect(step).toMatch(/echo "\$2  \$T\/\$1\.tar\.gz" \| sha256sum -c -\n\s+tar -xzf "\$T\/\$1\.tar\.gz"/);
    expect(step).toContain(`NODE22_FLOOR=v${REQUIRED_NODE_MAJOR}.0.0`);
    expect(step).toContain('fetch "$NODE22" "$sum22"');
    expect(step).toContain('fetch "$NODE22_FLOOR" "$sumfloor"');
    expect(step).toContain('smoke "$T/node-$NODE22_FLOOR-linux-$arch/bin" "$NODE22_FLOOR"');
    expect(step).toMatch(/test "\$proxy" -eq 9/);
    expect(new Set(step.match(/\b[0-9a-f]{64}\b/g)).size).toBe(4);
    expect(step).toMatch(
      /export PATH="\$T\/node-\$NODE22-linux-\$arch\/bin:\$PATH"\n\s+test "\$\(node --version\)" = "\$NODE22"\n\s+node node_modules\/vitest\/vitest\.mjs run/,
    );
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
    const deps = { version: "v20.20.2" };
    expect(await ensureSupportedNode(io, {}, ["serve-mcp"], "serve-mcp", deps)).toBeUndefined();
    // hook runs on every tool call: never re-exec or warn (measured +180 ms per call).
    const quiet = fakeIo({ isTty: false });
    expect(await ensureSupportedNode(quiet.io, {}, ["hook"], "hook", deps)).toBeUndefined();
    expect(quiet.errors).toEqual([]);
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
      version: "v20.20.2",
    });
    expect(out).toBeUndefined();
    expect(errors).toEqual([
      "KYA supports Node.js 22+ (24 recommended); v20.20.2 is unsupported but works. Continuing.",
    ]);
  });

  it("decline continues with a warning", async () => {
    const { io, errors } = fakeIo({ isTty: true, confirm: async () => false });
    const out = await ensureSupportedNode(io, {}, ["start"], "start", {
      version: "v18.20.8",
      hasCmd: () => false,
      hasFile: () => false,
    });
    expect(out).toBeUndefined();
    expect(errors.join("\n")).toContain("Continuing on unsupported Node v18.20.8");
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
      version: "v20.20.2",
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

  it("TTY without a manager: 20/21 warn once and never prompt; below 20 still asks", async () => {
    for (const v of ["v20.20.2", "v21.7.3"]) {
      const { io, errors } = fakeIo({ isTty: true, confirm: async () => { throw new Error("must not prompt"); } });
      expect(await ensureSupportedNode(io, {}, ["start"], "start", { version: v, hasCmd: () => false, hasFile: () => false })).toBeUndefined();
      expect(errors).toEqual([`KYA supports Node.js 22+ (24 recommended); ${v} is unsupported but works. Continuing.`]);
    }
    const asked: string[] = [];
    const { io } = fakeIo({ isTty: true, confirm: async (q) => { asked.push(q); return true; } });
    await ensureSupportedNode(io, {}, ["start"], "start", { version: "v18.20.8", hasCmd: () => false, hasFile: () => false });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("does not support Node.js v18.20.8");
  });

  it("accept without a manager just continues", async () => {
    const { io } = fakeIo({ isTty: true, confirm: async () => true });
    const out = await ensureSupportedNode(io, {}, ["start"], "start", {
      version: "v18.20.8",
      hasCmd: () => false,
      hasFile: () => false,
    });
    expect(out).toBeUndefined();
  });

  it("findInstalledNode picks the newest satisfying version", () => {
    const env = { HOME: "/home/x" } as NodeJS.ProcessEnv;
    const readdir = () => ["v18.20.0", "v20.20.2", "v22.22.2", "v24.9.0", "v24.21.0", "not-a-version"];
    expect(findInstalledNode("nvm", env, { readdir })).toBe("v24.21.0");
    // volta layout has no v prefix
    expect(findInstalledNode("volta", env, { readdir: () => ["22.22.2", "24.1.0"] })).toBe(
      "v24.1.0",
    );
    expect(findInstalledNode("nvm", env, { readdir: () => ["v22.22.2"] })).toBe("v22.22.2");
    expect(findInstalledNode("nvm", env, { readdir: () => ["v20.20.2", "v21.7.3"] })).toBeUndefined();
    expect(findInstalledNode("brew", env, { readdir })).toBeUndefined();
  });

  it("already-installed node: re-execs the command under the compliant runtime", async () => {
    let asked = 0;
    const ran: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const { io, errors } = fakeIo({
      isTty: true,
      confirm: async () => {
        asked += 1;
        return true;
      },
    });
    const out = await ensureSupportedNode(io, { HOME: "/home/x" }, ["start"], "start", {
      version: "v20.20.2",
      hasCmd: (c) => c === "volta",
      hasFile: () => true, // installed binary exists on disk
      readdir: () => ["24.21.0"],
      cliJs: "/pkg/dist/cli.js",
      run: async (cmd, args, env) => {
        ran.push({ cmd, args, env });
        return 0;
      },
    });
    expect(out).toBe(0);
    expect(asked).toBe(0);
    expect(ran[0]!.cmd).toBe("/home/x/.volta/tools/image/node/24.21.0/bin/node");
    expect(ran[0]!.args).toEqual(["/pkg/dist/cli.js", "start"]);
    expect(ran[0]!.env.KYA_NODE_CHECKED).toBe("1");
    expect(ran[0]!.env.KYA_NODE_REEXEC).toBe("1");
    expect(errors.join("\n")).toContain("Running under Node v24.21.0");
  });

  it("re-exec is loop-safe via KYA_NODE_REEXEC", async () => {
    const { io } = fakeIo({ isTty: true });
    const out = await ensureSupportedNode(
      io,
      { HOME: "/home/x", KYA_NODE_REEXEC: "1" },
      ["start"],
      "start",
      {
        version: "v20.20.2",
        hasCmd: (c) => c === "volta",
        hasFile: () => true,
        readdir: () => ["24.21.0"],
        run: async () => 99,
      },
    );
    // Loop guard: falls through to the shadow message, never re-execs.
    expect(out).toBeUndefined();
  });

  it("already-installed but binary missing: explains the PATH shadow instead", async () => {
    let asked = 0;
    const { io, errors } = fakeIo({
      isTty: true,
      confirm: async () => {
        asked += 1;
        return true;
      },
    });
    const out = await ensureSupportedNode(io, { HOME: "/home/x" }, ["start"], "start", {
      version: "v20.20.2",
      hasCmd: (c) => c === "volta",
      hasFile: () => false,
      readdir: () => ["24.21.0"],
      firstNodeOnPath: () => "/opt/homebrew/bin/node",
    });
    expect(out).toBeUndefined();
    expect(asked).toBe(0);
    const msg = errors.join("\n");
    expect(msg).toContain("v24.21.0 is already installed via volta");
    expect(msg).toContain("/opt/homebrew/bin/node");
    expect(msg).toContain("volta install node@24.21.0");
  });

  it("successful upgrade ends with a new-terminal note", async () => {
    const { io, errors } = fakeIo({ isTty: true, confirm: async () => true });
    const out = await ensureSupportedNode(io, {}, ["start"], "start", {
      version: "v20.20.2",
      hasCmd: (c) => c === "volta",
      hasFile: () => false,
      readdir: () => [],
      run: async () => 0,
    });
    expect(out).toBe(0);
    expect(errors.join("\n")).toContain("open a new terminal");
  });
});
