/**
 * Endpoint discovery scanner.
 *
 * Collects a best-effort inventory of AI agents, IDE extensions, desktop apps,
 * model runtimes, and MCP servers present on the local workstation. The scanner
 * only inspects paths and config files; it never executes discovered binaries
 * and never connects to runtime ports.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, sep } from "node:path";
import type { DiscoveryCategory } from "./catalog.js";
import { discoveryCatalog, knownDiscoveryVendors } from "./catalog.js";

export type Confidence = "high" | "medium" | "low";

export interface DiscoveryEvidence {
  readonly path?: string;
  readonly version?: string;
  readonly port?: number;
  readonly command?: string;
  readonly configPath?: string;
}

export interface DiscoveryFinding {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly category: DiscoveryCategory;
  readonly source: string;
  readonly confidence: Confidence;
  readonly evidence: DiscoveryEvidence;
}

export interface DiscoveryCoverage {
  readonly attempted: readonly string[];
  readonly unavailable: readonly string[];
  readonly truncated: boolean;
}

export interface DiscoverySnapshot {
  readonly endpointUid: string;
  readonly hostnameHash: string;
  readonly os: "darwin" | "linux" | "win32" | "unknown";
  readonly capturedAt: string;
  readonly inventory: readonly DiscoveryFinding[];
  readonly coverage: DiscoveryCoverage;
}

export interface ScanOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly now?: Date;
  /** Injected fs-ish object for tests. */
  readonly fs?: ScanFs;
  /** Override PATH directories (defaults to process.env.PATH). */
  readonly pathDirs?: readonly string[];
  /** Override home dir used for redaction (defaults to os.homedir()). */
  readonly homeDir?: string;
  /** Override OS platform (defaults to process.platform). */
  readonly platform?: string;
}

export interface ScanFs {
  existsSync(path: string): boolean;
  statSync(path: string): { isFile(): boolean; isDirectory(): boolean; mode: number; size: number };
  readdirSync(path: string): readonly string[];
  readFileSync(path: string, encoding: "utf8"): string;
}

const ATTEMPTED_CATEGORIES = [
  "cli-binaries",
  "ide-extensions",
  "desktop-apps",
  "model-runtimes",
  "mcp-servers",
] as const;

function nodeFs(): ScanFs {
  return { existsSync, statSync, readdirSync, readFileSync };
}

function defaultPathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? "";
  return raw
    .split(process.platform === "win32" ? ";" : ":")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function detectOs(raw?: string): DiscoverySnapshot["os"] {
  const p = raw ?? process.platform;
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "win32";
  return "unknown";
}

function redactValue(value: unknown, home: string): unknown {
  if (typeof value === "string") {
    const prefix = home.endsWith(sep) ? home : home + sep;
    if (value === home) return "~";
    if (value.startsWith(prefix)) return "~" + sep + value.slice(prefix.length);
  }
  return value;
}

function redactEvidence(evidence: DiscoveryEvidence, home: string): DiscoveryEvidence {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    out[key] = redactValue(value, home);
  }
  return out as DiscoveryEvidence;
}

function isExecutable(st: { isFile(): boolean; mode: number }, isWindows: boolean): boolean {
  if (!st.isFile()) return false;
  if (isWindows) return true; // extension check is done by caller
  // eslint-disable-next-line no-bitwise
  return (st.mode & constants.S_IXUSR) !== 0 || (st.mode & constants.S_IXOTH) !== 0;
}

function isWindowsPlatform(platformName: string): boolean {
  return platformName === "win32";
}

export function buildEndpointId(os: DiscoverySnapshot["os"]): {
  endpointUid: string;
  hostnameHash: string;
} {
  const host = hostname();
  const user = userInfo().username;
  const hostnameHash = sha256(host);
  const userHash = sha256(user);
  const stableId = `${os}:${hostnameHash}:${userHash}`;
  return { endpointUid: sha256(stableId), hostnameHash };
}

interface PathCandidate {
  readonly entryId: string;
  readonly binary: string;
  readonly path: string;
}

function pathCandidates(pathDirs: readonly string[]): PathCandidate[] {
  const catalog = discoveryCatalog();
  const candidates: PathCandidate[] = [];
  for (const [entryId, entry] of catalog) {
    for (const binary of entry.binaries) {
      for (const dir of pathDirs) {
        candidates.push({ entryId, binary, path: join(dir, binary) });
      }
    }
  }
  return candidates;
}

function extensionRootDirs(home: string, platformName: string): string[] {
  if (isWindowsPlatform(platformName)) {
    const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      join(appdata, "Cursor", "User", "globalStorage"),
      join(appdata, "Code", "User", "globalStorage"),
    ];
  }
  if (platformName === "darwin") {
    return [
      join(home, "Library", "Application Support", "Cursor", "User", "globalStorage"),
      join(home, "Library", "Application Support", "Code", "User", "globalStorage"),
    ];
  }
  return [
    join(home, ".config", "Cursor", "User", "globalStorage"),
    join(home, ".config", "Code", "User", "globalStorage"),
  ];
}

