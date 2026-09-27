# Top-20 MCP servers — recognition & gate recipes

kya ships a registry of the 20 most common third-party MCP servers
(`src/mcp-servers.ts`). It does two things with them:

1. **Recognition.** Tool ids like `mcp__github__create_issue`,
   `github.create_issue`, or `postgres/query` resolve to a canonical server
   (aliases fold in: `postgres` → `postgresql`, `ms-playwright` →
   `playwright`, `brave`/`fetch` → `exa`). Recognized calls get the server's
   display label in the receipt report's Servers facet, and each tool gets an
   advisory risk tier — **READ**, **WRITE**, or **ADMIN** — from per-server
   name-pattern families (evaluated ADMIN first; first match wins; unmatched
   tools fall back to the server's default tier). Unknown servers stay
   unknown: the registry never guesses.

2. **Gateway policy.** `kya gate run` generates the local gateway's
   authorization rules from the same registry — never hand-written:
   - tool names matching the destructive family
     (`drop`/`truncate`/`purge`/`transfer`, word-boundary anchored so
     `dropdown_select` is untouched) are **denied on every server**, registry
     or not, and filtered from `tools/list`;
   - the server's ADMIN-tier patterns join the deny set;
   - everything else is allowed — READ and WRITE both run (observe mode:
     allowed calls are audited into the trail/report, not blocked).

Tiers are advisory. Production authorization stays with the control plane
(`kya.policy_evaluate`); the gate is a local observe gateway with a hard
destructive/ADMIN deny on top.

## Gateway recipes

`kya gate init` scaffolds `.kya/gateways.json` with an empty `servers` list
plus a `recipes` catalog containing every entry below. To enable a server,
**move its recipe object into `servers`** and fill the `<…>` placeholders
(your own install, tokens, connection strings). Two transports:

- `stdio` — the gateway spawns the command (`cmd`, optional `env`);
- `http` — the gateway proxies to a remote MCP URL (`url`, optional
  `headers`; auth travels as headers — http targets have no `env`).

Entries marked **recipe** need something only you have (a token, an OAuth
login, a connection string, or a local install) before they work.

---

## Playwright (`playwright`)

Browser automation. Aliases: `ms-playwright`.

- **Recognition:** interaction tools tier **WRITE** (`click`, `navigate`,
  `type`, `fill_form`, `file_upload`, `drag`, `evaluate`, `run_code`,
  `handle_dialog`, `install`, tab/resize/wait families — with or without the
  `browser_` prefix); inspection tools tier **READ** (`snapshot`,
  `take_screenshot`, `console_messages`, `network_requests`, `tabs`,
  `pdf_save`, `generate_locator`). Default: WRITE. No ADMIN patterns —
  the destructive-name deny only.
- **Recipe (stdio):**

```json
{ "id": "playwright", "transport": "stdio", "cmd": ["npx", "-y", "@playwright/mcp@latest"] }
```

## GitHub (`github`)

- **Recognition:** **ADMIN** for `delete_`/`remove_`/`merge_`/`close_`/
  `dismiss_`/`revoke_`/`transfer_`/`archive_` prefixes; **WRITE** for
  create/update/add/push/fork/request/assign/comment/review/submit/open/
  reopen/rename/enable/disable/`set_`/tag/label/star/follow/trigger/dispatch/
  `run_`/`cancel_`/rerun; **READ** for get/list/search/find/read/resolve/
  fetch/check/describe/diff/compare/show/`me`/notifications. Default: WRITE.
- **Recipe (http)** — needs your own PAT:

```json
{ "id": "github", "transport": "http", "url": "https://api.githubcopilot.com/mcp/",
  "headers": { "authorization": "Bearer <github-pat>" } }
```

## Context7 (`context7`)

Library docs lookup.

- **Recognition:** every tool tiers **READ** (catch-all rule; default READ).
  Read-only server — the destructive-name deny still applies.
- **Recipe (http):**

```json
{ "id": "context7", "transport": "http", "url": "https://mcp.context7.com/mcp" }
```

## Filesystem (`filesystem`)

Local file access. Aliases: `fs`.

- **Recognition:** **WRITE** for `write_file`, `edit_file`,
  `create_directory`, `move_file`, `copy_file`; **READ** for `read_`/`list_`/
  `search_`/`get_`/`directory_tree`/`find_` prefixes. Default: WRITE. No
  ADMIN patterns.
- **Recipe (stdio)** — scope is the path args:

```json
{ "id": "filesystem", "transport": "stdio",
  "cmd": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] }
```

## Figma (`figma`)

- **Recognition:** **ADMIN** for `delete_`/`remove_`; **WRITE** for create/
  update/add/post/`set_`/rename/move/duplicate/insert/modify/apply; **READ**
  for get/list/export/read/fetch/download. Default: WRITE.
- **Recipe (http):**

```json
{ "id": "figma", "transport": "http", "url": "https://mcp.figma.com/mcp" }
```

## Browser Use (`browser-use`)

Browser agent. Aliases: `browseruse`, `browser_use`.

- **Recognition:** **READ** for `browser_state`, `browser_screenshot`,
  `browser_console`; everything else defaults to **WRITE** (the agent acts
  on the page). No ADMIN patterns.
- **Recipe (stdio)** — needs Python/`uvx` on PATH:

```json
{ "id": "browser-use", "transport": "stdio", "cmd": ["uvx", "browser-use", "--mcp"] }
```

## Chrome DevTools (`chrome-devtools`)

Aliases: `chromedevtools`, `chrome_devtools`, `devtools`.

- **Recognition:** **READ** for `take_screenshot`, `take_snapshot`,
  `list_console_messages`, `get_console_message`, `list_network_requests`,
  `get_network_request`, `list_pages`, `list_scripts`, `read_` prefixes;
  everything else defaults to **WRITE** (it drives a real browser). No ADMIN
  patterns.
- **Recipe (stdio):**

```json
{ "id": "chrome-devtools", "transport": "stdio", "cmd": ["npx", "-y", "chrome-devtools-mcp@latest"] }
```

## Atlassian (`atlassian`)

Jira + Confluence. Aliases: `jira`, `confluence`.

- **Recognition:** **ADMIN** for `jira_delete`/`confluence_delete` and any
  `*_delete_*` name; **WRITE** for the create/update/add/transition/assign/
  link/unlink/remove/attach/edit/move/watch families (jira, confluence, or
  generic `*_<verb>_` shapes); **READ** for `jira_get`/`jira_search`,
  `confluence_get`/`confluence_search`, `atlassian…`, and generic
  `*_get_`/`*_search_` shapes. Default: WRITE.
- **Recipe (http)** — remote, OAuth sign-in on first use:

```json
{ "id": "atlassian", "transport": "http", "url": "https://mcp.atlassian.com/v1/sse" }
```

## Notion (`notion`)

- **Recognition:** **ADMIN** for `delete_`/`remove_`/`archive_`/`trash_`;
  **WRITE** for create/update/add/post/append/insert/move/duplicate/rename/
  `set_`/comment/upload; **READ** for get/list/search/query/read/fetch/
  retrieve/find. Default: WRITE.
- **Recipe (http):**

```json
{ "id": "notion", "transport": "http", "url": "https://mcp.notion.com/mcp" }
```

## Slack (`slack`)

- **Recognition:** **ADMIN** for `delete_`/`remove_`/`archive_`/`kick_`/
  `leave_`; **WRITE** for post/send/create/update/add/reply/react/pin/unpin/
  invite/upload/share/`set_`/rename/join; **READ** for get/list/search/read/
  fetch/history/find/lookup. Default: WRITE.
- **Recipe (stdio)** — needs your own bot token + team id:

```json
{ "id": "slack", "transport": "stdio",
  "cmd": ["npx", "-y", "@modelcontextprotocol/server-slack"],
  "env": { "SLACK_BOT_TOKEN": "<xoxb-…>", "SLACK_TEAM_ID": "<T…>" } }
```

## Supabase (`supabase`)

- **Recognition:** **ADMIN** for delete/drop/truncate/reset/purge/revoke/
  destroy/`disable_` prefixes; **WRITE** for create/update/insert/upsert/
  apply/deploy/execute/run/grant/enable/alter/migrate/`set_`/invoke/call/
  upload/generate/branch/pause/restore; **READ** for get/list/search/read/
  fetch/describe/select/inspect/check. Default: WRITE.
- **Recipe (stdio)** — needs your own access token:

```json
{ "id": "supabase", "transport": "stdio",
  "cmd": ["npx", "-y", "@supabase/mcp-server-supabase@latest"],
  "env": { "SUPABASE_ACCESS_TOKEN": "<sbp_…>" } }
```

## PostgreSQL (`postgresql`)

Aliases: `postgres`.

- **Recognition:** **ADMIN** for any tool name containing `drop`, `truncate`,
  or `purge` (substring match, not just prefixes — `replicate_drop_slot`
  counts); **WRITE** for execute/query/run/write/exec/apply/insert/update/
  delete/alter/create prefixes; **READ** for get/list/describe/read/select/
  inspect/schema/explain. Default: WRITE. Note the popular community
  postgres servers expose a single catch-all `query` tool — it tiers WRITE,
  so statement-level control stays with the control plane, not the gate.
- **Recipe (stdio)** — pass your own connection string as the last arg:

```json
{ "id": "postgresql", "transport": "stdio",
  "cmd": ["npx", "-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"] }
```

## Firecrawl (`firecrawl`)

Web scraping.

- **Recognition:** **READ** for `scrape`, `crawl`, `map`, `search`,
  `extract`, `batch_scrape`, `deep_research`, `generate_llmstxt` (with or
  without the `firecrawl_` prefix). Default: WRITE. No ADMIN patterns —
  effectively a read-only fetch server under the gate.
- **Recipe (stdio)** — needs your own API key:

```json
{ "id": "firecrawl", "transport": "stdio", "cmd": ["npx", "-y", "firecrawl-mcp"],
  "env": { "FIRECRAWL_API_KEY": "<fc-…>" } }
```

## Sequential Thinking (`sequential-thinking`)

Reasoning scratchpad. Aliases: `sequentialthinking`, `sequential_thinking`.

- **Recognition:** every tool tiers **READ** (catch-all rule; default READ).
  Read-only server.
- **Recipe (stdio):**

```json
{ "id": "sequential-thinking", "transport": "stdio",
  "cmd": ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"] }
```

## n8n (`n8n`)

Workflow automation.

- **Recognition:** **ADMIN** for `delete_`/`remove_`/`purge_`; **WRITE** for
  create/update/add/run/trigger/execute/activate/deactivate/publish/deploy/
  `set_`/stop/`test_`; **READ** for get/list/search/read/fetch/describe/
  validate. Default: WRITE.
- **Recipe (stdio):**

```json
{ "id": "n8n", "transport": "stdio", "cmd": ["npx", "-y", "n8n-mcp"] }
```

## Linear (`linear`)

- **Recognition:** **ADMIN** for `delete_`/`remove_`/`archive_`; **WRITE**
  for create/update/add/assign/comment/move/rename/`set_`/attach; **READ**
  for get/list/search/read/fetch/find/query. Default: WRITE.
- **Recipe (http)** — remote, OAuth sign-in on first use:

```json
{ "id": "linear", "transport": "http", "url": "https://mcp.linear.app/sse" }
```

## Serena (`serena`)

Code navigation/editing.

- **Recognition:** **ADMIN** for `delete`/`remove` prefixes; **WRITE** for
  create/write/edit/replace/insert/rename/apply/execute/run/move/activate/
  onboarding/think/prepare/restart/`summarize_changes`; **READ** for read/
  get/list/search/find/check/initial/`think_about`/describe/overview.
  Default: WRITE.
- **Recipe (stdio)** — needs Python/`uvx` on PATH:

```json
{ "id": "serena", "transport": "stdio",
  "cmd": ["uvx", "--from", "git+https://github.com/oraios/serena", "serena-mcp-server"] }
```

## Sentry (`sentry`)

- **Recognition:** **ADMIN** for `delete_`/`remove_`/`purge_`; **WRITE** for
  create/update/resolve/assign/ignore/mute/unmute/archive/merge/reprocess/
  `set_`/comment/add/trigger; **READ** for get/list/search/find/read/fetch/
  describe/whoami. Default: WRITE.
- **Recipe (http)** — remote, OAuth sign-in on first use:

```json
{ "id": "sentry", "transport": "http", "url": "https://mcp.sentry.dev/mcp" }
```

## Zapier (`zapier`)

- **Recognition:** **ADMIN** for `delete_`/`remove_`/`disable_`/`turn_off`;
  **WRITE** for trigger/run/execute/create/update/add/enable/turn_on/invoke/
  perform/send/`test_`; **READ** for get/list/search/read/fetch/describe/
  find. Default: WRITE.
- **Recipe (http)** — use your own Zapier MCP URL:

```json
{ "id": "zapier", "transport": "http", "url": "https://mcp.zapier.com/api/mcp/mcp" }
```

## Web Search (`exa`)

Exa, Brave Search, and plain fetch fold into one canonical server. Aliases:
`brave`, `brave-search`, `fetch`.

- **Recognition:** **READ** for `web_search`, `brave_web_search`,
  `brave_local_search`, `fetch`, `search`, `crawl`, `scrape`, `extract`,
  `map`, `get_content`. Default: WRITE. No ADMIN patterns — effectively
  read-only under the gate.
- **Recipe (http):**

```json
{ "id": "exa", "transport": "http", "url": "https://mcp.exa.ai/mcp" }
```

For Brave or fetch instead, add a stdio entry of your own (e.g.
`["npx", "-y", "@modelcontextprotocol/server-brave-search"]` with
`BRAVE_API_KEY`, or `["uvx", "mcp-server-fetch"]`) — the alias ids `brave`
and `fetch` resolve to the same recognition rules as long as the entry `id`
matches one of the aliases.

---

## Not on the list?

Any MCP server works through the gate without a registry entry: unknown
servers get the destructive-name deny and observe-mode auditing, and their
calls appear on the trail under their raw tool id — they just don't get the
canonical label, the Servers facet rollup, or per-tool tiers. The taxonomy
is advisory and open — PRs for new servers and sharper patterns are welcome.
