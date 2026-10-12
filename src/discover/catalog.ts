/**
 * Known-tool catalog for endpoint discovery.
 *
 * The catalog maps a stable short id to display metadata and a default
 * sanction. The defaults are advisory; the hosted console can override them.
 * v1 deliberately has no UNSANCTIONED defaults - unknown tooling defaults to
 * REVIEW so operators can inspect before classifying.
 */

export type DiscoveryCategory =
  | "cli-agent"
  | "ide-extension"
  | "desktop-app"
  | "model-runtime"
  | "mcp-server"
  | "other";

export type Sanction = "SANCTIONED" | "REVIEW" | "UNSANCTIONED";

export interface CatalogEntry {
  readonly name: string;
  readonly vendor: string;
  readonly category: DiscoveryCategory;
  readonly defaultSanction: Sanction;
}

interface CatalogDef {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly category: DiscoveryCategory;
  readonly defaultSanction: Sanction;
  /** Executable / binary names this tool is known by on PATH or in app dirs. */
  readonly binaries?: readonly string[];
  /** Desktop app bundle / .desktop / install-dir names (case-insensitive). */
  readonly appNames?: readonly string[];
  /** IDE extension id substrings (case-insensitive) that identify this tool. */
  readonly extensionMarkers?: readonly string[];
  /** Default localhost ports this runtime may listen on (never probed). */
  readonly defaultPorts?: readonly number[];
}

const CATALOG_DEFS: readonly CatalogDef[] = [
  {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    category: "cli-agent",
    defaultSanction: "SANCTIONED",
    binaries: ["claude", "claude-code"],
    appNames: ["Claude", "Claude.app"],
    extensionMarkers: ["anthropic", "claude"],
  },
  {
    id: "cursor-agent",
    name: "Cursor",
    vendor: "Cursor Inc",
    category: "cli-agent",
    defaultSanction: "SANCTIONED",
    binaries: ["cursor", "cursor-agent"],
    appNames: ["Cursor", "Cursor.app"],
    extensionMarkers: ["cursor"],
  },
  {
    id: "codex",
    name: "Codex CLI",
    vendor: "OpenAI",
    category: "cli-agent",
    defaultSanction: "SANCTIONED",
    binaries: ["codex"],
    appNames: ["Codex"],
    extensionMarkers: ["codex"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    category: "cli-agent",
    defaultSanction: "SANCTIONED",
    binaries: ["gemini"],
    appNames: ["Gemini"],
    extensionMarkers: ["gemini"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "OpenCode",
    category: "cli-agent",
    defaultSanction: "SANCTIONED",
    binaries: ["opencode"],
    appNames: ["OpenCode"],
    extensionMarkers: ["opencode"],
  },
  {
    id: "kyo",
    name: "Kyo",
    vendor: "Kyo",
    category: "cli-agent",
    defaultSanction: "REVIEW",
    binaries: ["kyo"],
    appNames: ["Kyo"],
    extensionMarkers: ["kyo"],
  },
  {
    id: "aider",
    name: "Aider",
    vendor: "Aider",
    category: "cli-agent",
    defaultSanction: "SANCTIONED",
    binaries: ["aider"],
    appNames: ["Aider"],
    extensionMarkers: ["aider"],
  },
  {
    id: "ollama",
    name: "Ollama",
    vendor: "Ollama",
    category: "model-runtime",
    defaultSanction: "SANCTIONED",
    binaries: ["ollama"],
    appNames: ["Ollama"],
    extensionMarkers: ["ollama"],
    defaultPorts: [11434],
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    vendor: "LM Studio",
    category: "model-runtime",
    defaultSanction: "SANCTIONED",
    binaries: ["lmstudio", "lm-studio"],
    appNames: ["LM Studio", "LMStudio"],
    extensionMarkers: ["lmstudio"],
    defaultPorts: [1234],
  },
  {
    id: "llama-server",
    name: "llama.cpp server",
    vendor: "llama.cpp",
    category: "model-runtime",
    defaultSanction: "REVIEW",
    binaries: ["llama-server", "llama-server.exe"],
    appNames: ["llama-server"],
    extensionMarkers: ["llama"],
  },
  {
    id: "mcpserver",
    name: "Generic MCP server",
    vendor: "unknown",
    category: "mcp-server",
    defaultSanction: "REVIEW",
    binaries: ["mcpserver"],
    extensionMarkers: ["mcp"],
  },
] as const;

export interface CatalogEntryWithId extends CatalogEntry {
  readonly id: string;
  readonly binaries: readonly string[];
  readonly appNames: readonly string[];
  readonly extensionMarkers: readonly string[];
  readonly defaultPorts: readonly number[];
}

const ENTRIES: ReadonlyMap<string, CatalogEntryWithId> = (() => {
  const map = new Map<string, CatalogEntryWithId>();
  for (const def of CATALOG_DEFS) {
    map.set(def.id, {
      id: def.id,
      name: def.name,
      vendor: def.vendor,
      category: def.category,
      defaultSanction: def.defaultSanction,
      binaries: def.binaries ?? [],
      appNames: def.appNames ?? [],
      extensionMarkers: def.extensionMarkers ?? [],
      defaultPorts: def.defaultPorts ?? [],
    });
  }
  return map;
})();

/** Read-only catalog of tools the discovery scanner knows about. */
export function discoveryCatalog(): ReadonlyMap<string, CatalogEntryWithId> {
  return ENTRIES;
}

export function lookupDiscoveryId(id: string): CatalogEntryWithId | undefined {
  return ENTRIES.get(id);
}

/** All binary names across the catalog, useful for PATH scanning. */
export function knownDiscoveryBinaries(): ReadonlySet<string> {
  const set = new Set<string>();
  for (const entry of ENTRIES.values()) {
    for (const b of entry.binaries) set.add(b);
  }
  return set;
}

export function knownDiscoveryVendors(): readonly string[] {
  const set = new Set<string>();
  for (const entry of ENTRIES.values()) {
    if (entry.vendor && entry.vendor !== "unknown") set.add(entry.vendor.toLowerCase());
    set.add(entry.id.toLowerCase());
    for (const m of entry.extensionMarkers) set.add(m.toLowerCase());
  }
  return [...set];
}
