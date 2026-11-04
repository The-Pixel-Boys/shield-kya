import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { maybeOfferSemanticSearch, type SemanticSetupIo } from "../src/receipt/semantic-setup.js";
import { semanticRuntimeInstalled } from "../src/receipt/semantic-status.js";
import { installFakeRuntime } from "./support/fake-fastembed.js";

function harness(over: Partial<SemanticSetupIo> = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  let installs = 0;
  const io: SemanticSetupIo = {
    error: (m) => lines.push(m),
    isTty: true,
    ask: async (q) => {
      asked.push(q);
      return "";
    },
    install: async (env) => {
      installs++;
      installFakeRuntime(env);
      return { ok: true };
    },
    ...over,
  };
  return { io, lines, asked, installs: () => installs };
}

describe("kya start: offer plain-language search", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kya-semsetup-"));
    env = { KYA_HOME: home };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("asks in a terminal, installs on Enter (default yes) and the runtime is there", async () => {
    const h = harness();
    expect(await maybeOfferSemanticSearch(h.io, env)).toBe("installed");
    expect(h.asked).toEqual(["Turn it on now? [Y/n]"]);
    expect(h.installs()).toBe(1);
    expect(semanticRuntimeInstalled(env)).toBe(true);
    expect(h.lines.join("\n")).toContain("400 MB");
    expect(h.lines.join("\n")).toContain("Nothing leaves this machine");
  });

  it("a no installs nothing and is not asked again", async () => {
    const h = harness({ ask: async () => "n" });
    expect(await maybeOfferSemanticSearch(h.io, env)).toBe("declined");
    expect(h.installs()).toBe(0);
    expect(semanticRuntimeInstalled(env)).toBe(false);
    const again = harness();
    expect(await maybeOfferSemanticSearch(again.io, env)).toBe("skipped");
    expect(again.asked).toEqual([]);
  });

  it("without a terminal it asks nothing, installs nothing, and prints how to turn it on", async () => {
    const h = harness({ isTty: false });
    expect(await maybeOfferSemanticSearch(h.io, env)).toBe("hinted");
    expect(h.asked).toEqual([]);
    expect(h.installs()).toBe(0);
    expect(h.lines.join("\n")).toContain("KYA_SEMANTIC=on kya start");
  });

  it("KYA_SEMANTIC=on installs without asking, even without a terminal", async () => {
    const h = harness({ isTty: false });
    expect(await maybeOfferSemanticSearch(h.io, { ...env, KYA_SEMANTIC: "on" })).toBe("installed");
    expect(h.asked).toEqual([]);
    expect(h.installs()).toBe(1);
  });

  it("KYA_SEMANTIC=off and KYA_SEARCH_SEMANTIC=off never ask", async () => {
    for (const extra of [{ KYA_SEMANTIC: "off" }, { KYA_SEARCH_SEMANTIC: "off" }]) {
      const h = harness();
      expect(await maybeOfferSemanticSearch(h.io, { ...env, ...extra })).toBe("skipped");
      expect(h.asked).toEqual([]);
      expect(h.installs()).toBe(0);
    }
  });

  it("an installed runtime is left alone", async () => {
    installFakeRuntime(env);
    const h = harness();
    expect(await maybeOfferSemanticSearch(h.io, env)).toBe("already");
    expect(h.asked).toEqual([]);
    expect(h.installs()).toBe(0);
  });

  it("a failed install fails open: says so, prints the manual command, and a yes is not turned into a no", async () => {
    const h = harness({ install: async () => ({ ok: false, detail: "network down" }) });
    expect(await maybeOfferSemanticSearch(h.io, env)).toBe("failed");
    const out = h.lines.join("\n");
    expect(out).toContain("network down");
    expect(out).toContain("npm install --prefix");
    const again = harness();
    expect(await maybeOfferSemanticSearch(again.io, env)).toBe("installed"); // asked again, not silenced
  });
});

describe.skipIf(process.platform === "win32")("kya start (real CLI): plain-language search question", () => {
  const cliJs = join(import.meta.dirname, "..", "dist", "cli.js");
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kya-semsetup-cli-"));
    bin = join(dir, "bin");
    mkdirSync(bin);
    // A fake npm: puts the runtime where `npm install --prefix <dir> pkg` would.
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      `#!/bin/sh
echo "$@" > "${dir}/npm-args.txt"
prefix=""
while [ $# -gt 0 ]; do if [ "$1" = "--prefix" ]; then prefix="$2"; fi; shift; done
mkdir -p "$prefix/node_modules/@shield-agent/fastembed"
echo '{"name":"@shield-agent/fastembed","version":"3.0.0","main":"index.js"}' > "$prefix/node_modules/@shield-agent/fastembed/package.json"
echo 'exports.x=1' > "$prefix/node_modules/@shield-agent/fastembed/index.js"
`,
    );
    chmodSync(npm, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(extraEnv: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const proj = join(dir, "proj");
    mkdirSync(proj, { recursive: true });
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliJs, "start", "--no-open", "--no-gate"], {
        cwd: proj,
        env: {
          ...process.env,
          HOME: dir,
          KYA_HOME: dir,
          KYA_NO_BROWSER: "1",
          KYA_SKIP_NODE_CHECK: "1",
          KYA_TELEMETRY: "0",
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          ...extraEnv,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("no terminal: start exits 0, installs nothing, prints the hint", async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Plain-language search is off");
    expect(r.stderr).toContain("KYA_SEMANTIC=on kya start");
    expect(existsSync(join(dir, "npm-args.txt"))).toBe(false);
    expect(semanticRuntimeInstalled({ KYA_HOME: dir })).toBe(false);
  }, 30_000);

  it("KYA_SEMANTIC=on: start runs the pinned npm install into the opt-in folder and exits 0", async () => {
    const r = await run({ KYA_SEMANTIC: "on" });
    expect(r.code).toBe(0);
    const args = readFileSync(join(dir, "npm-args.txt"), "utf8");
    expect(args).toContain("install");
    expect(args).toContain("--prefix");
    expect(args).toContain(join(dir, ".kya", "semantic"));
    expect(args).toContain("@shield-agent/fastembed@3.0.0");
    expect(semanticRuntimeInstalled({ KYA_HOME: dir })).toBe(true);
    expect(r.stderr).toContain("Plain-language search is on");
  }, 30_000);

  it("KYA_SEMANTIC=on with a broken npm: start still exits 0 and prints the manual command", async () => {
    writeFileSync(join(bin, "npm"), "#!/bin/sh\necho 'boom' >&2\nexit 1\n");
    chmodSync(join(bin, "npm"), 0o755);
    const r = await run({ KYA_SEMANTIC: "on" });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Could not install it");
    expect(r.stderr).toContain("npm install --prefix");
    expect(semanticRuntimeInstalled({ KYA_HOME: dir })).toBe(false);
  }, 30_000);
});
