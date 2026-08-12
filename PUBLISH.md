# Publish `@shield-agent/kya`

## Works now (no npm)

```bash
npx --yes github:The-Pixel-Boys/shield-kya --help
npx --yes -p github:The-Pixel-Boys/shield-kya kya eval-tool --offline --tool-id org.sample.never.event --irreversible
```

## npm (requires secret)

1. Create npm Automation token with publish rights to `@shield-agent`.
2. `gh secret set NPM_TOKEN --repo The-Pixel-Boys/shield-kya`
   (also set on monorepo `The-Pixel-Boys/shield-agent` if using monorepo release workflow)
3. Tag: `git tag v0.1.0 && git push origin v0.1.0`
   or Actions → **release-npm** → dry_run=`false`
4. Verify: `npx @shield-agent/kya@latest --help`
5. Submit MCP Registry with `server.json` + `mcpName` (`io.github.the-pixel-boys/shield-kya`)

Package is MIT. Sole PEP remains Shield KYA; offline evaluate is sample only.
