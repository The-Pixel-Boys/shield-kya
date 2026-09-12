# MastraCode + Shield KYA

Auto-wire: `kya connect mastracode` (global `~/.mastracode/mcp.json`) or `kya connect mastracode --project` (`.mastracode/mcp.json`). MastraCode also reads `.mcp.json`, which `kya start` already wires.

Manual: merge `mcp.example.json` into your mcp.json (classic `mcpServers` shape).

Verify from the `/mcp` status panel — shield-kya should show three tools.

Full recipe: [docs/hosts/mastracode.md](../docs/hosts/mastracode.md)
