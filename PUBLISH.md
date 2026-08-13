# Publish `@shield-agent/kya`

## Live (npm)

```bash
npx @shield-agent/kya@latest --help
npx @shield-agent/kya@latest eval-tool --offline --tool-id org.sample.never.event --irreversible
npx @shield-agent/kya@latest dash --once --offline
```

Package: https://www.npmjs.com/package/@shield-agent/kya  
Install hub: https://shield-agent.com/install

## Re-publish

1. Bump `version` in `package.json` (+ `server.json` version fields).
2. Ensure `NPM_TOKEN` secret on this repo or monorepo.
3. Tag `vX.Y.Z` (this repo) or `kya-vX.Y.Z` (monorepo `sdks/kya` workflow).
4. Verify `npx @shield-agent/kya@latest --help`.
5. MCP Registry: submit `server.json` + package `mcpName`.

Offline evaluate is sample only. Sole PEP remains Shield KYA.
