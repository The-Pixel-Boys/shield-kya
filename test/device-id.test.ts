import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deviceId, installSalt } from "../src/device-id.js";

const distModule = pathToFileURL(join(import.meta.dirname, "..", "dist", "device-id.js")).href;
const freshHome = () => mkdtempSync(join(tmpdir(), "kya-devid-"));
const saltPath = (home: string) => join(home, ".kya", "device-salt");
const readSalt = (home: string) => readFileSync(saltPath(home), "utf8");

/** Fresh process with the given KYA_HOME: prints deviceId(process.env). */
function childId(home: string): string | null {
  const r = spawnSync(process.execPath, ["-e", "import(process.argv[1]).then((m) => process.stdout.write(String(m.deviceId(process.env))))", distModule], {
    env: { ...process.env, KYA_HOME: home },
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe("deviceId", () => {
  it("is stable across calls in one process and writes the salt once", () => {
    const h = freshHome();
    const env = { KYA_HOME: h };
    const a = deviceId(env);
    const salt = readSalt(h);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(deviceId(env)).toBe(a);
    expect(readSalt(h)).toBe(salt);
    expect(salt.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the same across processes that share one KYA_HOME, and the salt is not rewritten", () => {
    const h = freshHome();
    const id = deviceId({ KYA_HOME: h });
    const salt = readSalt(h);
    expect(childId(h)).toBe(id);
    expect(readSalt(h)).toBe(salt);
  });

  it("concurrent first creators in fresh processes agree on one salt", async () => {
    const h = freshHome();
    const run = () => new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, ["-e", "import(process.argv[1]).then((m) => process.stdout.write(String(m.deviceId(process.env))))", distModule], {
        env: { ...process.env, KYA_HOME: h },
      });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", reject);
      c.on("close", () => resolve(out));
    });
    const ids = await Promise.all([run(), run(), run(), run()]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs for another KYA_HOME", () => {
    expect(deviceId({ KYA_HOME: freshHome() })).not.toBe(deviceId({ KYA_HOME: freshHome() }));
  });

  it.skipIf(process.platform === "win32")("stores the salt with file mode 0600", () => {
    const h = freshHome();
    deviceId({ KYA_HOME: h });
    expect(statSync(saltPath(h)).mode & 0o777).toBe(0o600);
  });

  it("is exactly the first 16 hex of sha256(salt|constant): no host, user, MAC or path input", () => {
    const h = freshHome();
    const id = deviceId({ KYA_HOME: h });
    const salt = readSalt(h).trim();
    const expected = createHash("sha256").update(`${salt}|kya-device-id-v1`, "utf8").digest("hex").slice(0, 16);
    expect(id).toBe(expected);
    for (const name of [hostname(), userInfo().username]) {
      // Short or hex-only names could match by chance inside random hex; only longer, non-hex names are checked.
      if (name.length >= 4 && !/^[0-9a-f]+$/i.test(name)) {
        expect(id).not.toContain(name);
        expect(salt).not.toContain(name);
      }
    }
  });

  it("returns undefined without throwing when the KYA_HOME is not a directory", () => {
    const blocker = join(freshHome(), "not-a-dir");
    writeFileSync(blocker, "x");
    expect(() => deviceId({ KYA_HOME: blocker })).not.toThrow();
    expect(deviceId({ KYA_HOME: blocker })).toBeUndefined();
  });

  it("returns undefined and does not overwrite a corrupt salt file", () => {
    const h = freshHome();
    mkdirSync(join(h, ".kya"), { recursive: true });
    writeFileSync(saltPath(h), "not-a-salt");
    expect(deviceId({ KYA_HOME: h })).toBeUndefined();
    expect(readSalt(h)).toBe("not-a-salt");
  });
});

describe("installSalt", () => {
  it("returns the same salt that deviceId hashes, and undefined when no salt can be read", () => {
    const h = freshHome();
    const salt = installSalt({ KYA_HOME: h });
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(salt).toBe(readSalt(h).trim());
    const id = createHash("sha256").update(`${salt}|kya-device-id-v1`, "utf8").digest("hex").slice(0, 16);
    expect(deviceId({ KYA_HOME: h })).toBe(id);
    const blocker = join(freshHome(), "not-a-dir");
    writeFileSync(blocker, "x");
    expect(installSalt({ KYA_HOME: blocker })).toBeUndefined();
  });
});

describe("deviceId: salt file safety (review item 7)", () => {
  it.skipIf(process.platform === "win32")("a salt that other users can read gives no id", async () => {
    const { chmodSync } = await import("node:fs");
    const home = freshHome();
    expect(deviceId({ KYA_HOME: home })).toMatch(/^[0-9a-f]{16}$/);
    chmodSync(saltPath(home), 0o644);
    const spawned = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(distModule)}).then(m=>console.log(String(m.deviceId({KYA_HOME:${JSON.stringify(home)}}))))`], { encoding: "utf8" });
    expect(spawned.stdout.trim()).toBe("undefined");
  });
});
