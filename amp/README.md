# Amp + Shield KYA

Auto-wire: `kya connect amp` (global `~/.config/amp/settings.json`; `%APPDATA%\amp\settings.json` on Windows).

Manual: merge `settings.example.json` into your settings — note Amp's prefixed root key `amp.mcpServers`, not bare `mcpServers`.

Restart Amp and ask it to list MCP tools — the three `kya.*` tools should appear.

Full recipe: [docs/hosts/amp.md](../docs/hosts/amp.md)
