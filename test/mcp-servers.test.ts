import { describe, expect, it } from "vitest";
import { mcpServerLabel, mcpToolTier, parseMcpToolId } from "../src/mcp-servers.js";

describe("parseMcpToolId", () => {
  it("parses mcp__<server>__<tool>", () => {
    expect(parseMcpToolId("mcp__github__get_issue")).toEqual({ server: "github", tool: "get_issue" });
    expect(parseMcpToolId("mcp__mcp-server-time__get_current_time")).toBeUndefined();
  });

  it("parses <server>__<tool>", () => {
    expect(parseMcpToolId("playwright__browser_navigate")).toEqual({
      server: "playwright",
      tool: "browser_navigate",
    });
  });

  it("parses <server>.<tool> and <server>/<tool>", () => {
    expect(parseMcpToolId("github.search_repositories")).toEqual({
      server: "github",
      tool: "search_repositories",
    });
    expect(parseMcpToolId("linear/list_issues")).toEqual({ server: "linear", tool: "list_issues" });
  });

  it("normalizes case and dash/underscore variants", () => {
    expect(parseMcpToolId("MCP__GitHub__get_issue")?.server).toBe("github");
    expect(parseMcpToolId("chrome-devtools__take_snapshot")?.server).toBe("chrome-devtools");
    expect(parseMcpToolId("chromedevtools__take_snapshot")?.server).toBe("chrome-devtools");
    expect(parseMcpToolId("chrome_devtools.take_snapshot")?.server).toBe("chrome-devtools");
    expect(parseMcpToolId("browser-use__browser_navigate")?.server).toBe("browser-use");
    expect(parseMcpToolId("browseruse__browser_navigate")?.server).toBe("browser-use");
    expect(parseMcpToolId("sequential-thinking__sequentialthinking")?.server).toBe(
      "sequential-thinking",
    );
    expect(parseMcpToolId("sequentialthinking__sequentialthinking")?.server).toBe(
      "sequential-thinking",
    );
  });

  it("resolves aliases to the canonical server", () => {
    expect(parseMcpToolId("postgres__query")?.server).toBe("postgresql");
    expect(parseMcpToolId("ms-playwright__browser_click")?.server).toBe("playwright");
  });

  it("folds the three web-search ids into one server", () => {
    expect(parseMcpToolId("mcp__exa__web_search_exa")).toEqual({ server: "exa", tool: "web_search_exa" });
    expect(parseMcpToolId("brave__brave_web_search")?.server).toBe("exa");
    expect(parseMcpToolId("fetch__fetch")?.server).toBe("exa");
  });

  it("rejects unknown servers, bare names, and malformed ids", () => {
    expect(parseMcpToolId("mcp__acme-internal__do_thing")).toBeUndefined();
    expect(parseMcpToolId("acme__do_thing")).toBeUndefined();
    expect(parseMcpToolId("github")).toBeUndefined();
    expect(parseMcpToolId("read_file")).toBeUndefined();
    expect(parseMcpToolId("")).toBeUndefined();
    expect(parseMcpToolId("__no_server")).toBeUndefined();
  });

  it("rejects multi-segment dotted/slashed tool names but keeps single separators", () => {
    expect(parseMcpToolId("github.get_repo")).toEqual({ server: "github", tool: "get_repo" });
    expect(parseMcpToolId("github.get_repo.stuff")).toBeUndefined();
    expect(parseMcpToolId("filesystem.read_many.files")).toBeUndefined();
    expect(parseMcpToolId("linear/list_issues")).toEqual({ server: "linear", tool: "list_issues" });
    expect(parseMcpToolId("linear/teams/list_issues")).toBeUndefined();
    expect(parseMcpToolId("mcp__github__get_issue")).toEqual({ server: "github", tool: "get_issue" });
  });
});

