# Cline + Shield KYA

No safe auto-wire: Cline's config lives in VS Code globalStorage (`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` on macOS; analogous paths on Linux/Windows).

Recommended: open Cline → MCP Servers icon → Configure, and paste the `shield-kya` block from `cline_mcp_settings.example.json`. Cline hot-reloads on save.

Leave `autoApprove` empty — approvals are KYA's job.

Full recipe: [docs/hosts/cline.md](../docs/hosts/cline.md)
