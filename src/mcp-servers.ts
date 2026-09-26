/**
 * Registry of well-known third-party MCP servers for the offline evaluator
 * and the report's server facet. Advisory only: production authorization
 * stays with the control plane. Unknown server ids stay unknown — the
 * registry never guesses.
 */

export type McpToolTier = "READ" | "WRITE" | "ADMIN";

export interface McpToolRef {
  readonly server: string;
  readonly tool: string;
}

interface TierRule {
  readonly pattern: RegExp;
  readonly tier: McpToolTier;
}

interface McpServerEntry {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  /** Evaluated in order (ADMIN first); first match wins. */
  readonly rules: readonly TierRule[];
  /** Fallback when no rule matches. */
  readonly defaultTier: McpToolTier;
}

const r = (pattern: RegExp, tier: McpToolTier): TierRule => ({ pattern, tier });

const MCP_SERVERS: readonly McpServerEntry[] = [
  {
    id: "playwright",
    label: "Playwright",
    aliases: ["ms-playwright"],
    rules: [
      r(/^(?:browser_)?(?:file_upload|drag|hover|select_option|press_key|type|fill_form|click|navigate|navigate_back|navigate_forward|go_back|go_forward|tab_new|tab_close|tab_select|close|resize|run_code|evaluate|wait_for|handle_dialog|install)/, "WRITE"),
      r(/^(?:browser_)?(?:snapshot|take_screenshot|screenshot|console_messages|console|network_requests|tabs|pdf_save|generate_locator)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "github",
    label: "GitHub",
    aliases: [],
    rules: [
      r(/^(?:delete_|remove_|merge_|close_|dismiss_|revoke_|transfer_|archive_)/, "ADMIN"),
      r(/^(?:create|update|add|push|fork|request|assign|unassign|comment|review|submit|open|reopen|rename|enable|disable|set_|tag|label|star|follow|trigger|dispatch|run_|cancel_|rerun)/, "WRITE"),
      r(/^(?:get|list|search|find|read|resolve|fetch|check|describe|diff|compare|show|me$|notifications)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "context7",
    label: "Context7",
    aliases: [],
    rules: [r(/^/, "READ")],
    defaultTier: "READ",
  },
  {
    id: "filesystem",
    label: "Filesystem",
    aliases: ["fs"],
    rules: [
      r(/^(?:write_file|edit_file|create_directory|move_file|copy_file)/, "WRITE"),
      r(/^(?:read_|list_|search_|get_|directory_tree|find_)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "figma",
    label: "Figma",
    aliases: [],
    rules: [
      r(/^(?:delete_|remove_)/, "ADMIN"),
      r(/^(?:create|update|add|post|set_|rename|move|duplicate|insert|modify|apply)/, "WRITE"),
      r(/^(?:get|list|export|read|fetch|download)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "browser-use",
    label: "Browser Use",
    aliases: ["browseruse", "browser_use"],
    rules: [r(/^browser_(?:state|screenshot|console)/, "READ")],
    defaultTier: "WRITE",
  },
  {
    id: "chrome-devtools",
    label: "Chrome DevTools",
    aliases: ["chromedevtools", "chrome_devtools", "devtools"],
    rules: [
      r(/^(?:take_screenshot|take_snapshot|list_console_messages|get_console_message|list_network_requests|get_network_request|list_pages|list_scripts|read_)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "atlassian",
    label: "Atlassian",
    aliases: ["jira", "confluence"],
    rules: [
      r(/^(?:jira_delete|confluence_delete|.*_delete_)/, "ADMIN"),
      r(/^(?:jira_(?:create|update|add|transition|assign|link|unlink|remove|attach|edit|move|watch)|confluence_(?:create|update|add|link|unlink|remove|attach|edit|move|watch)|.*_(?:create|update|add|transition|assign|link|unlink|remove|attach|edit|move|watch)_)/, "WRITE"),
      r(/^(?:jira_(?:get|search)|confluence_(?:get|search)|atlassian|.*_(?:get|search)_)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "notion",
    label: "Notion",
    aliases: [],
    rules: [
      r(/^(?:delete_|remove_|archive_|trash_)/, "ADMIN"),
      r(/^(?:create|update|add|post|append|insert|move|duplicate|rename|set_|comment|upload)/, "WRITE"),
      r(/^(?:get|list|search|query|read|fetch|retrieve|find)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "slack",
    label: "Slack",
    aliases: [],
    rules: [
      r(/^(?:delete_|remove_|archive_|kick_|leave_)/, "ADMIN"),
      r(/^(?:post|send|create|update|add|reply|react|pin|unpin|invite|upload|share|set_|rename|join)/, "WRITE"),
      r(/^(?:get|list|search|read|fetch|history|find|lookup)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "supabase",
    label: "Supabase",
    aliases: [],
    rules: [
      r(/^(?:delete|drop|truncate|reset|purge|revoke|destroy|disable_)/, "ADMIN"),
      r(/^(?:create|update|insert|upsert|apply|deploy|execute|run|grant|enable|alter|migrate|set_|invoke|call|upload|generate|branch|pause|restore)/, "WRITE"),
      r(/^(?:get|list|search|read|fetch|describe|select|inspect|check)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "postgresql",
    label: "PostgreSQL",
    aliases: ["postgres"],
    rules: [
      r(/(?:drop|truncate|purge)/, "ADMIN"),
      r(/^(?:execute|query|run|write|exec|apply|insert|update|delete|alter|create)/, "WRITE"),
      r(/^(?:get|list|describe|read|select|inspect|schema|explain)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    aliases: [],
    rules: [r(/^(?:firecrawl_)?(?:scrape|crawl|map|search|extract|batch_scrape|deep_research|generate_llmstxt)/, "READ")],
    defaultTier: "WRITE",
  },
  {
    id: "sequential-thinking",
    label: "Sequential Thinking",
    aliases: ["sequentialthinking", "sequential_thinking"],
    rules: [r(/^/, "READ")],
    defaultTier: "READ",
  },
  {
    id: "n8n",
    label: "n8n",
    aliases: [],
    rules: [
      r(/^(?:delete_|remove_|purge_)/, "ADMIN"),
      r(/^(?:create|update|add|run|trigger|execute|activate|deactivate|publish|deploy|set_|stop|test_)/, "WRITE"),
      r(/^(?:get|list|search|read|fetch|describe|validate)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "linear",
    label: "Linear",
    aliases: [],
    rules: [
      r(/^(?:delete_|remove_|archive_)/, "ADMIN"),
      r(/^(?:create|update|add|assign|comment|move|rename|set_|attach)/, "WRITE"),
      r(/^(?:get|list|search|read|fetch|find|query)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "serena",
    label: "Serena",
    aliases: [],
    rules: [
      r(/^(?:delete|remove)/, "ADMIN"),
      r(/^(?:create|write|edit|replace|insert|rename|apply|execute|run|move|activate|onboarding|think|prepare|restart|summarize_changes)/, "WRITE"),
      r(/^(?:read|get|list|search|find|check|initial|think_about|describe|overview)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "sentry",
    label: "Sentry",
    aliases: [],
    rules: [
      r(/^(?:delete_|remove_|purge_)/, "ADMIN"),
      r(/^(?:create|update|resolve|assign|ignore|mute|unmute|archive|merge|reprocess|set_|comment|add|trigger)/, "WRITE"),
      r(/^(?:get|list|search|find|read|fetch|describe|whoami)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "zapier",
    label: "Zapier",
    aliases: [],
    rules: [
      r(/^(?:delete_|remove_|disable_|turn_off)/, "ADMIN"),
      r(/^(?:trigger|run|execute|create|update|add|enable|turn_on|invoke|perform|send|test_)/, "WRITE"),
      r(/^(?:get|list|search|read|fetch|describe|find)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
  {
    id: "exa",
    label: "Web Search",
    aliases: ["brave", "brave-search", "fetch"],
    rules: [
      r(/^(?:web_search|brave_(?:web|local)_search|fetch|search|crawl|scrape|extract|map|get_content)/, "READ"),
    ],
    defaultTier: "WRITE",
  },
];

const LOOKUP: ReadonlyMap<string, McpServerEntry> = (() => {
  const map = new Map<string, McpServerEntry>();
  for (const entry of MCP_SERVERS) {
    map.set(normalizeId(entry.id), entry);
    for (const alias of entry.aliases) map.set(normalizeId(alias), entry);
  }
  return map;
})();

function normalizeId(s: string): string {
  return s.trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Recognize a tool id as an MCP-server call. Handles `mcp__<server>__<tool>`,
 * `<server>__<tool>`, `<server>.<tool>`, and `<server>/<tool>`; ids are
 * normalized case-insensitively with dashes folded to underscores, and common
 * aliases resolve to one canonical server (postgres → postgresql,
 * ms-playwright → playwright). Unknown servers return undefined.
 */
export function parseMcpToolId(toolId: string): McpToolRef | undefined {
  const raw = toolId.trim().toLowerCase();
  if (!raw) return undefined;
  const m = /^(?:mcp__)?([a-z0-9][a-z0-9_-]*?)(?:__|\.|\/)([a-z0-9][a-z0-9_-]*)$/.exec(raw);
  if (!m) return undefined;
  const entry = LOOKUP.get(normalizeId(m[1]!));
  if (!entry) return undefined;
  return { server: entry.id, tool: m[2]! };
}

export function mcpServerLabel(serverId: string): string {
  return LOOKUP.get(normalizeId(serverId))?.label ?? serverId;
}

/**
 * Advisory risk tier for one tool of a known MCP server: pattern families per
 * server, ADMIN first, then the server's default. Unknown server → undefined.
 */
export function mcpToolTier(serverId: string, toolName: string): McpToolTier | undefined {
  const entry = LOOKUP.get(normalizeId(serverId));
  if (!entry) return undefined;
  const tool = toolName.trim().toLowerCase();
  for (const rule of entry.rules) {
    if (rule.pattern.test(tool)) return rule.tier;
  }
  return entry.defaultTier;
}