describe("mcpServerLabel", () => {
  it("returns display names", () => {
    expect(mcpServerLabel("playwright")).toBe("Playwright");
    expect(mcpServerLabel("github")).toBe("GitHub");
    expect(mcpServerLabel("context7")).toBe("Context7");
    expect(mcpServerLabel("filesystem")).toBe("Filesystem");
    expect(mcpServerLabel("figma")).toBe("Figma");
    expect(mcpServerLabel("browser-use")).toBe("Browser Use");
    expect(mcpServerLabel("chrome-devtools")).toBe("Chrome DevTools");
    expect(mcpServerLabel("atlassian")).toBe("Atlassian");
    expect(mcpServerLabel("notion")).toBe("Notion");
    expect(mcpServerLabel("slack")).toBe("Slack");
    expect(mcpServerLabel("supabase")).toBe("Supabase");
    expect(mcpServerLabel("postgresql")).toBe("PostgreSQL");
    expect(mcpServerLabel("firecrawl")).toBe("Firecrawl");
    expect(mcpServerLabel("sequential-thinking")).toBe("Sequential Thinking");
    expect(mcpServerLabel("n8n")).toBe("n8n");
    expect(mcpServerLabel("linear")).toBe("Linear");
    expect(mcpServerLabel("serena")).toBe("Serena");
    expect(mcpServerLabel("sentry")).toBe("Sentry");
    expect(mcpServerLabel("zapier")).toBe("Zapier");
    expect(mcpServerLabel("exa")).toBe("Web Search");
    expect(mcpServerLabel("brave")).toBe("Web Search");
    expect(mcpServerLabel("fetch")).toBe("Web Search");
  });

  it("passes through unknown ids", () => {
    expect(mcpServerLabel("acme-internal")).toBe("acme-internal");
  });
});

