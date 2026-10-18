/**
 * Cline README-only setup (llms-install.md): the doc's one JSON block, filled in the way its step 2
 * says, must start a working MCP server (3 tools, one evaluate, one trail row). Runs the same
 * checkServer() as scripts/cline-install-check.mjs, here against the local build laid out like a
 * global npm install. Cline itself is not run. Needs `tsc` first.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no type declarations
import { checkServer, serverFromInstallDoc, TOOLS } from "../scripts/cline-install-check.mjs";

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const doc = read("llms-install.md");
const haveDist = existsSync(join(root, "dist/cli.js"));
const tmp = () => mkdtempSync(join(tmpdir(), "kya-cline-"));

describe("llms-install.md", () => {
  it("one JSON block: offline, keyless, absolute node + cli.js, empty autoApprove", () => {
    const s = serverFromInstallDoc(doc, "/abs/node", "/abs/root/@shield-agent/kya/dist/cli.js");
    expect(s).toEqual({
      command: "/abs/node",
      args: ["/abs/root/@shield-agent/kya/dist/cli.js", "serve-mcp", "--stdio"],
      env: { KYA_OFFLINE: "1", KYA_HOST: "ide", KYA_SESSION_ID: "mcp:cline" },
      disabled: false,
      autoApprove: [],
    });
  });

  it("names the install command, both path commands, the Node floor and every tool", () => {
    expect(doc).toContain("npm install -g @shield-agent/kya@latest");
    expect(doc).toContain('node -p "process.execPath"');
    expect(doc).toContain("npm root -g");
    expect(doc).toContain("/@shield-agent/kya/dist/cli.js");
    expect(doc).toContain(`Node.js ${JSON.parse(read("package.json")).engines.node.replace(">=", "")} or later`);
    for (const t of TOOLS) expect(doc).toContain(t);
  });

  it("README points Cline users at it with the global install line", () => {
    const readme = read("README.md");
    expect(readme).toContain("[`llms-install.md`](llms-install.md)");
    expect(readme).toMatch(/npm install -g @shield-agent\/kya@latest/);
  });

  it("no long dashes, no enforcement or fail-closed claim", () => {
    expect(doc).not.toMatch(/[\u2013\u2014]/);
    expect(doc).not.toMatch(/\benforc|fail[- ]closed|guarantee/i);
  });

  it.skipIf(!haveDist)("the filled-in config starts serve-mcp: 3 tools, evaluate answers, one trail row", { timeout: 30000 }, async () => {
    const npmRoot = tmp(); // what `npm root -g` prints after a global install
    mkdirSync(join(npmRoot, "@shield-agent"), { recursive: true });
    symlinkSync(root, join(npmRoot, "@shield-agent/kya"));
    const server = serverFromInstallDoc(doc, process.execPath, join(npmRoot, "@shield-agent/kya/dist/cli.js"));
    const r = await checkServer(server, tmp(), tmp());
    expect(r.init.result.serverInfo.name).toBe("shield-kya");
    expect(r.tools).toEqual(TOOLS);
    expect(r.evaluate.error).toBeUndefined();
    expect(r.evaluate.result.isError).not.toBe(true);
    expect(r.rows.filter((row: { toolId: string }) => row.toolId === "org.sample.data.write")).toHaveLength(1);
  });
});