function desktopAppDirs(platformName: string): string[] {
  if (platformName === "darwin") return ["/Applications"];
  if (platformName === "linux") return ["/usr/share/applications", "/usr/local/share/applications"];
  if (isWindowsPlatform(platformName)) {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [pf, pf86];
  }
  return [];
}

function tryReadJsonFile(fs: ScanFs, path: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function scanCliBinaries(
  pathDirs: readonly string[],
  fs: ScanFs,
  platformName: string,
): DiscoveryFinding[] {
  const findings: DiscoveryFinding[] = [];
  const catalog = discoveryCatalog();
  const seen = new Set<string>();
  const isWin = isWindowsPlatform(platformName);
  for (const { entryId, path } of pathCandidates(pathDirs)) {
    const key = `${entryId}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const st = fs.statSync(path);
      const candidatePath = isWin && !path.toLowerCase().endsWith(".exe") ? `${path}.exe` : path;
      const candidateSt = candidatePath !== path && fs.existsSync(candidatePath)
        ? fs.statSync(candidatePath)
        : st;
      if (!isExecutable(candidateSt, isWin)) continue;
      const entry = catalog.get(entryId)!;
      findings.push({
        id: entryId,
        name: entry.name,
        vendor: entry.vendor,
        category: entry.category,
        source: `PATH:${path}`,
        confidence: "high",
        evidence: { path: candidatePath },
      });
    } catch {
      /* not found or not readable */
    }
  }
  return findings;
}

export function scanIdeExtensions(
  extensionRoots: readonly string[],
  fs: ScanFs,
): DiscoveryFinding[] {
  const findings: DiscoveryFinding[] = [];
  const catalog = discoveryCatalog();
  const vendors = knownDiscoveryVendors();
  const seen = new Set<string>();
  for (const root of extensionRoots) {
    let entries: readonly string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const extId of entries) {
      const lower = extId.toLowerCase();
      let matchedEntry: { id: string; name: string; vendor: string; category: DiscoveryCategory } | undefined;
      let confidence: Confidence = "low";
      for (const [id, entry] of catalog) {
        for (const marker of entry.extensionMarkers) {
          if (lower.includes(marker.toLowerCase())) {
            matchedEntry = { id, name: entry.name, vendor: entry.vendor, category: entry.category };
            confidence = marker === entry.id ? "medium" : "low";
            break;
          }
        }
        if (matchedEntry) break;
      }
      if (!matchedEntry) {
        // Generic vendor match: still report as ide-extension with unknown id.
        const vendor = vendors.find((v) => lower.includes(v));
        if (vendor) {
          matchedEntry = {
            id: `ide-ext-${vendor}`,
            name: `${vendor} extension`,
            vendor,
            category: "ide-extension",
          };
          confidence = "low";
        }
      }
      if (!matchedEntry) continue;
      const key = `${matchedEntry.id}:${extId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: matchedEntry.id,
        name: matchedEntry.name,
        vendor: matchedEntry.vendor,
        category: matchedEntry.category,
        source: `IDE-EXT:${root}`,
        confidence,
        evidence: { path: join(root, extId) },
      });
    }
  }
  return findings;
}

