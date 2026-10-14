/**
 * Well-known coding-agent tool vocabulary for the offline evaluator.
 * Advisory only: production authorization stays with the control plane.
 */

export type HostToolTier = "READ" | "WRITE" | "SHELL";

const HOST_TOOLS: Readonly<Record<string, HostToolTier>> = {
  // reads (claude / kimi / grok names)
  read: "READ", readmediafile: "READ", grep: "READ", glob: "READ", ls: "READ",
  listdir: "READ", list_dir: "READ", read_file: "READ", websearch: "READ",
  webfetch: "READ", fetchurl: "READ", web_search: "READ", notebookread: "READ",
  // reads (gemini cli names)
  read_many_files: "READ", list_directory: "READ", search_file_content: "READ", grep_search: "READ",
  web_fetch: "READ", google_web_search: "READ",
  // writes
  edit: "WRITE", multiedit: "WRITE", write: "WRITE", notebookedit: "WRITE",
  search_replace: "WRITE", strreplace: "WRITE",
  write_file: "WRITE", replace: "WRITE", // gemini cli
  apply_patch: "WRITE", // codex
  // shell / exec
  bash: "SHELL", run_terminal_command: "SHELL", run_shell_command: "SHELL",
};

/** Lookup is case-insensitive; only `__`-qualified names (mcp__*, server__tool) stay unknown - a bare `read_file` from an MCP filesystem server still matches READ, which is deliberate: reads are reads in this advisory vocabulary. */
export function findHostToolTier(toolId: string): HostToolTier | undefined {
  const id = toolId.trim().toLowerCase();
  if (!id || id.includes("__")) return undefined;
  return HOST_TOOLS[id];
}
