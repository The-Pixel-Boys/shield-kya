import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/parse-args.js";
import { runSandboxCommand } from "../src/commands/sandbox.js";
import { createMockDriver } from "../src/sandbox/mock-driver.js";
import { assertSandboxId } from "../src/sandbox/id.js";
import {
  createOpenshellDriver,
  openshellResetForTests,
} from "../src/sandbox/openshell-driver.js";
import {
  resolveSandboxDriver,
  killSandbox,
  loadSandboxState,
  spawnSandbox,
} from "../src/sandbox/runtime.js";
import { evaluateOffline } from "../src/offline-evaluate.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

describe("openshell backend (fake openshell binary)", () => {
  const dirs: string[] = [];
  const saved = { ...process.env };
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    openshellResetForTests();
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "kya-openshell-"));
    dirs.push(d);
    return d;
  }

  /** Fake `openshell` CLI (plus docker/podman stubs) on an isolated PATH. */
  function fakeOpenshell(home: string, opts?: { version?: string; runtime?: boolean }): string {
    const binDir = join(home, "bin");
    mkdirSync(binDir, { recursive: true });
    const script = `#!/bin/sh
logdir="\${FAKE_OPENSHELL_LOG:?FAKE_OPENSHELL_LOG not set}"
printf '%s\\n' "$*" >> "$logdir/argv.log"
case "$1" in
  --version)
    printf 'openshell version %s\\n' "\${FAKE_OPENSHELL_VERSION:-0.1.0}"
    ;;
  sandbox)
    sub="$2"
    if [ "$sub" = "create" ]; then
      name=""
      policy=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --name) name="$2"; shift 2 ;;
          --policy) policy="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      {
        printf 'OPENSHELL_TELEMETRY_ENABLED=%s\\n' "$OPENSHELL_TELEMETRY_ENABLED"
        printf 'name=%s\\n' "$name"
        printf 'policy=%s\\n' "$policy"
      } >> "$logdir/create-$name.env"
      printf '{"name":"%s"}\\n' "$name"
    elif [ "$sub" = "exec" ]; then
      printf 'exec %s\\n' "$3" >> "$logdir/exec.log"
      case "$*" in
        *boom*) exit 7 ;;
      esac
      printf 'exec-ok %s\\n' "$3"
    elif [ "$sub" = "delete" ]; then
      printf 'delete %s\\n' "$3" >> "$logdir/delete.log"
    fi
    ;;
esac
exit 0
`;
    const binPath = join(binDir, "openshell");
    writeFileSync(binPath, script, "utf8");
    chmodSync(binPath, 0o755);
    if (opts?.runtime !== false) {
      for (const rt of ["docker", "podman"]) {
        const p = join(binDir, rt);
        writeFileSync(p, "#!/bin/sh\nexit 0\n", "utf8");
        chmodSync(p, 0o755);
      }
    }
    process.env.PATH = binDir;
    process.env.FAKE_OPENSHELL_LOG = join(home, "log");
    mkdirSync(process.env.FAKE_OPENSHELL_LOG, { recursive: true });
    if (opts?.version) process.env.FAKE_OPENSHELL_VERSION = opts.version;
    return binDir;
  }

  it("resolveSandboxDriver accepts openshell via flag and KYA_SANDBOX", () => {
    const root = tmp();
    process.env.KYA_SANDBOX = "openshell";
    expect(resolveSandboxDriver(undefined, { root }).backend).toBe("openshell");
    delete process.env.KYA_SANDBOX;
    expect(resolveSandboxDriver("openshell", { root }).backend).toBe("openshell");
  });

  it("spawn writes state, renders the policy, keeps the backend name, telemetry off", async () => {
    const home = tmp();
    fakeOpenshell(home);
    const root = join(home, "proj");
    mkdirSync(root, { recursive: true });
    const driver = createOpenshellDriver({ root });
    const row = await spawnSandbox({ root, driver });

    expect(row.backend).toBe("openshell");
    expect(row.status).toBe("running");
    expect(row.externalName).toBe(`kya-${row.sandboxId}`);
    expect(driver.externalNameFor?.(row.sandboxId)).toBe(`kya-${row.sandboxId}`);

    const policyPath = join(root, ".kya", "openshell", `policy-${row.sandboxId}.yaml`);
    expect(existsSync(policyPath)).toBe(true);
    const policy = readFileSync(policyPath, "utf8");
    expect(policy).toContain("version: 1");
    expect(policy).toContain('run_as_user: "nobody"');
    expect(policy).toContain("network_policies: []");
    expect(policy).toContain("- path: /workspace");
    expect(policy).toContain("access: read_write");
    expect(policy).toContain("access: read_only");

    const createEnv = readFileSync(
      join(process.env.FAKE_OPENSHELL_LOG!, `create-kya-${row.sandboxId}.env`),
      "utf8",
    );
    expect(createEnv).toContain("OPENSHELL_TELEMETRY_ENABLED=false");
    expect(createEnv).not.toContain("OPENSHELL_TELEMETRY_ENABLED=true");
    expect(loadSandboxState(root)[0]?.externalName).toBe(`kya-${row.sandboxId}`);
  });

  it("exec returns the CLI exit code and output; kill deletes the backend sandbox", async () => {
    const home = tmp();
    fakeOpenshell(home);
    const root = join(home, "proj");
    mkdirSync(root, { recursive: true });
    const driver = createOpenshellDriver({ root });
    const row = await spawnSandbox({ root, driver });

    const ok = await driver.exec({
      sandboxId: row.sandboxId,
      command: ["echo", "hi"],
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("exec-ok");

    const boom = await driver.exec({
      sandboxId: row.sandboxId,
      command: ["echo", "boom"],
    });
    expect(boom.exitCode).toBe(7);

    await killSandbox({ root, driver, sandboxId: row.sandboxId });
    expect(loadSandboxState(root)[0]?.status).toBe("killed");
    expect(driver.externalNameFor?.(row.sandboxId)).toBeUndefined();
    const deletes = readFileSync(join(process.env.FAKE_OPENSHELL_LOG!, "delete.log"), "utf8");
    expect(deletes).toContain(`delete kya-${row.sandboxId}`);
  });

  it("refuses to spawn without the openshell CLI on PATH", async () => {
    const home = tmp();
    const empty = join(home, "empty-bin");
    mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;
    const root = join(home, "proj");
    mkdirSync(root, { recursive: true });
    const driver = createOpenshellDriver({ root });
    await expect(spawnSandbox({ root, driver })).rejects.toThrow(/openshell/);
  });

  it("refuses to spawn without docker or podman", async () => {
    const home = tmp();
    fakeOpenshell(home, { runtime: false });
    const root = join(home, "proj");
    mkdirSync(root, { recursive: true });
    const driver = createOpenshellDriver({ root });
    await expect(spawnSandbox({ root, driver })).rejects.toThrow(
      /container runtime.*docker or podman/i,
    );
  });

  it("enforces the pinned version floor", async () => {
    const home = tmp();
    fakeOpenshell(home, { version: "0.0.9" });
    const root = join(home, "proj");
    mkdirSync(root, { recursive: true });
    const driver = createOpenshellDriver({ root });
    await expect(spawnSandbox({ root, driver })).rejects.toThrow(/0\.0\.9.*>=0\.1\.0/s);

    fakeOpenshell(join(home, "v2"), { version: "0.1.0" });
    const row = await spawnSandbox({ root, driver });
    expect(row.backend).toBe("openshell");
  });

  it("CLI exec evaluates policy before touching the driver", async () => {
    const home = tmp();
    fakeOpenshell(home);
    const root = join(home, "proj");
    mkdirSync(root, { recursive: true });
    const prev = process.cwd();
    process.chdir(root);
    process.env.KYA_SANDBOX = "openshell";
    delete process.env.KYA_API_KEY;
    const sandboxId = "sbx-11111111-2222-4333-8444-555555555555";
    try {
      const code = await runSandboxCommand(
        parseArgs(["sandbox", "exec", "--sandbox-id", sandboxId, "--cmd", "true"]),
      );
      expect(code).toBe(4);
      expect(existsSync(join(process.env.FAKE_OPENSHELL_LOG!, "exec.log"))).toBe(false);
    } finally {
      process.chdir(prev);
      delete process.env.KYA_SANDBOX;
    }
  });
});

describe.skipIf(process.env.KYA_E2E_OPENSHELL !== "1")(
  "e2e: openshell against the real binary (KYA_E2E_OPENSHELL=1)",
  () => {
    it("spawns, execs and kills a real openshell sandbox", async () => {
      const root = mkdtempSync(join(tmpdir(), "kya-openshell-e2e-"));
      try {
        const driver = createOpenshellDriver({ root });
        const row = await spawnSandbox({ root, driver });
        expect(row.backend).toBe("openshell");
        const res = await driver.exec({
          sandboxId: row.sandboxId,
          command: ["echo", "hello-from-openshell"],
        });
        expect(res.exitCode).toBe(0);
        await killSandbox({ root, driver, sandboxId: row.sandboxId });
        expect(loadSandboxState(root)[0]?.status).toBe("killed");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);

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
