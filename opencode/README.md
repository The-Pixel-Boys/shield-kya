# OpenCode + Shield KYA

Auto-wire: `kya connect opencode` (global `~/.config/opencode/opencode.json`) or `kya connect opencode --project` (`./opencode.json`).

Manual: merge `opencode.example.json` into your config (OpenCode uses the `mcp` key with `type: "local"` + a command array).

Restart OpenCode, then ask it to list MCP tools — `kya.policy_evaluate`, `kya.session_ingest`, `kya.request_approval` should appear.

Full recipe: [docs/hosts/opencode.md](../docs/hosts/opencode.md)
