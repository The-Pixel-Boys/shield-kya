# Droid (Factory) + Shield KYA

Preferred path is Droid's own CLI: `droid mcp add shield-kya "npx --no-install @shield-agent/kya@0.1.36 serve-mcp --stdio" --env KYA_BASE_URL=https://shield-agent.com --env KYA_API_KEY=$KYA_API_KEY --env KYA_HOST=ide`.

`mcp.example.json` shows the expected on-disk shape (`~/.factory/mcp.json`) — **schema not yet verified against a live Droid install**; treat as a starting point and prefer `droid mcp add`.

Verify from the `/mcp` manager — shield-kya should be listed.

Full recipe: [docs/hosts/droid.md](../docs/hosts/droid.md)