export function scanDesktopApps(
  appDirs: readonly string[],
  fs: ScanFs,
  platformName: string,
): DiscoveryFinding[] {
  const findings: DiscoveryFinding[] = [];
  const catalog = discoveryCatalog();
  const seen = new Set<string>();
  for (const dir of appDirs) {
    let entries: readonly string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const lower = name.toLowerCase();
      let matchedEntry: { id: string; name: string; vendor: string; category: DiscoveryCategory } | undefined;
      for (const [id, entry] of catalog) {
        for (const appName of entry.appNames) {
          if (lower.includes(appName.toLowerCase())) {
            matchedEntry = { id, name: entry.name, vendor: entry.vendor, category: "desktop-app" };
            break;
          }
        }
        if (matchedEntry) break;
      }
      if (!matchedEntry) continue;
      const key = `${matchedEntry.id}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: matchedEntry.id,
        name: matchedEntry.name,
        vendor: matchedEntry.vendor,
        category: "desktop-app",
        source: `APP:${dir}`,
        confidence: platformName === "darwin" ? "high" : "medium",
        evidence: { path: join(dir, name) },
      });
    }
  }
  return findings;
}

export function scanModelRuntimes(
  pathDirs: readonly string[],
  fs: ScanFs,
  platformName: string,
): DiscoveryFinding[] {
  const findings: DiscoveryFinding[] = [];
  const catalog = discoveryCatalog();
  const seen = new Set<string>();
  const isWin = isWindowsPlatform(platformName);
  for (const [entryId, entry] of catalog) {
    if (entry.category !== "model-runtime") continue;
    let foundPath: string | undefined;
    for (const binary of entry.binaries) {
      for (const dir of pathDirs) {
        const p = join(dir, binary);
        try {
          const st = fs.statSync(p);
          if (isExecutable(st, isWin)) {
            foundPath = p;
            break;
          }
        } catch {
          // Try .exe on Windows.
          if (isWin) {
            const pe = `${p}.exe`;
            try {
              const st = fs.statSync(pe);
              if (isExecutable(st, isWin)) {
                foundPath = pe;
                break;
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
      if (foundPath) break;
    }
    if (foundPath) {
      for (const port of entry.defaultPorts) {
        const key = `${entryId}:${port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          id: entryId,
          name: entry.name,
          vendor: entry.vendor,
          category: "model-runtime",
          source: `RUNTIME:${foundPath}`,
          confidence: "medium",
          evidence: { path: foundPath, port },
        });
      }
      if (entry.defaultPorts.length === 0) {
        const key = `${entryId}:${foundPath}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({
            id: entryId,
            name: entry.name,
            vendor: entry.vendor,
            category: "model-runtime",
            source: `RUNTIME:${foundPath}`,
            confidence: "medium",
            evidence: { path: foundPath },
          });
        }
      }
    }
  }
  return findings;
}

interface McpServerWire {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
}

function collectMcpServersFromObject(obj: unknown): McpServerWire[] {
  if (!obj || typeof obj !== "object") return [];
  const servers = (obj as Record<string, unknown>)["mcpServers"] ?? (obj as Record<string, unknown>)["servers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  const out: McpServerWire[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const command = typeof v.command === "string" ? v.command : undefined;
    const url = typeof v.url === "string" ? v.url : undefined;
    const args = Array.isArray(v.args)
      ? (v.args as unknown[]).filter((a): a is string => typeof a === "string")
      : undefined;
    out.push({ name, command, args, url });
  }
  return out;
}

export function scanMcpServers(
  configPaths: readonly string[],
  fs: ScanFs,
): DiscoveryFinding[] {
  const findings: DiscoveryFinding[] = [];
  const seen = new Set<string>();
  for (const configPath of configPaths) {
    const raw = tryReadJsonFile(fs, configPath);
    const servers = collectMcpServersFromObject(raw);
    for (const server of servers) {
      const key = `${server.name}:${configPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const command = server.command ?? server.url ?? "unknown";
      findings.push({
        id: "mcpserver",
        name: server.name,
        vendor: "unknown",
        category: "mcp-server",
        source: `MCP:${configPath}`,
        confidence: "high",
        evidence: {
          configPath,
          command,
          ...(server.args ? { args: server.args.join(" ") } : {}),
        },
      });
    }
  }
  return findings;
}

function mcpConfigPaths(home: string, cwd: string): string[] {
  return [
    join(cwd, ".mcp.json"),
    join(cwd, "mcp.json"),
    join(cwd, ".cursor", "mcp.json"),
    join(home, ".mcp.json"),
    join(home, "mcp.json"),
    join(home, ".cursor", "mcp.json"),
  ];
}

export function scanEndpoint(options: ScanOptions = {}): DiscoverySnapshot {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platformName = options.platform ?? process.platform;
  const fs = options.fs ?? nodeFs();
  const home = options.homeDir ?? homedir();
  const os = detectOs(platformName);
  const { endpointUid, hostnameHash } = buildEndpointId(os);

  const pathDirs = options.pathDirs ?? defaultPathDirs(env);
  const extensionRoots = extensionRootDirs(home, platformName);
  const appDirs = desktopAppDirs(platformName);
  const mcpPaths = mcpConfigPaths(home, cwd);

  const unavailable: string[] = [];
  if (pathDirs.length === 0) unavailable.push("cli-binaries");

  const cliFindings = scanCliBinaries(pathDirs, fs, platformName);
  const extFindings = scanIdeExtensions(extensionRoots, fs);
  const appFindings = scanDesktopApps(appDirs, fs, platformName);
  const runtimeFindings = scanModelRuntimes(pathDirs, fs, platformName);
  const mcpFindings = scanMcpServers(mcpPaths, fs);

  const all = [
    ...cliFindings,
    ...extFindings,
    ...appFindings,
    ...runtimeFindings,
    ...mcpFindings,
  ];

  const inventory = all.map((f) => ({
    ...f,
    evidence: redactEvidence(f.evidence, home),
  }));

  return {
    endpointUid,
    hostnameHash,
    os,
    capturedAt: (options.now ?? new Date()).toISOString(),
    inventory,
    coverage: {
      attempted: [...ATTEMPTED_CATEGORIES],
      unavailable,
      truncated: false,
    },
  };
}
