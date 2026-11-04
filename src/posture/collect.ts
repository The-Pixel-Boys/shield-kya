/**
 * Builds the posture report v1 (spec: shield-agent contract, "Posture report v1") from local
 * facts only. Minimised on purpose: agent hosts, agent-related extensions, MCP server names with
 * transport and command basename, the IoC result and the never-list status. No args, env values,
 * file contents, paths, user names or addresses. The validator (validate.ts) is the last word.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { scanCliBinaries, type ScanFs } from "../discover/scan.js";
import { CLI_VERSION } from "../version.js";
import type { IocResult } from "../ioc/result.js";

/** Agent-related extensions the client may report (plus any id an IoC check names). */
export const AGENT_EXTENSIONS: Readonly<Record<string, string>> = {
  "anthropic.claude-code": "claude-code",
  "openai.chatgpt": "codex",
  "github.copilot": "copilot",
  "github.copilot-chat": "copilot",
  "saoudrizwan.claude-dev": "cline",
  "rooveterinaryinc.roo-cline": "roo-code",
  "continue.continue": "continue",
  "google.geminicodeassist": "gemini",
  "sourcegraph.cody-ai": "cody",
  "kilocode.kilo-code": "kilo-code",
  "amazonwebservices.amazon-q-vscode": "amazon-q",
  "codeium.codeium": "codeium",
  "tabnine.tabnine-vscode": "tabnine",
};

/** Catalog id (discover/catalog.ts) to the host id the report uses. Only CLI agents appear here. */
const CLI_HOSTS: Readonly<Record<string, string>> = {
  claude: "claude-code",
  "cursor-agent": "cursor",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  aider: "aider",
};

const EXTENSION_ROOTS: ReadonlyArray<readonly [string, "vscode" | "cursor" | "windsurf" | "vscodium"]> = [
  [".vscode/extensions", "vscode"],
  [".vscode-insiders/extensions", "vscode"],
  [".cursor/extensions", "cursor"],
  [".windsurf/extensions", "windsurf"],
  [".vscode-oss/extensions", "vscodium"],
];

const MCP_FILES = [".mcp.json", join(".cursor", "mcp.json"), ".claude.json", join(".gemini", "settings.json")];
const MAX_HOSTS = 32;
const MAX_EXTENSIONS = 200;
const MAX_MCP = 100;
const MAX_FINDINGS = 50;

export interface CollectInput {
  readonly deviceId: string;
  readonly label: string;
  readonly now: Date;
  readonly home: string;
  readonly pathDirs: readonly string[];
  readonly platform: string;
  readonly arch: string;
  readonly ioc: IocResult | undefined;
  /** IoC ids named by a check (added to the extension allowlist). */
  readonly iocExtensionIds: readonly string[];
  readonly hosted: boolean;
}

const nodeFs = (): ScanFs => ({
  existsSync,
  statSync: (p: string) => statSync(p),
  readdirSync: (p: string) => readdirSync(p),
  readFileSync: (p: string, enc: "utf8") => readFileSync(p, enc),
});

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function hostsFrom(input: CollectInput, extensions: { id: string }[]): { id: string; version: string | null; kyaHook: boolean }[] {
  const out = new Map<string, { id: string; version: string | null; kyaHook: boolean }>();
  for (const f of scanCliBinaries(input.pathDirs, nodeFs(), input.platform)) {
    if (f.category !== "cli-agent") continue;
    const host = CLI_HOSTS[f.id];
    if (host && !out.has(host)) out.set(host, { id: host, version: null, kyaHook: false });
  }
  for (const e of extensions) {
    const host = AGENT_EXTENSIONS[e.id];
    if (host && !out.has(host)) out.set(host, { id: host, version: null, kyaHook: false });
  }
  const claude = out.get("claude-code");
  if (claude) {
    // kyaHook is true only when the host's own settings file names kya. Checked for Claude Code only.
    const settings = readFileSync0(join(input.home, ".claude", "settings.json"));
    out.set("claude-code", { ...claude, kyaHook: settings !== undefined && settings.includes("kya") });
  }
  return [...out.values()].slice(0, MAX_HOSTS);
}

function readFileSync0(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function extensionsFrom(input: CollectInput): { id: string; version: string | null; editor: string }[] {
  const allowed = [...new Set([...Object.keys(AGENT_EXTENSIONS), ...input.iocExtensionIds])];
  const out: { id: string; version: string | null; editor: string }[] = [];
  const seen = new Set<string>();
  for (const [rel, editor] of EXTENSION_ROOTS) {
    let names: string[];
    try {
      names = readdirSync(join(input.home, rel));
    } catch {
      continue;
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      // Longest id wins: github.copilot-chat-x must not be read as github.copilot.
      const id = allowed.filter((a) => lower.startsWith(`${a}-`)).sort((a, b) => b.length - a.length)[0];
      if (id === undefined) continue;
      const m = /^(\d+(?:\.\d+)*)/.exec(lower.slice(id.length + 1));
      const version = m ? m[1]! : null;
      const key = `${id}|${version}|${editor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, version, editor });
    }
  }
  return out.slice(0, MAX_EXTENSIONS);
}

function mcpFrom(home: string): { name: string; transport: "stdio" | "http"; command: string | null }[] {
  const out: { name: string; transport: "stdio" | "http"; command: string | null }[] = [];
  const seen = new Set<string>();
  for (const rel of MCP_FILES) {
    const root = readJson(join(home, rel));
    if (root === null || typeof root !== "object") continue;
    const servers = (root as Record<string, unknown>)["mcpServers"];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      const s = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const kind = String(s["type"] ?? s["transport"] ?? "");
      const isHttp = typeof s["url"] === "string" || ["http", "sse", "streamable-http"].includes(kind);
      const transport = isHttp ? "http" : "stdio";
      // Basename of the program only: no args, no directories.
      const first = typeof s["command"] === "string" ? s["command"].trim().split(/\s+/)[0] ?? "" : "";
      const command = !isHttp && first !== "" ? basename(first.replace(/\\/g, "/")) : null;
      const key = `${name}|${transport}|${command ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, transport, command });
    }
  }
  return out.slice(0, MAX_MCP);
}

/** The report object before validation. Callers must run checkReport on it before any send. */
export function collectReport(input: CollectInput): Record<string, unknown> {
  const extensions = extensionsFrom(input);
  const hosts = hostsFrom(input, extensions);
  const mcp = mcpFrom(input.home);
  const ioc = input.ioc;
  return {
    schema: 1,
    reportedAt: input.now.toISOString(),
    kyaVersion: CLI_VERSION,
    deviceId: input.deviceId,
    deviceLabel: input.label,
    os: input.platform,
    arch: input.arch,
    hosts,
    extensions,
    mcpServers: mcp,
    ioc:
      ioc === undefined
        ? undefined
        : {
            listVersion: ioc.listVersion,
            checkedAt: ioc.checkedAt,
            skipped: ioc.skipped,
            findings: ioc.findings.slice(0, MAX_FINDINGS).map((f) => ({
              ioc: f.ioc,
              check: f.check,
              severity: f.severity,
              evidence: f.evidence,
              hint: f.hint,
            })),
          },
    never: { listActive: true, mode: input.hosted ? "hosted" : "advisory" },
  };
}
