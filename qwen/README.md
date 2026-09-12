# Qwen Code + Shield KYA

Auto-wire: `kya connect qwen` (global `~/.qwen/settings.json`) or `kya connect qwen --project` (`.qwen/settings.json`).

Manual: merge `settings.example.json` (stdio) or `settings.hosted.example.json` (hosted HTTP via `httpUrl`) into your settings.

Verify with `qwen mcp list` — shield-kya should show three tools.

Full recipe: [docs/hosts/qwen.md](../docs/hosts/qwen.md)
