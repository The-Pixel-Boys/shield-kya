# Amp + Shield KYA

Auto-wire: `kya connect amp` (global `~/.config/amp/settings.json`; `%APPDATA%\amp\settings.json` on Windows).

Manual: merge `settings.example.json` into your settings — note Amp's prefixed root key `amp.mcpServers`, not bare `mcpServers`.

Amp applies the settings change live — ask it to list MCP tools and the three `kya.*` tools should appear, no restart.

Full recipe: [docs/hosts/amp.md](../docs/hosts/amp.md)
