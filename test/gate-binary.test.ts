import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GATE_VERSION,
  ensureGateBinary,
  gateArtifactName,
  gateArtifactUrl,
  gateBinaryPath,
  inspectGateBinary,
  parseSha256File,
  resolveGatePlatform,
  sha256Hex,
} from "../src/gate/binary.js";
import { KyaError } from "../src/errors.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kya-gate-bin-"));
}

function env(home: string): NodeJS.ProcessEnv {
  return { KYA_HOME: home };
}

const PAYLOAD = Buffer.from("fake-tarball-bytes");

function okFetch(body: Buffer = PAYLOAD, sumBody?: string) {
  const calls: string[] = [];
  const fetchFn = (url: string) => {
    calls.push(url);
    const isSum = url.endsWith(".sha256");
    const buf = isSum ? Buffer.from(sumBody ?? `${sha256Hex(PAYLOAD)}  artifact.tar.gz\n`) : body;
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer),
      text: () => Promise.resolve(buf.toString("utf8")),
    });
  };
  return { fetchFn, calls };
}

function fakeExtract(home: string) {
  return (tarGzPath: string, destDir: string) => {
    expect(readFileSync(tarGzPath)).toEqual(PAYLOAD);
    writeFileSync(join(destDir, "kya-gate"), "#!/bin/sh\necho kya-gate test\n", "utf8");
  };
}

describe("artifact naming and platform mapping", () => {
  it("pins one version and names artifacts kya-gate-<version>-<os>-<arch>", () => {
    expect(GATE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(gateArtifactName(GATE_VERSION, { os: "darwin", arch: "arm64" })).toBe(
      `kya-gate-${GATE_VERSION}-darwin-arm64.tar.gz`,
    );
    expect(gateArtifactUrl(GATE_VERSION, { os: "linux", arch: "amd64" })).toBe(
      `https://github.com/The-Pixel-Boys/shield-kya/releases/download/gate-v${GATE_VERSION}/kya-gate-${GATE_VERSION}-linux-amd64.tar.gz`,
    );
  });

  it("maps node platform/arch to artifact coordinates, failing closed otherwise", () => {
    expect(resolveGatePlatform("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(resolveGatePlatform("linux", "x64")).toEqual({ os: "linux", arch: "amd64" });
    expect(resolveGatePlatform("win32", "x64")).toEqual({ os: "windows", arch: "amd64" });
    expect(() => resolveGatePlatform("freebsd", "x64")).toThrow(KyaError);
    expect(() => resolveGatePlatform("linux", "ia32")).toThrow(KyaError);
  });

  it("parses sha256 sidecar files and hashes buffers", () => {
    const hex = createHash("sha256").update("x").digest("hex");
    expect(parseSha256File(`${hex}  name.tar.gz\n`)).toBe(hex);
    expect(parseSha256File(hex.toUpperCase())).toBe(hex);
    expect(() => parseSha256File("nope")).toThrow(KyaError);
  });
});

describe("ensureGateBinary", () => {
  function plantBinary(home: string, version: string): string {
    const path = gateBinaryPath(env(home), "linux");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho '{"version": "${version}"}'\n`, "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  it("returns the existing pinned binary without touching the network", async () => {
    const home = tmp();
    try {
      plantBinary(home, GATE_VERSION);
      const { fetchFn, calls } = okFetch();
      const r = await ensureGateBinary({ env: env(home), platform: "linux", arch: "x64", fetchFn });
      expect(r.installed).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reinstalls when the installed binary reports a different version", async () => {
    const home = tmp();
    try {
      plantBinary(home, "0.0.0-ancient");
      const { fetchFn, calls } = okFetch();
      const r = await ensureGateBinary({
        env: env(home),
        platform: "linux",
        arch: "x64",
        fetchFn,
        extract: fakeExtract(home),
      });
      expect(r.installed).toBe(true);
      expect(calls).toHaveLength(2);
      expect(readFileSync(r.path, "utf8")).toContain("kya-gate test");
      // no temp install files left behind in the bin dir
      expect(readdirSync(dirname(r.path)).filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("downloads, verifies sha256, extracts, and installs to .kya/bin", async () => {
    const home = tmp();
    try {
      const { fetchFn, calls } = okFetch();
      const r = await ensureGateBinary({
        env: env(home),
        platform: "linux",
        arch: "x64",
        fetchFn,
        extract: fakeExtract(home),
      });
      expect(r.installed).toBe(true);
      expect(r.path).toBe(gateBinaryPath(env(home), "linux"));
      expect(readFileSync(r.path, "utf8")).toContain("kya-gate test");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain(`/gate-v${GATE_VERSION}/`);
      expect(calls[1]).toMatch(/\.sha256$/);
      expect(inspectGateBinary(env(home), "linux").present).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("checksum mismatch aborts and leaves no binary behind", async () => {
    const home = tmp();
    try {
      const { fetchFn } = okFetch(PAYLOAD, `${"0".repeat(64)}  artifact.tar.gz\n`);
      await expect(
        ensureGateBinary({ env: env(home), platform: "linux", arch: "x64", fetchFn }),
      ).rejects.toThrow(/checksum mismatch/);
      expect(existsSync(gateBinaryPath(env(home), "linux"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("HTTP failure on the artifact aborts with a clear error", async () => {
    const home = tmp();
    try {
      const fetchFn = () =>
        Promise.resolve({
          ok: false,
          status: 404,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          text: () => Promise.resolve("not found"),
        });
      await expect(
        ensureGateBinary({ env: env(home), platform: "linux", arch: "x64", fetchFn }),
      ).rejects.toThrow(/not available \(HTTP 404\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("tarball without a kya-gate entry aborts as a corrupt repack", async () => {
    const home = tmp();
    try {
      const { fetchFn } = okFetch();
      await expect(
        ensureGateBinary({
          env: env(home),
          platform: "linux",
          arch: "x64",
          fetchFn,
          extract: () => {},
        }),
      ).rejects.toThrow(/did not contain a kya-gate binary/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
