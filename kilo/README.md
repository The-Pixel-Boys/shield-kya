# Kilo Code CLI + Shield KYA

Auto-wire: `kya connect kilo` (global `~/.config/kilo/kilo.json`) or `kya connect kilo --project` (`./kilo.json`).

Manual: merge `kilo.example.json` into your config (Kilo uses the `mcp` key with `type: "local"` + a command array, same shape as OpenCode).

Verify with `kilo mcp list` — shield-kya should show three tools.

Full recipe: [docs/hosts/kilo.md](../docs/hosts/kilo.md)
