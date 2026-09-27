/**
 * Local gateway binary management. `kya gate setup` is the ONLY place a
 * binary is downloaded: it fetches the pinned repacked artifact from this
 * repo's own `gate-v*` GitHub release, verifies the published sha256, and
 * installs to `<global .kya>/bin/kya-gate`. Everything else (run/doctor)
 * only ever uses the binary already on disk.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigDir } from "../config.js";
import { KyaError } from "../errors.js";

/** Pinned gateway build. Bump only together with the repack workflow input. */
export const GATE_VERSION = "1.5.0";

const RELEASE_REPO = "The-Pixel-Boys/shield-kya";

export function gateBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "bin");
}

export function gateBinaryPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(gateBinDir(env), platform === "win32" ? "kya-gate.exe" : "kya-gate");
}

export interface GatePlatform {
  readonly os: "linux" | "darwin" | "windows";
  readonly arch: "amd64" | "arm64";
}

export function resolveGatePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): GatePlatform {
  const os =
    platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : undefined;
  const a = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!os || !a) {
    throw new KyaError(
      `no gateway build for ${platform}/${arch} — supported: linux, darwin, windows × amd64, arm64`,
      "GATE_UNSUPPORTED_PLATFORM",
    );
  }
  return { os, arch: a };
}

export function gateArtifactName(version: string, p: GatePlatform): string {
  return `kya-gate-${version}-${p.os}-${p.arch}.tar.gz`;
}

export function gateArtifactUrl(version: string, p: GatePlatform): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/gate-v${version}/${gateArtifactName(version, p)}`;
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** First hex token of a `<sha256>  <name>` checksum file. */
export function parseSha256File(text: string): string {
  const m = /^([0-9a-f]{64})/i.exec(text.trim());
  if (!m) throw new KyaError("checksum file is malformed", "GATE_CHECKSUM_MALFORMED");
  return m[1]!.toLowerCase();
}

export interface GateBinaryStatus {
  readonly path: string;
  readonly present: boolean;
  /** First line of `kya-gate --version`, when readable. */
  readonly version?: string;
}

export function inspectGateBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): GateBinaryStatus {
  const path = gateBinaryPath(env, platform);
  if (!existsSync(path)) return { path, present: false };
  let version: string | undefined;
  try {
    const out = execFileSync(path, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    // The binary prints a JSON build object; fall back to the first line.
    try {
      const parsed = JSON.parse(out) as { version?: unknown };
      version = typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
      version = out.split("\n")[0]?.trim();
    }
  } catch {
    version = undefined;
  }
  return { path, present: true, version: version || undefined };
}

export interface EnsureBinaryDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchFn?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> }>;
  /** Injectable for tests; defaults to tar extraction via the system tar. */
  readonly extract?: (tarGzPath: string, destDir: string) => void;
}

function defaultExtract(tarGzPath: string, destDir: string): void {
  execFileSync("tar", ["-xzf", tarGzPath, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
}

export interface EnsureBinaryResult {
  readonly path: string;
  readonly installed: boolean;
  readonly version: string;
}

/**
 * Install the pinned gateway binary when absent or stale (reported version ≠
 * GATE_VERSION). Never silently downloads: this runs only from
 * `kya gate setup`. A checksum mismatch aborts the install and leaves the
 * previous binary untouched; the install itself is atomic (temp file +
 * rename inside the bin dir).
 */
export async function ensureGateBinary(deps: EnsureBinaryDeps = {}): Promise<EnsureBinaryResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const p = resolveGatePlatform(platform, deps.arch ?? process.arch);
  const path = gateBinaryPath(env, platform);
  const existing = inspectGateBinary(env, platform);
  if (existing.present && existing.version === GATE_VERSION) {
    return { path, installed: false, version: GATE_VERSION };
  }

  const fetchFn =
    deps.fetchFn ??
    ((url: string) => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) }));
  const name = gateArtifactName(GATE_VERSION, p);
  const base = gateArtifactUrl(GATE_VERSION, p);

  const binDir = gateBinDir(env);
  mkdirSync(binDir, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "kya-gate-"));
  try {
    const [tgzRes, sumRes] = [await fetchFn(base), await fetchFn(`${base}.sha256`)];
    if (!tgzRes.ok || !sumRes.ok) {
      throw new KyaError(
        `gateway artifact ${name} not available (HTTP ${!tgzRes.ok ? tgzRes.status : sumRes.status}) — gateway binaries are published by the kya release pipeline (see legal/THIRD-PARTY.md); check the release tag gate-v${GATE_VERSION}`,
        "GATE_DOWNLOAD_FAILED",
      );
    }
    const tgz = Buffer.from(await tgzRes.arrayBuffer());
    const expected = parseSha256File(await sumRes.text());
    const actual = sha256Hex(tgz);
    if (actual !== expected) {
      throw new KyaError(
        `gateway artifact checksum mismatch (expected ${expected}, got ${actual}) — refusing to install`,
        "GATE_CHECKSUM_MISMATCH",
      );
    }
    const tgzPath = join(stage, name);
    writeFileSync(tgzPath, tgz);
    (deps.extract ?? defaultExtract)(tgzPath, stage);
    const extracted = join(stage, platform === "win32" ? "kya-gate.exe" : "kya-gate");
    if (!existsSync(extracted)) {
      throw new KyaError(
        `gateway artifact ${name} did not contain a kya-gate binary — corrupt repack?`,
        "GATE_ARTIFACT_INVALID",
      );
    }
    // Atomic install: stage beside the target, then rename over it.
    const tmpTarget = join(binDir, `.kya-gate.${process.pid}.tmp`);
    writeFileSync(tmpTarget, readFileSync(extracted));
    if (platform !== "win32") chmodSync(tmpTarget, 0o755);
    renameSync(tmpTarget, path);
    return { path, installed: true, version: GATE_VERSION };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