describe("mcpToolTier", () => {
  it("playwright: navigation and interaction WRITE, snapshot/screenshot READ", () => {
    expect(mcpToolTier("playwright", "browser_navigate")).toBe("WRITE");
    expect(mcpToolTier("playwright", "browser_click")).toBe("WRITE");
    expect(mcpToolTier("playwright", "browser_type")).toBe("WRITE");
    expect(mcpToolTier("playwright", "browser_snapshot")).toBe("READ");
    expect(mcpToolTier("playwright", "browser_take_screenshot")).toBe("READ");
    expect(mcpToolTier("playwright", "browser_console_messages")).toBe("READ");
  });

  it("github: getters READ, mutations WRITE, merge/delete ADMIN", () => {
    expect(mcpToolTier("github", "get_issue")).toBe("READ");
    expect(mcpToolTier("github", "list_pull_requests")).toBe("READ");
    expect(mcpToolTier("github", "search_code")).toBe("READ");
    expect(mcpToolTier("github", "create_issue")).toBe("WRITE");
    expect(mcpToolTier("github", "add_issue_comment")).toBe("WRITE");
    expect(mcpToolTier("github", "merge_pull_request")).toBe("ADMIN");
    expect(mcpToolTier("github", "delete_branch")).toBe("ADMIN");
  });

  it("context7 and sequential-thinking are all READ", () => {
    expect(mcpToolTier("context7", "resolve-library-id")).toBe("READ");
    expect(mcpToolTier("context7", "get-library-docs")).toBe("READ");
    expect(mcpToolTier("sequential-thinking", "sequentialthinking")).toBe("READ");
  });

  it("filesystem splits reads from writes, unknown tools default WRITE", () => {
    expect(mcpToolTier("filesystem", "read_file")).toBe("READ");
    expect(mcpToolTier("filesystem", "list_directory")).toBe("READ");
    expect(mcpToolTier("filesystem", "write_file")).toBe("WRITE");
    expect(mcpToolTier("filesystem", "move_file")).toBe("WRITE");
    expect(mcpToolTier("filesystem", "edit_many_files")).toBe("WRITE");
  });

  it("figma: reads vs node mutations", () => {
    expect(mcpToolTier("figma", "get_file")).toBe("READ");
    expect(mcpToolTier("figma", "export_assets")).toBe("READ");
    expect(mcpToolTier("figma", "post_comment")).toBe("WRITE");
  });

  it("browser-use and chrome-devtools: interaction WRITE, observation READ", () => {
    expect(mcpToolTier("browser-use", "browser_navigate")).toBe("WRITE");
    expect(mcpToolTier("browser-use", "browser_click")).toBe("WRITE");
    expect(mcpToolTier("browser-use", "browser_state")).toBe("READ");
    expect(mcpToolTier("chrome-devtools", "click")).toBe("WRITE");
    expect(mcpToolTier("chrome-devtools", "navigate_page")).toBe("WRITE");
    expect(mcpToolTier("chrome-devtools", "take_screenshot")).toBe("READ");
    expect(mcpToolTier("chrome-devtools", "list_console_messages")).toBe("READ");
  });

  it("atlassian: jira/confluence reads vs writes vs deletes", () => {
    expect(mcpToolTier("atlassian", "jira_get_issue")).toBe("READ");
    expect(mcpToolTier("atlassian", "confluence_search")).toBe("READ");
    expect(mcpToolTier("atlassian", "jira_create_issue")).toBe("WRITE");
    expect(mcpToolTier("atlassian", "jira_transition_issue")).toBe("WRITE");
    expect(mcpToolTier("atlassian", "jira_delete_issue")).toBe("ADMIN");
  });

  it("atlassian: link/remove mutations are WRITE and unknown tools default WRITE", () => {
    expect(mcpToolTier("atlassian", "jira_link_to_epic")).toBe("WRITE");
    expect(mcpToolTier("atlassian", "jira_remove_issue_link")).toBe("WRITE");
    expect(mcpToolTier("atlassian", "jira_edit_issue")).toBe("WRITE");
    expect(mcpToolTier("atlassian", "some_unrecognized_tool")).toBe("WRITE");
  });

  it("notion: search/query READ, page edits WRITE, archive ADMIN", () => {
    expect(mcpToolTier("notion", "search_pages")).toBe("READ");
    expect(mcpToolTier("notion", "query_database")).toBe("READ");
    expect(mcpToolTier("notion", "create_page")).toBe("WRITE");
    expect(mcpToolTier("notion", "append_block_children")).toBe("WRITE");
    expect(mcpToolTier("notion", "delete_block")).toBe("ADMIN");
  });

  it("slack: reads READ, posts WRITE, destructive channel ops ADMIN", () => {
    expect(mcpToolTier("slack", "list_channels")).toBe("READ");
    expect(mcpToolTier("slack", "search_messages")).toBe("READ");
    expect(mcpToolTier("slack", "post_message")).toBe("WRITE");
    expect(mcpToolTier("slack", "reply_to_thread")).toBe("WRITE");
    expect(mcpToolTier("slack", "delete_message")).toBe("ADMIN");
  });

  it("supabase: list/get READ, apply/execute WRITE, destructive ADMIN", () => {
    expect(mcpToolTier("supabase", "list_tables")).toBe("READ");
    expect(mcpToolTier("supabase", "get_project")).toBe("READ");
    expect(mcpToolTier("supabase", "apply_migration")).toBe("WRITE");
    expect(mcpToolTier("supabase", "execute_sql")).toBe("WRITE");
    expect(mcpToolTier("supabase", "delete_project")).toBe("ADMIN");
  });

  it("postgresql: read-only query vs write/exec vs drop/truncate", () => {
    expect(mcpToolTier("postgresql", "list_schemas")).toBe("READ");
    expect(mcpToolTier("postgresql", "describe_table")).toBe("READ");
    expect(mcpToolTier("postgresql", "execute_sql")).toBe("WRITE");
    expect(mcpToolTier("postgresql", "query")).toBe("WRITE");
    expect(mcpToolTier("postgresql", "drop_table")).toBe("ADMIN");
    expect(mcpToolTier("postgresql", "truncate_table")).toBe("ADMIN");
  });

  it("firecrawl is scrape-only READ", () => {
    expect(mcpToolTier("firecrawl", "firecrawl_scrape")).toBe("READ");
    expect(mcpToolTier("firecrawl", "firecrawl_crawl")).toBe("READ");
    expect(mcpToolTier("firecrawl", "firecrawl_search")).toBe("READ");
  });

  it("n8n: inspect READ, run/trigger WRITE, delete ADMIN", () => {
    expect(mcpToolTier("n8n", "list_workflows")).toBe("READ");
    expect(mcpToolTier("n8n", "get_workflow")).toBe("READ");
    expect(mcpToolTier("n8n", "trigger_webhook_workflow")).toBe("WRITE");
    expect(mcpToolTier("n8n", "run_workflow")).toBe("WRITE");
    expect(mcpToolTier("n8n", "delete_workflow")).toBe("ADMIN");
  });

  it("linear: getters READ, issue edits WRITE, delete ADMIN", () => {
    expect(mcpToolTier("linear", "list_issues")).toBe("READ");
    expect(mcpToolTier("linear", "get_issue")).toBe("READ");
    expect(mcpToolTier("linear", "create_issue")).toBe("WRITE");
    expect(mcpToolTier("linear", "update_issue")).toBe("WRITE");
    expect(mcpToolTier("linear", "delete_issue")).toBe("ADMIN");
  });

  it("serena: find/read READ, symbol edits WRITE, delete ADMIN", () => {
    expect(mcpToolTier("serena", "find_symbol")).toBe("READ");
    expect(mcpToolTier("serena", "read_file")).toBe("READ");
    expect(mcpToolTier("serena", "replace_symbol_body")).toBe("WRITE");
    expect(mcpToolTier("serena", "execute_shell_command")).toBe("WRITE");
    expect(mcpToolTier("serena", "delete_lines")).toBe("ADMIN");
  });

  it("sentry: issue reads READ, resolve/assign WRITE, seer analysis WRITE", () => {
    expect(mcpToolTier("sentry", "list_issues")).toBe("READ");
    expect(mcpToolTier("sentry", "get_issue_details")).toBe("READ");
    expect(mcpToolTier("sentry", "resolve_issue")).toBe("WRITE");
    expect(mcpToolTier("sentry", "update_issue")).toBe("WRITE");
    expect(mcpToolTier("sentry", "analyze_issue_with_seer")).toBe("WRITE");
  });

  it("zapier: discover READ, trigger/execute WRITE", () => {
    expect(mcpToolTier("zapier", "list_zaps")).toBe("READ");
    expect(mcpToolTier("zapier", "search_actions")).toBe("READ");
    expect(mcpToolTier("zapier", "trigger_zap")).toBe("WRITE");
    expect(mcpToolTier("zapier", "execute_action")).toBe("WRITE");
  });

  it("web search servers: documented read tools READ, anything else WRITE", () => {
    expect(mcpToolTier("exa", "web_search_exa")).toBe("READ");
    expect(mcpToolTier("brave", "brave_web_search")).toBe("READ");
    expect(mcpToolTier("fetch", "fetch")).toBe("READ");
    expect(mcpToolTier("fetch", "get_content")).toBe("READ");
    expect(mcpToolTier("fetch", "http_post")).toBe("WRITE");
    expect(mcpToolTier("exa", "some_unrecognized_tool")).toBe("WRITE");
  });

  it("firecrawl: documented reads READ, unknown tools default WRITE", () => {
    expect(mcpToolTier("firecrawl", "firecrawl_scrape")).toBe("READ");
    expect(mcpToolTier("firecrawl", "some_unrecognized_tool")).toBe("WRITE");
  });

  it("unknown server is undefined, never a guess", () => {
    expect(mcpToolTier("acme-internal", "get_thing")).toBeUndefined();
  });
});
